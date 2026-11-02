import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestApp } from "./helpers/testApp.js";
import { makeFixtureDir, makeImage } from "./helpers/fixtures.js";
import { createFakeDriver } from "../src/muse/fakeDriver.js";
import { localDate } from "../src/util.js";
import { notifyChange } from "../src/events.js";
import http from "node:http";

let pngBytes;
before(async () => {
  const dir = await makeFixtureDir();
  pngBytes = fs.readFileSync(await makeImage(dir, "a.png", { width: 32, height: 32 }));
});

async function upload(base, files) {
  const form = new FormData();
  for (const f of files) form.append("files", new Blob([f.bytes], { type: f.type }), f.name);
  const res = await fetch(`${base}/api/uploads`, { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}

test("GET /api/state shape", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const { status, body } = await app.api("GET", "/api/state");
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["accounts", "jobs", "scheduler", "settings"]);
  assert.equal(body.settings.concurrency, 3);
  assert.deepEqual(body.scheduler, { paused: false, running: 0, waiting: null });
});

test("POST /api/jobs validation returns Vietnamese 400", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const r = await app.api("POST", "/api/jobs", { type: "video", prompt: "" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "Bạn chưa nhập prompt");
  const ok = await app.api("POST", "/api/jobs", { type: "video", prompt: "mèo", durationSec: 15, count: 2 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.length, 2);
});

test("POST /api/jobs/bulk makes one job per non-empty line", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const r = await app.api("POST", "/api/jobs/bulk", { lines: "a\r\n\n  b  \n", type: "image" });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.map((j) => j.prompt).sort(), ["a", "b"]);
  const empty = await app.api("POST", "/api/jobs/bulk", { lines: " \n ", type: "image" });
  assert.equal(empty.status, 400);
});

test("refImages outside uploads are rejected", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const r = await app.api("POST", "/api/jobs", { type: "image", prompt: "x", refImages: ["C:\\Windows\\win.ini"] });
  assert.equal(r.status, 400);
  const sneaky = await app.api("POST", "/api/jobs", {
    type: "image", prompt: "x", refImages: [path.join(app.paths.uploads, "..", "data", "jobs.json")],
  });
  assert.equal(sneaky.status, 400);
  assert.equal(app.jobs.list().length, 0);
});

test("upload accepts png and the path works as a reference", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const r = await upload(app.base, [{ bytes: pngBytes, type: "image/png", name: "mèo cam.png" }]);
  assert.equal(r.status, 201);
  assert.equal(r.body.length, 1);
  assert.ok(fs.existsSync(r.body[0].path));
  assert.ok(r.body[0].path.startsWith(app.paths.uploads));
  assert.equal((await fetch(app.base + r.body[0].url)).status, 200);
  const job = await app.api("POST", "/api/jobs", { type: "image", prompt: "x", refImages: [r.body[0].path] });
  assert.equal(job.status, 201);
});

test("upload rejects pdf, oversize, and 10 files", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const pdf = await upload(app.base, [{ bytes: Buffer.from("%PDF-1.4"), type: "application/pdf", name: "a.pdf" }]);
  assert.equal(pdf.status, 400);
  assert.match(pdf.body.error, /JPG, PNG hoặc WEBP/);
  const big = await upload(app.base, [{ bytes: Buffer.alloc(21 * 1024 * 1024), type: "image/png", name: "big.png" }]);
  assert.equal(big.status, 400);
  const many = await upload(app.base, Array.from({ length: 10 }, (_, i) => ({ bytes: pngBytes, type: "image/png", name: `${i}.png` })));
  assert.equal(many.status, 400);
  assert.equal(fs.readdirSync(app.paths.uploads).length, 0);
});

test("open window / delete on a busy account → 409", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const acc = (await app.api("POST", "/api/accounts", { name: "A" })).body;
  app.accounts.setState(acc.id, "ready");
  await app.api("POST", "/api/jobs", { type: "image", prompt: "x" });
  await app.scheduler.tick();
  assert.equal(app.pending.length, 1);
  assert.equal((await app.api("POST", `/api/accounts/${acc.id}/open`)).status, 409);
  assert.equal((await app.api("DELETE", `/api/accounts/${acc.id}`)).status, 409);
  const state = (await app.api("GET", "/api/state")).body;
  assert.equal(state.accounts[0].busy, true);
});

test("create account opens a login window; verify sets ready", async (t) => {
  const driver = createFakeDriver(() => ({ media: [], replyText: "" }), { loggedIn: true });
  const app = await startTestApp({ driver });
  t.after(app.close);
  const created = await app.api("POST", "/api/accounts", { name: "Tài khoản 1" });
  assert.equal(created.status, 201);
  assert.equal(created.body.state, "needs_login");
  assert.deepEqual(driver.opened, [created.body.id]);
  const verified = await app.api("POST", `/api/accounts/${created.body.id}/verify`);
  assert.equal(verified.body.state, "ready");
  assert.ok(driver.closed.includes(created.body.id));
});

test("verify keeps needs_login when not logged in; unknown id → 404", async (t) => {
  const driver = createFakeDriver(() => ({ media: [], replyText: "" }), { loggedIn: false });
  const app = await startTestApp({ driver });
  t.after(app.close);
  const acc = (await app.api("POST", "/api/accounts", { name: "A" })).body;
  assert.equal((await app.api("POST", `/api/accounts/${acc.id}/verify`)).body.state, "needs_login");
  assert.equal((await app.api("POST", "/api/accounts/acc_nope/verify")).status, 404);
});

test("patch, delete account and settings round-trip", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const acc = (await app.api("POST", "/api/accounts", { name: "A" })).body;
  assert.equal((await app.api("PATCH", `/api/accounts/${acc.id}`, { name: "B", enabled: false })).body.name, "B");
  assert.equal((await app.api("DELETE", `/api/accounts/${acc.id}`)).status, 204);
  const s = await app.api("PUT", "/api/settings", { concurrency: 5 });
  assert.equal(s.body.concurrency, 5);
  assert.equal((await app.api("GET", "/api/settings")).body.concurrency, 5);
});

test("queue pause/resume and job cancel/retry/delete", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  await app.api("POST", "/api/queue/pause");
  assert.equal((await app.api("GET", "/api/state")).body.scheduler.paused, true);
  await app.api("POST", "/api/queue/resume");
  const [job] = (await app.api("POST", "/api/jobs", { type: "image", prompt: "x" })).body;
  assert.equal((await app.api("POST", `/api/jobs/${job.id}/cancel`)).body.status, "cancelled");
  assert.equal((await app.api("POST", `/api/jobs/${job.id}/retry`)).body.status, "queued");
  assert.equal((await app.api("DELETE", `/api/jobs/${job.id}`)).status, 204);
});

test("open-folder outside downloads → 400, inside → opens", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  assert.equal((await app.api("POST", "/api/open-folder", { path: "C:\\Windows" })).status, 400);
  const file = path.join(app.paths.downloads, "x.mp4");
  fs.writeFileSync(file, "x");
  assert.equal((await app.api("POST", "/api/open-folder", { path: file })).status, 204);
  assert.deepEqual(app.opened, [file]);
});

test("SSE sends a state event after a change", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const controller = new AbortController();
  const res = await fetch(`${app.base}/api/events`, { signal: controller.signal });
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const readUntil = async (n) => {
    while ((text.match(/event: state/g) || []).length < n) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
  };
  await readUntil(1);
  await app.api("POST", "/api/accounts", { name: "A" });
  await readUntil(2);
  assert.match(text.split("event: state").pop(), /"name":"A"/);
  controller.abort();
});

test("library lists done outputs with /files urls that serve the file", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const [job] = app.jobs.enqueue({ type: "image", prompt: "x" });
  const dir = path.join(app.paths.downloads, localDate(new Date()));
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${job.id}_1.webp`);
  fs.writeFileSync(out, pngBytes);
  app.jobs.update(job.id, { status: "done", outputs: [out] });
  const lib = (await app.api("GET", "/api/library")).body;
  assert.equal(lib.length, 1);
  assert.equal(lib[0].items[0].kind, "image");
  assert.equal(lib[0].items[0].url, `/files/${localDate(new Date())}/${job.id}_1.webp`);
  const res = await fetch(app.base + lib[0].items[0].url);
  assert.equal(res.status, 200);
  const ref = await app.api("POST", `/api/library/${job.id}/use-as-ref`, { index: 0 });
  assert.equal(ref.status, 201);
  assert.ok(ref.body.path.startsWith(app.paths.uploads));
  assert.ok(fs.existsSync(ref.body.path));
});

function rawRequest(base, { method = "GET", path: p, headers }) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path: p, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

test("requests from foreign hosts or origins are refused", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const port = new URL(app.base).port;
  assert.equal(await rawRequest(app.base, { path: "/api/state", headers: { host: `evil.example:${port}` } }), 403);
  assert.equal(await rawRequest(app.base, {
    method: "POST", path: "/api/queue/pause", headers: { host: `127.0.0.1:${port}`, origin: "https://evil.example" },
  }), 403);
  assert.equal(app.scheduler.status().paused, false);
  assert.equal(await rawRequest(app.base, { path: "/api/state", headers: { host: `localhost:${port}` } }), 200);
  assert.equal(await rawRequest(app.base, {
    method: "POST", path: "/api/queue/pause", headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` },
  }), 204);
});

test("SSE survives a failing state read", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const controller = new AbortController();
  const res = await fetch(`${app.base}/api/events`, { signal: controller.signal });
  const reader = res.body.getReader();
  await reader.read();
  const original = app.accounts.list;
  app.accounts.list = () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); };
  notifyChange();
  await new Promise((r) => setTimeout(r, 400));
  app.accounts.list = original;
  assert.equal((await app.api("GET", "/api/state")).status, 200);
  controller.abort();
});
