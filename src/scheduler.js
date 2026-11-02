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

  function applyOutcome(jobId, accountId, outcome) {
    const settings = getSettings();
    const job = jobs.get(jobId);
    if (!job || job.status === "cancelled") {
      if (accounts.get(accountId)) rest(accountId, settings);
      return;
    }
    if (outcome.ok) {
      rest(accountId, settings);
      return;
    }
    switch (outcome.code) {
      case "LIMIT": {
        const until = new Date(now().getTime() + settings.cooldownHours * 3600e3).toISOString();
        accounts.setState(accountId, "cooldown", { cooldownUntil: until, lastError: outcome.message });
        jobs.update(jobId, { status: "queued", accountId: null, error: outcome.message, replyText: outcome.replyText ?? null });
        return;
      }
      case "NOT_LOGGED_IN":
        accounts.setState(accountId, "needs_login", { lastError: outcome.message });
        jobs.update(jobId, { status: "queued", accountId: null });
        return;
      case "REFUSED":
        jobs.update(jobId, { status: "refused", error: outcome.message, replyText: outcome.replyText ?? null });
        break;
      case "FFMPEG":
        jobs.update(jobId, { status: "failed", error: outcome.message });
        break;
      default: {
        const attempts = job.attempts + 1;
        const failed = attempts > settings.maxRetries;
        jobs.update(jobId, {
          status: failed ? "failed" : "queued",
          accountId: failed ? job.accountId : null,
          attempts,
          error: outcome.message,
          replyText: outcome.replyText ?? job.replyText,
        });
      }
    }
    rest(accountId, settings);
  }

  function launch(job, account) {
    const controller = new AbortController();
    jobs.update(job.id, { status: "running", accountId: account.id, error: null });
    accounts.recordJobStart(account.id);
    const fresh = jobs.get(job.id);
    const done = Promise.resolve()
      .then(() => runJob(fresh, accounts.get(account.id), { signal: controller.signal }))
      .catch((err) => ({ ok: false, code: "TRANSIENT", message: err?.message || String(err) }))
      .then((outcome) => applyOutcome(job.id, account.id, outcome))
      .catch((err) => console.error("[scheduler]", err))
      .finally(() => {
        running.delete(job.id);
        notifyChange();
      });
    running.set(job.id, { accountId: account.id, controller, done });
  }

  async function tick() {
    accounts.refreshCooldowns();
    const settings = getSettings();
    let next = waiting;
    while (!paused && running.size < settings.concurrency) {
      const job = jobs.nextQueued();
      if (!job) {
        next = null;
        break;
      }
      const busyIds = new Set([...running.values()].map((r) => r.accountId));
      const account = pickAccount(accounts.list(), { settings, now: now(), busyIds, today: localDate(now()) });
      if (!account) {
        next = running.size === 0 ? "no_accounts" : null;
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
