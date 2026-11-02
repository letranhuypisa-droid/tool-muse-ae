import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import { bus } from "./events.js";
import { NotFoundError, ValidationError, newId } from "./util.js";

const UPLOAD_ERROR = "Chỉ nhận ảnh JPG, PNG hoặc WEBP, tối đa 20 MB, tối đa 9 ảnh";
const BUSY_ERROR = "Tài khoản đang chạy việc, thử lại sau";
const IMAGE_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

function isInside(child, parent) {
  const rel = path.relative(parent, path.resolve(child));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const toUrl = (prefix, root, file) => `${prefix}/${path.relative(root, file).split(path.sep).map(encodeURIComponent).join("/")}`;

function defaultOpenPath(target) {
  const args = fs.statSync(target).isDirectory() ? [target] : ["/select,", target];
  spawn("explorer", args, { detached: true, stdio: "ignore" }).unref();
}

export function createApp({ accounts, jobs, scheduler, driver, settings, paths, openPath = defaultOpenPath }) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const state = () => ({
    accounts: accounts.list().map((a) => ({ ...a, busy: scheduler.isBusy(a.id) })),
    jobs: jobs.list(),
    settings: settings.get(),
    scheduler: scheduler.status(),
  });

  const requireAccount = (id) => {
    const account = accounts.get(id);
    if (!account) throw new NotFoundError("Không tìm thấy tài khoản");
    return account;
  };

  const checkRefs = (refImages = []) => {
    if (!Array.isArray(refImages)) throw new ValidationError("Ảnh tham chiếu không hợp lệ");
    for (const ref of refImages) {
      if (typeof ref !== "string" || !isInside(ref, paths.uploads) || !fs.existsSync(ref)) {
        throw new ValidationError("Ảnh tham chiếu không hợp lệ, hãy tải ảnh lên lại");
      }
    }
  };

  const upload = multer({
    storage: multer.diskStorage({
      destination: paths.uploads,
      filename: (req, file, cb) => cb(null, newId("ref") + IMAGE_EXT[file.mimetype]),
    }),
    limits: { fileSize: 20 * 1024 * 1024, files: 9 },
    fileFilter: (req, file, cb) => cb(IMAGE_EXT[file.mimetype] ? null : new ValidationError(UPLOAD_ERROR), true),
  });

  // --- trạng thái & sự kiện trực tiếp ---
  app.get("/api/state", (req, res) => res.json(state()));

  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = () => res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
    let timer = null;
    const onChange = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        send();
      }, 200);
    };
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    bus.on("change", onChange);
    req.on("close", () => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      bus.off("change", onChange);
    });
    send();
  });

  // --- tài khoản ---
  app.post("/api/accounts", (req, res) => {
    const account = accounts.create(req.body?.name);
    driver.openWindow(account.id).catch((err) => console.error("[openWindow]", err.message));
    res.status(201).json(account);
  });

  app.post("/api/accounts/:id/open", async (req, res) => {
    requireAccount(req.params.id);
    if (scheduler.isBusy(req.params.id)) return res.status(409).json({ error: BUSY_ERROR });
    await driver.openWindow(req.params.id);
    res.status(204).end();
  });

  app.post("/api/accounts/:id/verify", async (req, res) => {
    requireAccount(req.params.id);
    if (scheduler.isBusy(req.params.id)) return res.status(409).json({ error: BUSY_ERROR });
    const ok = await driver.checkLoggedIn(req.params.id);
    await driver.close(req.params.id);
    res.json(accounts.setState(req.params.id, ok ? "ready" : "needs_login", {
      lastError: ok ? null : "Chưa thấy đăng nhập muse.ai",
    }));
  });

  app.patch("/api/accounts/:id", (req, res) => {
    const { name, enabled } = req.body ?? {};
    res.json(accounts.update(req.params.id, { name, enabled }));
  });

  app.delete("/api/accounts/:id", async (req, res) => {
    requireAccount(req.params.id);
    if (scheduler.isBusy(req.params.id)) return res.status(409).json({ error: BUSY_ERROR });
    await driver.close(req.params.id);
    accounts.remove(req.params.id);
    res.status(204).end();
  });

  // --- tải ảnh tham chiếu ---
  app.post("/api/uploads", upload.array("files", 9), (req, res) => {
    if (!req.files?.length) throw new ValidationError("Chưa chọn ảnh nào");
    res.status(201).json(req.files.map((f) => ({ path: f.path, url: toUrl("/uploads", paths.uploads, f.path) })));
  });

  // --- việc ---
  app.post("/api/jobs", (req, res) => {
    checkRefs(req.body?.refImages);
    res.status(201).json(jobs.enqueue(req.body));
  });

  app.post("/api/jobs/bulk", (req, res) => {
    const { lines, ...common } = req.body ?? {};
    const prompts = String(lines ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!prompts.length) throw new ValidationError("Chưa có prompt nào");
    if (prompts.some((p) => p.length > 4000)) throw new ValidationError("Mỗi prompt tối đa 4000 ký tự");
    checkRefs(common.refImages);
    res.status(201).json(prompts.flatMap((prompt) => jobs.enqueue({ ...common, prompt })));
  });

  app.post("/api/jobs/:id/cancel", async (req, res) => {
    await scheduler.cancel(req.params.id);
    res.json(jobs.get(req.params.id));
  });

  app.post("/api/jobs/:id/retry", (req, res) => res.json(jobs.retry(req.params.id)));

  app.delete("/api/jobs/:id", (req, res) => {
    jobs.remove(req.params.id);
    res.status(204).end();
  });

  app.post("/api/queue/pause", (req, res) => {
    scheduler.pause();
    res.status(204).end();
  });

  app.post("/api/queue/resume", (req, res) => {
    scheduler.resume();
    res.status(204).end();
  });

  // --- cài đặt ---
  app.get("/api/settings", (req, res) => res.json(settings.get()));
  app.put("/api/settings", (req, res) => res.json(settings.save(req.body ?? {})));

  // --- thư viện ---
  app.get("/api/library", (req, res) => {
    const done = jobs.list().filter((j) => j.status === "done" && j.outputs.length);
    res.json(
      done.map((j) => ({
        id: j.id,
        type: j.type,
        prompt: j.prompt,
        durationSec: j.durationSec,
        updatedAt: j.updatedAt,
        items: j.outputs
          .filter((file) => fs.existsSync(file))
          .map((file) => ({
            path: file,
            kind: file.toLowerCase().endsWith(".mp4") ? "video" : "image",
            url: toUrl("/files", paths.downloads, file),
          })),
      })),
    );
  });

  app.post("/api/library/:jobId/use-as-ref", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) throw new NotFoundError("Không tìm thấy việc");
    const file = job.outputs[Number(req.body?.index ?? 0)];
    if (!file || file.toLowerCase().endsWith(".mp4") || !fs.existsSync(file)) {
      throw new ValidationError("Chỉ dùng được ảnh đã tạo làm tham chiếu");
    }
    const copy = path.join(paths.uploads, newId("ref") + path.extname(file));
    fs.copyFileSync(file, copy);
    res.status(201).json({ path: copy, url: toUrl("/uploads", paths.uploads, copy) });
  });

  app.post("/api/open-folder", (req, res) => {
    const target = String(req.body?.path ?? "");
    const abs = path.resolve(target || paths.downloads);
    if (abs !== path.resolve(paths.downloads) && !isInside(abs, paths.downloads)) {
      throw new ValidationError("Chỉ mở được thư mục kết quả");
    }
    if (!fs.existsSync(abs)) throw new NotFoundError("Không tìm thấy file");
    openPath(abs);
    res.status(204).end();
  });

  // --- file tĩnh ---
  app.use("/files", express.static(paths.downloads));
  app.use("/uploads", express.static(paths.uploads));
  app.use(express.static(paths.public));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: UPLOAD_ERROR });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Dữ liệu gửi lên không hợp lệ" });
    console.error("[server]", err);
    res.status(500).json({ error: `Lỗi máy chủ: ${err.message}` });
  });

  return app;
}
