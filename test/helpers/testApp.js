import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../../src/server.js";
import { createAccountService } from "../../src/accounts.js";
import { createJobService } from "../../src/jobs.js";
import { createScheduler } from "../../src/scheduler.js";
import { createSettingsService, ensureDirs, getPaths } from "../../src/config.js";
import { createJsonStore } from "../../src/store.js";
import { createFakeDriver } from "../../src/muse/fakeDriver.js";

// Dựng app với dữ liệu trong thư mục tạm; runJob mặc định treo cho tới khi test gọi resolve.
export async function startTestApp({ runJob, driver, opened = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse app "));
  const paths = getPaths(root);
  ensureDirs(paths);
  const settings = createSettingsService(createJsonStore(path.join(paths.data, "settings.json"), {}));
  const accounts = createAccountService({
    store: createJsonStore(path.join(paths.data, "accounts.json"), []),
    profilesDir: paths.profiles,
  });
  const jobs = createJobService({ store: createJsonStore(path.join(paths.data, "jobs.json"), []) });
  const fake = driver ?? createFakeDriver(() => ({ media: [], replyText: "" }));
  const pending = [];
  const scheduler = createScheduler({
    accounts, jobs, getSettings: () => settings.get(), driver: fake, tickMs: 1_000_000,
    runJob: runJob ?? ((job, account, { signal }) => new Promise((resolve) => pending.push({ job, account, signal, resolve }))),
  });
  const app = createApp({ accounts, jobs, scheduler, driver: fake, settings, paths, openPath: (p) => opened.push(p) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const close = async () => {
    scheduler.stop();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  };
  return { base, api, close, paths, accounts, jobs, scheduler, settings, driver: fake, pending, opened };
}
