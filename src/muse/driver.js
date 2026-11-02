import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { MuseError } from "./errors.js";
import * as sel from "./selectors.js";

const EXT_BY_MIME = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "video/mp4": "mp4" };

async function launch(profileDir, headless) {
  const options = { headless, viewport: { width: 1280, height: 860 } };
  try {
    return await chromium.launchPersistentContext(profileDir, { ...options, channel: "chrome" });
  } catch (chromeErr) {
    try {
      return await chromium.launchPersistentContext(profileDir, { ...options, channel: "msedge" });
    } catch {
      throw new MuseError("BROWSER", `Không mở được Chrome: ${chromeErr.message.split("\n")[0]}`);
    }
  }
}

const firstLine = (message) => message.split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 60);

// Chạy trong trang: cuộn khung chat (và mọi khung cuộn bọc nó) xuống cuối. Với chat dài, muse.ai mở trang
// ở chỗ đọc dở và chỉ vẽ tin nhắn mới khi đã cuộn xuống cuối (trước đó chỉ hiện nút "N messages").
function scrollChatToBottomInPage(log) {
  let el = document.querySelector(log);
  while (el) {
    if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight;
    el = el.parentElement;
  }
  const doc = document.scrollingElement;
  if (doc) doc.scrollTop = doc.scrollHeight;
}

// Chạy trong trang: số phần tử "lá" trong khung chat chứa đoạn đầu tin nhắn, và ô chat còn chữ hay không.
function sendStateInPage({ prefix, log, composer }) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const root = document.querySelector(log) || document.body;
  let anchors = 0;
  for (const el of root.querySelectorAll("*")) {
    if (!norm(el.textContent).includes(prefix)) continue;
    if ([...el.children].some((c) => norm(c.textContent).includes(prefix))) continue;
    anchors += 1;
  }
  const box = document.querySelector(composer);
  return { anchors, composerEmpty: !box || box.value.trim() === "" };
}

// Chạy trong trang: tìm tin nhắn mình vừa gửi (anchor) rồi lấy media nằm sau nó.
async function collectInPage({ prefix, full, before, sel }) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const log = document.querySelector(sel.CHAT_LOG) || document.body;
  let anchor = null;
  for (const el of log.querySelectorAll("*")) {
    if (!norm(el.textContent).includes(prefix)) continue;
    if ([...el.children].some((c) => norm(c.textContent).includes(prefix))) continue;
    anchor = el;
  }
  const isNew = (el, src) =>
    anchor ? Boolean(anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) : !before.includes(src);

  const found = [];
  for (const w of log.querySelectorAll(sel.VIDEO_WRAPPER)) {
    const src = w.getAttribute(sel.VIDEO_SRC_ATTR);
    if (src && isNew(w, src)) found.push({ kind: "video", src });
  }
  for (const img of log.querySelectorAll(`${sel.IMAGE_BUTTON} img`)) {
    const src = img.currentSrc || img.src;
    if (src && isNew(img, src)) found.push({ kind: "image", src });
  }

  const media = [];
  for (const item of found) {
    const blob = await (await fetch(item.src)).blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    media.push({ kind: item.kind, mime: blob.type, base64: String(dataUrl).split(",")[1] || "" });
  }

  const text = norm(log.innerText);
  let at = text.lastIndexOf(full);
  let replyText = at >= 0 ? text.slice(at + full.length) : "";
  if (at < 0) {
    at = text.lastIndexOf(prefix);
    replyText = at >= 0 ? text.slice(at + prefix.length) : "";
  }
  return { anchorFound: Boolean(anchor), media, replyText: replyText.trim().slice(0, 2000) };
}

export function createMuseDriver({
  profilesDir, errorsDir, getSettings, homeUrl = sel.HOME_URL,
  loginWaitMs = 20_000, stopAppearMs = 30_000, settleMs = 3000, sendWaitMs = 15_000,
}) {
  const sessions = new Map(); // accountId → Promise<{ context, page, headless }>

  async function open(accountId, headful) {
    const existing = sessions.get(accountId);
    if (existing) {
      const s = await existing;
      if (!(headful && s.headless) && !s.page.isClosed()) return s;
      await close(accountId);
    }
    const headless = headful ? false : getSettings().headless;
    const pending = (async () => {
      const context = await launch(path.join(profilesDir, accountId), headless);
      context.on("close", () => {
        if (sessions.get(accountId) === pending) sessions.delete(accountId);
      });
      const page = context.pages()[0] ?? (await context.newPage());
      return { context, page, headless };
    })();
    sessions.set(accountId, pending);
    try {
      return await pending;
    } catch (err) {
      sessions.delete(accountId);
      throw err;
    }
  }

  async function close(accountId) {
    const pending = sessions.get(accountId);
    if (!pending) return;
    sessions.delete(accountId);
    try {
      const s = await pending;
      await s.context.close();
    } catch {
      // đã đóng hoặc chưa mở được — không cần làm gì
    }
  }

  async function hasComposer(page) {
    try {
      await page.locator(sel.COMPOSER).first().waitFor({ state: "visible", timeout: loginWaitMs });
      return true;
    } catch {
      return false;
    }
  }

  async function attach(page, files) {
    await page.locator(sel.FILE_INPUT).first().setInputFiles(files);
    await page
      .waitForFunction(
        ({ composer, n }) => {
          let box = document.querySelector(composer);
          for (let i = 0; i < 4 && box?.parentElement; i++) box = box.parentElement;
          return (box?.querySelectorAll("img").length ?? 0) >= n;
        },
        { composer: sel.COMPOSER, n: files.length },
        { timeout: 20_000 },
      )
      .catch(() => {});
  }

  async function turnOnPage(page, { message, files = [], timeoutMs }) {
    if (!(await hasComposer(page))) throw new MuseError("NOT_LOGGED_IN", "Tài khoản chưa đăng nhập muse.ai");
    await page.evaluate(scrollChatToBottomInPage, sel.CHAT_LOG);
    const before = await page.evaluate(
      ({ s }) => [
        ...[...document.querySelectorAll(s.VIDEO_WRAPPER)].map((w) => w.getAttribute(s.VIDEO_SRC_ATTR)),
        ...[...document.querySelectorAll(`${s.IMAGE_BUTTON} img`)].map((i) => i.currentSrc || i.src),
      ],
      { s: { ...sel } },
    );
    if (files.length) await attach(page, files);

    // fill() đặt nguyên văn bản (kể cả xuống dòng) mà không gõ phím Enter giữa chừng.
    const prefix = firstLine(message);
    const probe = { prefix, log: sel.CHAT_LOG, composer: sel.COMPOSER };
    const sendBefore = await page.evaluate(sendStateInPage, probe);
    const composer = page.locator(sel.COMPOSER).first();
    await composer.fill(message);
    await composer.press("Enter");

    // Phải chắc tin nhắn đã đi (hiện thêm trong khung chat, hoặc ô chat đã trống). Nếu không,
    // mọi media nằm sau một tin nhắn cũ giống hệt sẽ bị lấy nhầm làm kết quả mới.
    let sent = false;
    for (const deadline = Date.now() + sendWaitMs; !sent && Date.now() < deadline; ) {
      const sendNow = await page.evaluate(sendStateInPage, probe);
      sent = sendNow.anchors > sendBefore.anchors || sendNow.composerEmpty;
      if (!sent) await page.waitForTimeout(250);
    }
    if (!sent) throw new MuseError("BROWSER", "Không gửi được tin nhắn cho Muse (ô chat không nhận lệnh gửi)");

    const stop = page.locator(sel.STOP_BUTTON).first();
    await stop.waitFor({ state: "visible", timeout: stopAppearMs }).catch(() => {});
    try {
      await stop.waitFor({ state: "hidden", timeout: timeoutMs });
    } catch {
      throw new MuseError("TIMEOUT", `Muse chưa trả kết quả sau ${Math.round(timeoutMs / 60000)} phút`);
    }
    // Cuộn xuống cuối vài lần trong lúc chờ để muse.ai vẽ hết câu trả lời mới (ảnh/video có thể tải sau).
    for (let i = 0; i < 3; i++) {
      await page.evaluate(scrollChatToBottomInPage, sel.CHAT_LOG);
      await page.waitForTimeout(settleMs / 3);
    }
    await page.evaluate(scrollChatToBottomInPage, sel.CHAT_LOG);
    await page
      .waitForFunction(
        ({ s }) => {
          const log = document.querySelector(s.CHAT_LOG) || document.body;
          if (log.querySelector('[aria-busy="true"]')) return false;
          return [...log.querySelectorAll(s.VIDEO_WRAPPER)].every((w) => w.getAttribute(s.VIDEO_SRC_ATTR));
        },
        { s: { ...sel } },
        { timeout: 30_000 },
      )
      .catch(() => {});

    const result = await page.evaluate(collectInPage, {
      prefix,
      full: message.replace(/\s+/g, " ").trim(),
      before,
      sel: { ...sel },
    });
    return {
      media: result.media
        .filter((m) => EXT_BY_MIME[m.mime])
        .map((m) => ({ kind: m.kind, ext: EXT_BY_MIME[m.mime], bytes: Buffer.from(m.base64, "base64") })),
      replyText: result.replyText,
    };
  }

  async function screenshot(page, jobId) {
    if (!page || page.isClosed()) return;
    try {
      fs.mkdirSync(errorsDir, { recursive: true });
      await page.screenshot({ path: path.join(errorsDir, `${jobId}-${Date.now()}.png`) });
    } catch {
      // chụp màn hình chỉ để dò lỗi, hỏng thì bỏ qua
    }
  }

  return {
    async openWindow(accountId) {
      const { page } = await open(accountId, true);
      await page.goto(homeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.bringToFront().catch(() => {});
    },

    async checkLoggedIn(accountId) {
      const { page } = await open(accountId, false);
      await page.goto(homeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      return hasComposer(page);
    },

    async runTurn(accountId, { message, files = [], timeoutMs, jobId }) {
      let page;
      try {
        ({ page } = await open(accountId, false));
        await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
        const result = await turnOnPage(page, { message, files, timeoutMs });
        if (!result.media.length) await screenshot(page, jobId); // để xem Muse đã trả lời gì
        return result;
      } catch (err) {
        await screenshot(page, jobId);
        throw err instanceof MuseError ? err : new MuseError("BROWSER", err.message.split("\n")[0]);
      }
    },

    close,
    async closeAll() {
      await Promise.all([...sessions.keys()].map(close));
    },
    isOpen: (accountId) => sessions.has(accountId),

    // Các bước bên trong runTurn, tách ra để test được lịch sử chat trên cùng một trang.
    _pageFor: async (accountId) => (await open(accountId, false)).page,
    _turnOnPage: turnOnPage,
    _attach: attach,
  };
}
