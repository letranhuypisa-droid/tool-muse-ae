import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ROOT } from "./config.js";
import { localDate } from "./util.js";

// Lệnh dòng lệnh cho người và cho Claude Code: chỉ gọi API của tool đang chạy, không đụng thẳng vào data/.

const USAGE = `Cách dùng: npm run muse -- <lệnh> [tùy chọn]

  start                      Bật tool ngầm nếu chưa chạy (không mở trình duyệt)
  status                     Xem tài khoản và hàng đợi
  add --prompt "..."         Thêm việc. Tùy chọn:
        --type video|image   (mặc định video)
        --duration <giây>    1–60, mặc định 10 (chỉ video)
        --ref <ảnh>          ảnh tham chiếu JPG/PNG/WEBP, lặp lại được (tối đa 9)
        --count <n>          số bản, mặc định 1
        --no-1080p           giữ độ phân giải gốc của Muse
        --wait               chờ xong rồi in đường dẫn file
  batch <file.json|file.txt> Thêm cả loạt. JSON: [{ "prompt", "type", "duration", "refs": [...], "count", "upscale1080" }]
                             (đường dẫn refs tính từ thư mục chứa file). TXT: mỗi dòng một prompt, dùng tùy chọn của add.
  wait <jobId...>            Chờ các việc xong
  jobs [--limit n]           Các việc gần đây
  accounts                   Danh sách tài khoản
  accounts add <tên>         Thêm tài khoản, mở cửa sổ Chrome để bạn tự đăng nhập
  accounts verify <id|tên>   Kiểm tra đã đăng nhập chưa

  --json                     In kết quả dạng JSON (dễ cho script/Claude đọc)
  Mã thoát: 0 ổn · 1 có việc lỗi/bị từ chối/dữ liệu sai · 2 tool chưa chạy · 3 hết thời gian chờ`;

const JOB_LABEL = {
  queued: "Chờ", running: "Đang tạo", postprocessing: "Hậu kỳ", done: "Xong",
  failed: "Lỗi", refused: "Bị từ chối", cancelled: "Đã hủy",
};
const ACCOUNT_LABEL = { needs_login: "Cần đăng nhập", ready: "Sẵn sàng", cooldown: "Hết lượt", error: "Lỗi" };
const FINISHED = new Set(["done", "failed", "refused", "cancelled"]);
const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.exitCode = code;
  }
}

function defaultSpawnServer(baseUrl) {
  return (args) =>
    spawn(process.execPath, [path.join(ROOT, "src", "main.js"), ...args], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, PORT: new URL(baseUrl).port || "3000" },
    }).unref();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runCli(argv, {
  baseUrl = process.env.MUSE_URL || "http://127.0.0.1:3000",
  out = (s) => console.log(s),
  err = (s) => console.error(s),
  pollMs = 3000,
  startWaitMs = 20_000,
  spawnServer = defaultSpawnServer(baseUrl),
} = {}) {
  let opts;
  let positionals;
  try {
    ({ values: opts, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        type: { type: "string" }, prompt: { type: "string" }, duration: { type: "string" },
        ref: { type: "string", multiple: true }, count: { type: "string" }, "no-1080p": { type: "boolean" },
        wait: { type: "boolean" }, json: { type: "boolean" }, limit: { type: "string" },
        timeout: { type: "string" }, help: { type: "boolean" },
      },
    }));
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`);
    return 1;
  }

  async function call(method, url, body) {
    let res;
    try {
      res = await fetch(baseUrl + url, {
        method,
        headers: body && !(body instanceof FormData) ? { "content-type": "application/json" } : {},
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new CliError(`Tool chưa chạy tại ${baseUrl}. Bật bằng: npm run muse -- start`, 2);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new CliError(data?.error || `Lỗi ${res.status}`);
    return data;
  }

  const print = (text, data) => out(opts.json ? JSON.stringify(data, null, 2) : text);
  const jobView = (j) => ({
    id: j.id, type: j.type, prompt: j.prompt, durationSec: j.durationSec, status: j.status,
    outputs: j.outputs, error: j.error, replyText: j.replyText,
  });
  const jobLine = (j) => {
    const label = JOB_LABEL[j.status] ?? j.status;
    const progress = j.type === "video" && j.status === "running" ? ` (clip ${j.progress.clip}/${j.progress.totalClips})` : "";
    let line = `${j.id} · ${j.type === "video" ? `video ${j.durationSec}s` : "ảnh"} · ${label}${progress}`;
    if (j.status === "done") line += ` → ${j.outputs.join(", ")}`;
    else if (j.error && !FINISHED.has(j.status) === false) line += `: ${j.error}`;
    return line;
  };

  function checkRef(file) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new CliError(`Không tìm thấy ảnh tham chiếu: ${abs}`);
    if (!MIME_BY_EXT[path.extname(abs).toLowerCase()]) throw new CliError(`Ảnh tham chiếu phải là JPG, PNG hoặc WEBP: ${abs}`);
    return abs;
  }

  async function uploadRefs(files) {
    if (!files.length) return [];
    const form = new FormData();
    for (const file of files) {
      const blob = new Blob([fs.readFileSync(file)], { type: MIME_BY_EXT[path.extname(file).toLowerCase()] });
      form.append("files", blob, path.basename(file));
    }
    return (await call("POST", "/api/uploads", form)).map((u) => u.path);
  }

  function jobBody(spec) {
    const type = spec.type ?? "video";
    const body = { type, prompt: spec.prompt, count: spec.count === undefined ? 1 : Number(spec.count) };
    if (type === "video") {
      body.durationSec = spec.duration === undefined ? 10 : Number(spec.duration);
      body.upscale1080 = spec.upscale1080 ?? true;
    }
    return body;
  }

  async function enqueue(spec, refPaths) {
    const refImages = await uploadRefs(refPaths);
    return call("POST", "/api/jobs", { ...jobBody(spec), refImages });
  }

  async function waitFor(ids) {
    const deadline = Date.now() + (Number(opts.timeout) || 180) * 60_000;
    const seen = new Map();
    for (;;) {
      const { jobs } = await call("GET", "/api/state");
      const mine = ids.map((id) => jobs.find((j) => j.id === id) ?? { id, status: "failed", error: "Không tìm thấy việc", outputs: [], type: "?" });
      if (!opts.json) {
        for (const j of mine) {
          const key = `${j.status}:${j.progress?.clip ?? ""}`;
          if (seen.get(j.id) !== key) {
            seen.set(j.id, key);
            if (!FINISHED.has(j.status)) out(jobLine(j));
          }
        }
      }
      if (mine.every((j) => FINISHED.has(j.status))) return mine;
      if (Date.now() > deadline) throw new CliError("Hết thời gian chờ, các việc vẫn đang chạy trong tool.", 3);
      await sleep(pollMs);
    }
  }

  function report(jobs) {
    const lines = jobs.map((j) => {
      let line = jobLine(j);
      if (["failed", "refused"].includes(j.status) && j.error) line += ` — ${j.error}`;
      if (j.status === "refused" && j.replyText) line += ` (Muse: “${j.replyText}”)`;
      return line;
    });
    print(lines.join("\n"), { jobs: jobs.map(jobView) });
    return jobs.some((j) => ["failed", "refused", "cancelled"].includes(j.status)) ? 1 : 0;
  }

  async function finish(jobs) {
    if (!opts.wait) return report(jobs);
    return report(await waitFor(jobs.map((j) => j.id)));
  }

  function accountLine(a, today) {
    let label = ACCOUNT_LABEL[a.state] ?? a.state;
    if (a.state === "cooldown" && a.cooldownUntil) label += ` đến ${new Date(a.cooldownUntil).toLocaleString("vi-VN")}`;
    const used = a.usage?.date === today ? a.usage.jobs : 0;
    return `  - ${a.name} (${a.id}): ${label}${a.enabled ? "" : " · đang tắt"}${a.busy ? " · đang chạy việc" : ""} · hôm nay ${used} việc`;
  }

  const commands = {
    async status() {
      const s = await call("GET", "/api/state");
      const today = localDate(new Date());
      const queue = Object.fromEntries(Object.keys(JOB_LABEL).map((k) => [k, s.jobs.filter((j) => j.status === k).length]));
      const accounts = s.accounts.map((a) => ({
        id: a.id, name: a.name, state: a.state, enabled: a.enabled, busy: a.busy,
        usageToday: a.usage?.date === today ? a.usage.jobs : 0, cooldownUntil: a.cooldownUntil,
      }));
      const lines = [
        `Tool đang chạy tại ${baseUrl}${s.scheduler.paused ? " · hàng đợi đang TẠM DỪNG" : ""}`,
        "Tài khoản:",
        ...(s.accounts.length ? s.accounts.map((a) => accountLine(a, today)) : ["  (chưa có — thêm bằng: npm run muse -- accounts add <tên>)"]),
        `Hàng đợi: ${queue.queued} chờ, ${queue.running} đang chạy, ${queue.postprocessing} hậu kỳ, ${queue.done} xong, ${queue.failed} lỗi, ${queue.refused} bị từ chối`,
      ];
      if (s.scheduler.waiting === "no_accounts") lines.push("Cảnh báo: tất cả tài khoản đang hết lượt hoặc cần đăng nhập.");
      print(lines.join("\n"), { url: baseUrl, scheduler: s.scheduler, accounts, queue });
      return 0;
    },

    async add() {
      if (!opts.prompt?.trim()) throw new CliError('Thiếu --prompt "nội dung"');
      const refs = (opts.ref ?? []).map(checkRef);
      const jobs = await enqueue(
        { type: opts.type, prompt: opts.prompt, duration: opts.duration, count: opts.count, upscale1080: !opts["no-1080p"] },
        refs,
      );
      return finish(jobs);
    },

    async batch() {
      const file = positionals[1];
      if (!file || !fs.existsSync(file)) throw new CliError(`Không tìm thấy file: ${file ?? "(chưa nhập)"}`);
      const dir = path.dirname(path.resolve(file));
      const defaults = { type: opts.type, duration: opts.duration, count: opts.count, upscale1080: !opts["no-1080p"] };
      const cliRefs = (opts.ref ?? []).map(checkRef);
      let specs;
      if (file.toLowerCase().endsWith(".json")) {
        let list;
        try {
          list = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (e) {
          throw new CliError(`File JSON không đọc được: ${e.message}`);
        }
        if (!Array.isArray(list)) throw new CliError("File JSON phải là một mảng các cảnh");
        specs = list.map((item, i) => {
          if (typeof item?.prompt !== "string" || !item.prompt.trim()) throw new CliError(`Cảnh số ${i + 1} thiếu "prompt"`);
          const refs = item.refs ?? item.refImages ?? [];
          return {
            spec: {
              ...defaults,
              type: item.type ?? defaults.type,
              prompt: item.prompt,
              duration: item.duration ?? item.durationSec ?? defaults.duration,
              count: item.count ?? defaults.count,
              upscale1080: item.upscale1080 ?? defaults.upscale1080,
            },
            refs: refs.map((r) => checkRef(path.resolve(dir, r))),
          };
        });
      } else {
        specs = fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
          .map((prompt) => ({ spec: { ...defaults, prompt }, refs: cliRefs }));
      }
      if (!specs.length) throw new CliError("File không có prompt nào");
      const jobs = [];
      for (const { spec, refs } of specs) jobs.push(...(await enqueue(spec, refs)));
      return finish(jobs);
    },

    async wait() {
      const ids = positionals.slice(1);
      if (!ids.length) throw new CliError("Cần ít nhất một jobId: npm run muse -- wait job_xxx");
      return report(await waitFor(ids));
    },

    async jobs() {
      const { jobs } = await call("GET", "/api/state");
      const list = jobs.slice(0, Number(opts.limit) || 20);
      print(list.map(jobLine).join("\n") || "(chưa có việc nào)", { jobs: list.map(jobView) });
      return 0;
    },

    async accounts() {
      const sub = positionals[1] ?? "list";
      const name = positionals.slice(2).join(" ").trim();
      if (sub === "list") {
        const s = await call("GET", "/api/state");
        const today = localDate(new Date());
        print(s.accounts.map((a) => accountLine(a, today)).join("\n") || "(chưa có tài khoản)", { accounts: s.accounts });
        return 0;
      }
      if (sub === "add") {
        if (!name) throw new CliError("Cần tên: npm run muse -- accounts add <tên>");
        const a = await call("POST", "/api/accounts", { name });
        print(
          `Đã tạo tài khoản "${a.name}" (${a.id}). Một cửa sổ Chrome vừa mở: hãy đăng nhập muse.ai trong đó, ` +
            `rồi chạy: npm run muse -- accounts verify ${a.id}`,
          a,
        );
        return 0;
      }
      if (sub === "verify") {
        const { accounts } = await call("GET", "/api/state");
        const target = accounts.find((a) => a.id === name) ?? accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
        if (!target) throw new CliError(`Không tìm thấy tài khoản: ${name}`);
        const a = await call("POST", `/api/accounts/${target.id}/verify`);
        print(`${a.name}: ${ACCOUNT_LABEL[a.state] ?? a.state}`, a);
        return a.state === "ready" ? 0 : 1;
      }
      throw new CliError(`Không hiểu "accounts ${sub}". Dùng: accounts | accounts add <tên> | accounts verify <id|tên>`);
    },

    async start() {
      try {
        await call("GET", "/api/state");
        print(`Tool đã chạy sẵn tại ${baseUrl}`, { url: baseUrl, started: false });
        return 0;
      } catch (e) {
        if (e.exitCode !== 2) throw e;
      }
      spawnServer(["--no-open"]);
      for (const deadline = Date.now() + startWaitMs; Date.now() < deadline; ) {
        await sleep(250);
        try {
          await call("GET", "/api/state");
          print(`Đã bật tool tại ${baseUrl}`, { url: baseUrl, started: true });
          return 0;
        } catch {
          // chưa sẵn sàng, thử lại
        }
      }
      throw new CliError("Không bật được tool. Thử chạy start.bat để xem lỗi.");
    },
  };

  const command = opts.help ? "help" : positionals[0] ?? "help";
  if (command === "help") {
    out(USAGE);
    return 0;
  }
  if (!commands[command]) {
    err(`Không có lệnh "${command}".\n\n${USAGE}`);
    return 1;
  }
  try {
    return await commands[command]();
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    err(e.message);
    return e.exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
