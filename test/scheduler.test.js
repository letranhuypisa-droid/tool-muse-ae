import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createScheduler, pickAccount } from "../src/scheduler.js";
import { createAccountService } from "../src/accounts.js";
import { createJobService } from "../src/jobs.js";
import { createJsonStore } from "../src/store.js";
import { normalizeSettings } from "../src/config.js";

function setup({ accounts: nAccounts = 1, jobs: nJobs = 1, settings = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse sched "));
  const clock = { now: new Date(2026, 10, 2, 9, 0, 0) };
  const now = () => clock.now;
  const accounts = createAccountService({ store: createJsonStore(path.join(dir, "a.json"), []), profilesDir: dir, now });
  const jobs = createJobService({ store: createJsonStore(path.join(dir, "j.json"), []), now });
  const accIds = [];
  for (let i = 0; i < nAccounts; i++) {
    const a = accounts.create(`A${i}`);
    accounts.setState(a.id, "ready");
    accIds.push(a.id);
  }
  if (nJobs) jobs.enqueue({ type: "image", prompt: "p", count: nJobs });

  const calls = [];
  const runJob = (job, account, { signal }) =>
    new Promise((resolve) => calls.push({ job, account, signal, resolve }));
  const closed = [];
  const held = new Set();
  const driver = { close: async (id) => closed.push(id), isOpen: (id) => held.has(id) };
  const cfg = normalizeSettings({ delayMinSec: 0, delayMaxSec: 0, ...settings });
  const scheduler = createScheduler({
    accounts, jobs, getSettings: () => cfg, runJob, driver, now, random: () => 0, tickMs: 1_000_000,
  });
  return { accounts, jobs, scheduler, calls, closed, clock, accIds, cfg, held };
}

const flush = () => new Promise((r) => setImmediate(r));

test("never exceeds concurrency and never double-books an account", async () => {
  const { scheduler, calls, jobs } = setup({ accounts: 4, jobs: 6, settings: { concurrency: 3 } });
  await scheduler.tick();
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((c) => c.account.id)).size, 3);
  assert.equal(scheduler.status().running, 3);
  assert.equal(jobs.list().filter((j) => j.status === "running").length, 3);
  await scheduler.tick();
  assert.equal(calls.length, 3);
});

test("one account runs one job at a time", async () => {
  const { scheduler, calls } = setup({ accounts: 1, jobs: 3, settings: { concurrency: 3 } });
  await scheduler.tick();
  assert.equal(calls.length, 1);
});

test("pickAccount prefers least-used today, then oldest lastUsedAt", () => {
  const now = new Date(2026, 10, 2, 9, 0, 0);
  const settings = normalizeSettings({});
  const base = { enabled: true, state: "ready", restUntil: null };
  const list = [
    { ...base, id: "a", usage: { date: "2026-11-02", jobs: 2 }, lastUsedAt: "2026-11-02T01:00:00Z" },
    { ...base, id: "b", usage: { date: "2026-11-02", jobs: 1 }, lastUsedAt: "2026-11-02T01:30:00Z" },
    { ...base, id: "c", usage: { date: "2026-11-01", jobs: 9 }, lastUsedAt: "2026-11-01T01:00:00Z" },
    { ...base, id: "d", usage: { date: "2026-11-02", jobs: 1 }, lastUsedAt: "2026-11-02T00:30:00Z" },
  ];
  assert.equal(pickAccount(list, { settings, now, busyIds: new Set(), today: "2026-11-02" }).id, "c");
  assert.equal(pickAccount(list, { settings, now, busyIds: new Set(["c"]), today: "2026-11-02" }).id, "d");
});

test("pickAccount skips disabled, needs_login, cooldown, resting and capped accounts", () => {
  const now = new Date(2026, 10, 2, 9, 0, 0);
  const settings = normalizeSettings({ dailyCapPerAccount: 1 });
  const ok = { enabled: true, state: "ready", restUntil: null, usage: { date: "2026-11-02", jobs: 0 }, lastUsedAt: null };
  const list = [
    { ...ok, id: "disabled", enabled: false },
    { ...ok, id: "login", state: "needs_login" },
    { ...ok, id: "cool", state: "cooldown" },
    { ...ok, id: "rest", restUntil: new Date(now.getTime() + 1000).toISOString() },
    { ...ok, id: "capped", usage: { date: "2026-11-02", jobs: 1 } },
  ];
  assert.equal(pickAccount(list, { settings, now, busyIds: new Set(), today: "2026-11-02" }), null);
  list.push({ ...ok, id: "good", restUntil: new Date(now.getTime() - 1).toISOString() });
  assert.equal(pickAccount(list, { settings, now, busyIds: new Set(), today: "2026-11-02" }).id, "good");
});

test("LIMIT puts account in cooldown and requeues job without spending an attempt", async () => {
  const { scheduler, calls, jobs, accounts, clock } = setup();
  await scheduler.tick();
  calls[0].resolve({ ok: false, code: "LIMIT", message: "hết lượt", replyText: "limit" });
  await scheduler.whenIdle();
  const job = jobs.get(calls[0].job.id);
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 0);
  assert.equal(job.accountId, null);
  const acc = accounts.get(calls[0].account.id);
  assert.equal(acc.state, "cooldown");
  assert.equal(acc.cooldownUntil, new Date(clock.now.getTime() + 24 * 3600e3).toISOString());
});

test("NOT_LOGGED_IN marks account needs_login and requeues", async () => {
  const { scheduler, calls, jobs, accounts } = setup();
  await scheduler.tick();
  calls[0].resolve({ ok: false, code: "NOT_LOGGED_IN", message: "Cần đăng nhập" });
  await scheduler.whenIdle();
  assert.equal(jobs.get(calls[0].job.id).status, "queued");
  assert.equal(accounts.get(calls[0].account.id).state, "needs_login");
  assert.equal(accounts.get(calls[0].account.id).lastError, "Cần đăng nhập");
});

test("TRANSIENT retries up to maxRetries then fails", async () => {
  const { scheduler, calls, jobs } = setup({ settings: { maxRetries: 2 } });
  for (let i = 0; i < 3; i++) {
    await scheduler.tick();
    assert.equal(calls.length, i + 1);
    calls[i].resolve({ ok: false, code: "TRANSIENT", message: "timeout" });
    await scheduler.whenIdle();
  }
  const job = jobs.get(calls[0].job.id);
  assert.equal(job.status, "failed");
  assert.equal(job.attempts, 3);
  assert.equal(job.error, "timeout");
  await scheduler.tick();
  assert.equal(calls.length, 3);
});

test("runJob throwing counts as TRANSIENT", async () => {
  const { accounts, jobs } = setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse sched "));
  void dir;
  const scheduler = createScheduler({
    accounts, jobs, getSettings: () => normalizeSettings({ delayMinSec: 0, delayMaxSec: 0 }),
    runJob: async () => { throw new Error("boom"); },
    driver: { close: async () => {} }, random: () => 0, tickMs: 1_000_000,
  });
  await scheduler.tick();
  await scheduler.whenIdle();
  const [job] = jobs.list();
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 1);
  assert.equal(job.error, "boom");
});

test("REFUSED stores reply and does not retry", async () => {
  const { scheduler, calls, jobs } = setup();
  await scheduler.tick();
  calls[0].resolve({ ok: false, code: "REFUSED", message: "Bị từ chối", replyText: "I can't do that" });
  await scheduler.whenIdle();
  const job = jobs.get(calls[0].job.id);
  assert.equal(job.status, "refused");
  assert.equal(job.replyText, "I can't do that");
  await scheduler.tick();
  assert.equal(calls.length, 1);
});

test("FFMPEG fails the job without retry", async () => {
  const { scheduler, calls, jobs } = setup();
  await scheduler.tick();
  calls[0].resolve({ ok: false, code: "FFMPEG", message: "ffmpeg lỗi" });
  await scheduler.whenIdle();
  assert.equal(jobs.get(calls[0].job.id).status, "failed");
});

test("rest delay applied after a job", async () => {
  const { scheduler, calls, jobs, accounts, clock } = setup({ jobs: 2, settings: { delayMinSec: 20, delayMaxSec: 60 } });
  await scheduler.tick();
  jobs.update(calls[0].job.id, { status: "done" });
  calls[0].resolve({ ok: true });
  await scheduler.whenIdle();
  const acc = accounts.get(calls[0].account.id);
  assert.equal(acc.restUntil, new Date(clock.now.getTime() + 20_000).toISOString());
  await scheduler.tick();
  assert.equal(calls.length, 1);
  assert.equal(scheduler.status().waiting, "resting");
  clock.now = new Date(clock.now.getTime() + 21_000);
  await scheduler.tick();
  assert.equal(calls.length, 2);
  assert.equal(scheduler.status().waiting, null);
});

test("pause stops new pickups; resume continues", async () => {
  const { scheduler, calls } = setup();
  scheduler.pause();
  await scheduler.tick();
  assert.equal(calls.length, 0);
  assert.equal(scheduler.status().paused, true);
  scheduler.resume();
  await scheduler.tick();
  assert.equal(calls.length, 1);
});

test("waiting = no_accounts when all accounts unavailable", async () => {
  const { scheduler, accounts, accIds } = setup({ accounts: 2 });
  accounts.update(accIds[0], { enabled: false });
  accounts.setState(accIds[1], "needs_login");
  await scheduler.tick();
  assert.equal(scheduler.status().waiting, "no_accounts");
});

test("cancel aborts the running job and closes the driver", async () => {
  const { scheduler, calls, jobs, closed } = setup();
  await scheduler.tick();
  const { job, account, signal, resolve } = calls[0];
  await scheduler.cancel(job.id);
  assert.equal(signal.aborted, true);
  assert.deepEqual(closed, [account.id]);
  resolve({ ok: false, code: "TRANSIENT", message: "Đã hủy" });
  await scheduler.whenIdle();
  await flush();
  assert.equal(jobs.get(job.id).status, "cancelled");
  assert.equal(jobs.get(job.id).attempts, 0);
});

test("cancel of a queued job just marks it cancelled", async () => {
  const { scheduler, jobs, closed } = setup({ accounts: 0 });
  const [job] = jobs.list();
  await scheduler.cancel(job.id);
  assert.equal(jobs.get(job.id).status, "cancelled");
  assert.deepEqual(closed, []);
});

test("retry of a cancelled job waits until the old run settles", async () => {
  const { scheduler, calls, jobs } = setup({ accounts: 3 });
  await scheduler.tick();
  const jobId = calls[0].job.id;
  await scheduler.cancel(jobId);
  jobs.retry(jobId);
  await scheduler.tick();
  assert.equal(calls.length, 1, "no second run while the first is still settling");
  calls[0].resolve({ ok: false, code: "TRANSIENT", message: "Đã hủy" });
  await scheduler.whenIdle();
  const job = jobs.get(jobId);
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 0, "the aborted run's outcome is ignored");
  await scheduler.tick();
  assert.equal(calls.length, 2);
  assert.equal(scheduler.status().running, 1);
  assert.equal(scheduler.isBusy(calls[1].account.id), true);
});

test("LIMIT on a second account for the same job is not another cooldown", async () => {
  const { scheduler, calls, jobs, accounts } = setup({ accounts: 2 });
  await scheduler.tick();
  calls[0].resolve({ ok: false, code: "LIMIT", message: "hết lượt", replyText: "limit" });
  await scheduler.whenIdle();
  await scheduler.tick();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].account.id, calls[0].account.id);
  calls[1].resolve({ ok: false, code: "LIMIT", message: "hết lượt", replyText: "limit" });
  await scheduler.whenIdle();
  assert.equal(accounts.get(calls[0].account.id).state, "cooldown");
  assert.equal(accounts.get(calls[1].account.id).state, "ready");
  const job = jobs.get(calls[0].job.id);
  assert.equal(job.attempts, 1);
  assert.equal(job.status, "queued");
});

test("accounts with an open manual window are not picked", async () => {
  const { scheduler, calls, held, accIds } = setup({ accounts: 1 });
  held.add(accIds[0]);
  await scheduler.tick();
  assert.equal(calls.length, 0);
  held.delete(accIds[0]);
  await scheduler.tick();
  assert.equal(calls.length, 1);
});

test("job is requeued even when the account write fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse sched "));
  const real = createJsonStore(path.join(dir, "a.json"), []);
  let fail = false;
  const flaky = {
    read: real.read,
    write: (v) => {
      if (fail) throw Object.assign(new Error("EPERM: rename"), { code: "EPERM" });
      real.write(v);
    },
    update(fn) {
      const next = fn(real.read());
      this.write(next);
      return next;
    },
  };
  const accounts = createAccountService({ store: flaky, profilesDir: dir });
  const jobs = createJobService({ store: createJsonStore(path.join(dir, "j.json"), []) });
  const acc = accounts.create("A");
  accounts.setState(acc.id, "ready");
  const [job] = jobs.enqueue({ type: "image", prompt: "x" });
  let resolveRun;
  const scheduler = createScheduler({
    accounts, jobs, getSettings: () => normalizeSettings({ delayMinSec: 0, delayMaxSec: 0 }),
    runJob: () => new Promise((r) => (resolveRun = r)), driver: { close: async () => {} }, tickMs: 1_000_000,
  });
  await scheduler.tick();
  fail = true;
  resolveRun({ ok: false, code: "LIMIT", message: "hết lượt" });
  await scheduler.whenIdle();
  assert.equal(jobs.get(job.id).status, "queued");
});
