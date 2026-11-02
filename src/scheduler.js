import { notifyChange } from "./events.js";
import { localDate, randomBetween } from "./util.js";

export function pickAccount(accounts, { settings, now, busyIds, today }) {
  const t = now.getTime();
  const usage = (a) => (a.usage?.date === today ? a.usage.jobs : 0);
  const eligible = accounts.filter(
    (a) =>
      a.enabled &&
      a.state === "ready" &&
      !busyIds.has(a.id) &&
      (!a.restUntil || Date.parse(a.restUntil) <= t) &&
      (settings.dailyCapPerAccount === 0 || usage(a) < settings.dailyCapPerAccount),
  );
  eligible.sort(
    (a, b) =>
      usage(a) - usage(b) ||
      (a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0) - (b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0),
  );
  return eligible[0] ?? null;
}

export function createScheduler({
  accounts, jobs, getSettings, runJob, driver,
  now = () => new Date(), random = Math.random, tickMs = 2000,
}) {
  const running = new Map(); // jobId → { accountId, controller, done: Promise }
  let paused = false;
  let waiting = null;
  let timer = null;

  function rest(accountId, settings) {
    const ms = randomBetween(settings.delayMinSec, settings.delayMaxSec, random) * 1000;
    accounts.setRest(accountId, new Date(now().getTime() + ms).toISOString());
  }

  // Luôn cập nhật việc trước tài khoản: nếu ghi file tài khoản lỗi, việc vẫn không bị kẹt ở "running".
  function applyOutcome(jobId, accountId, outcome) {
    const settings = getSettings();
    const job = jobs.get(jobId);
    if (!job || outcome.ok) {
      if (accounts.get(accountId)) rest(accountId, settings);
      return;
    }
    const retryOrFail = () => {
      const attempts = job.attempts + 1;
      const failed = attempts > settings.maxRetries;
      jobs.update(jobId, {
        status: failed ? "failed" : "queued",
        accountId: failed ? job.accountId : null,
        attempts,
        error: outcome.message,
        replyText: outcome.replyText ?? job.replyText,
      });
    };
    switch (outcome.code) {
      case "LIMIT": {
        // Hai tài khoản khác nhau cùng "hết lượt" với một việc: nhiều khả năng là đoán nhầm từ câu trả lời,
        // không cho thêm tài khoản nào nghỉ 24 giờ nữa mà tính như một lần thử lỗi.
        const hits = job.limitHits ?? [];
        if (hits.some((id) => id !== accountId)) {
          retryOrFail();
          break;
        }
        jobs.update(jobId, {
          status: "queued", accountId: null, error: outcome.message,
          replyText: outcome.replyText ?? null, limitHits: [...new Set([...hits, accountId])],
        });
        const until = new Date(now().getTime() + settings.cooldownHours * 3600e3).toISOString();
        accounts.setState(accountId, "cooldown", { cooldownUntil: until, lastError: outcome.message });
        return;
      }
      case "NOT_LOGGED_IN":
        jobs.update(jobId, { status: "queued", accountId: null });
        accounts.setState(accountId, "needs_login", { lastError: outcome.message });
        return;
      case "REFUSED":
        jobs.update(jobId, { status: "refused", error: outcome.message, replyText: outcome.replyText ?? null });
        break;
      case "FFMPEG":
        jobs.update(jobId, { status: "failed", error: outcome.message });
        break;
      default:
        retryOrFail();
    }
    rest(accountId, settings);
  }

  function launch(job, account) {
    const controller = new AbortController();
    jobs.update(job.id, { status: "running", accountId: account.id, error: null });
    accounts.recordJobStart(account.id);
    const fresh = jobs.get(job.id);
    const entry = { accountId: account.id, controller };
    entry.done = Promise.resolve()
      .then(() => runJob(fresh, accounts.get(account.id), { signal: controller.signal }))
      .catch((err) => ({ ok: false, code: "TRANSIENT", message: err?.message || String(err) }))
      // Lượt đã bị hủy: việc có thể đã được "Thử lại" và đang chờ lượt mới, đừng ghi đè trạng thái của nó.
      .then((outcome) => applyOutcome(job.id, account.id, controller.signal.aborted ? { ok: true } : outcome))
      .catch((err) => console.error("[scheduler]", err))
      .finally(() => {
        if (running.get(job.id) === entry) running.delete(job.id);
        notifyChange();
      });
    running.set(job.id, entry);
  }

  async function tick() {
    accounts.refreshCooldowns();
    const settings = getSettings();
    let next = waiting;
    while (!paused && running.size < settings.concurrency) {
      const job = jobs.nextQueued(new Set(running.keys()));
      if (!job) {
        next = null;
        break;
      }
      const list = accounts.list();
      // Tài khoản đang chạy việc, hoặc đang mở cửa sổ cho người dùng / kiểm tra đăng nhập.
      const busyIds = new Set([...running.values()].map((r) => r.accountId));
      for (const a of list) if (driver?.isOpen?.(a.id)) busyIds.add(a.id);
      const ctx = { settings, now: now(), busyIds, today: localDate(now()) };
      const account = pickAccount(list, ctx);
      if (!account) {
        const resting = pickAccount(list.map((a) => ({ ...a, restUntil: null })), ctx);
        next = running.size > 0 ? null : resting ? "resting" : "no_accounts";
        break;
      }
      next = null;
      launch(job, account);
    }
    if (paused) next = null;
    if (next !== waiting) {
      waiting = next;
      notifyChange();
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch((err) => console.error("[scheduler]", err)), tickMs);
      tick().catch((err) => console.error("[scheduler]", err));
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    pause() {
      paused = true;
      notifyChange();
    },
    resume() {
      paused = false;
      notifyChange();
      tick().catch((err) => console.error("[scheduler]", err));
    },
    async whenIdle() {
      while (running.size) await Promise.all([...running.values()].map((r) => r.done));
    },
    status: () => ({ paused, running: running.size, waiting }),
    isBusy: (accountId) => [...running.values()].some((r) => r.accountId === accountId),
    async cancel(jobId) {
      jobs.cancel(jobId);
      const r = running.get(jobId);
      if (!r) return;
      r.controller.abort();
      await driver.close(r.accountId);
    },
  };
}
