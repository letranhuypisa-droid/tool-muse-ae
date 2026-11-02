import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { runCli } from "../src/cli.js";
import { createFakeDriver } from "../src/muse/fakeDriver.js";
import { createRunner } from "../src/runner.js";
import { startTestApp } from "./helpers/testApp.js";
import { makeFixtureDir, makeImage } from "./helpers/fixtures.js";

let fx, refPng;

before(async () => {
  fx = await makeFixtureDir();
  refPng = await makeImage(fx, "ref ảnh.png", { width: 48, height: 32 });
});

// Chạy CLI và gom lại những gì nó in ra.
async function cli(argv, opts = {}) {
  const out = [];
  const err = [];
  const code = await runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s), pollMs: 50, ...opts });
  return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) };
}

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test("status lists accounts and queue counts", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const acc = app.accounts.create("Tài khoản 1");
  app.accounts.setState(acc.id, "ready");
  app.jobs.enqueue({ type: "image", prompt: "x", count: 2 });
  const r = await cli(["status", "--json"], { baseUrl: app.base });
  assert.equal(r.code, 0);
  const s = r.json();
  assert.equal(s.accounts[0].name, "Tài khoản 1");
  assert.equal(s.accounts[0].state, "ready");
  assert.equal(s.queue.queued, 2);
  const text = await cli(["status"], { baseUrl: app.base });
  assert.match(text.out, /Tài khoản 1.*Sẵn sàng/);
  assert.match(text.out, /2 chờ/);
});

test("commands report a friendly error when the tool is not running", async () => {
  const r = await cli(["status"], { baseUrl: `http://127.0.0.1:${await freePort()}` });
  assert.equal(r.code, 2);
  assert.match(r.err, /Tool chưa chạy/);
  assert.match(r.err, /npm run muse -- start/);
});

test("add uploads references and queues a video", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const r = await cli(
    ["add", "--prompt", "Trận Bạch Đằng\nlúc bình minh", "--duration", "25", "--ref", refPng, "--no-1080p", "--count", "2", "--json"],
    { baseUrl: app.base },
  );
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().jobs.length, 2);
  const jobs = app.jobs.list();
  assert.equal(jobs.length, 2);
  for (const j of jobs) {
    assert.equal(j.type, "video");
    assert.equal(j.prompt, "Trận Bạch Đằng\nlúc bình minh");
    assert.equal(j.durationSec, 25);
    assert.equal(j.upscale1080, false);
    assert.equal(j.refImages.length, 1);
    assert.ok(j.refImages[0].startsWith(app.paths.uploads));
    assert.ok(fs.existsSync(j.refImages[0]));
  }
});

test("add reports validation errors without queueing", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const bad = await cli(["add", "--prompt", "x", "--duration", "99"], { baseUrl: app.base });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Thời lượng/);
  const missing = await cli(["add", "--prompt", "x", "--ref", path.join(fx, "khong-co.png")], { baseUrl: app.base });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /Không tìm thấy ảnh tham chiếu/);
  const noPrompt = await cli(["add"], { baseUrl: app.base });
  assert.equal(noPrompt.code, 1);
  assert.equal(app.jobs.list().length, 0);
});

test("add --wait returns output paths once jobs finish", async (t) => {
  const pngBytes = fs.readFileSync(refPng);
  const driver = createFakeDriver(() => ({ media: [{ kind: "image", ext: "png", bytes: pngBytes }], replyText: "Xong" }));
  const app = await startTestApp({
    driver, tickMs: 50,
    makeRunJob: ({ jobs, paths, settings }) => createRunner({ driver, jobs, paths, getSettings: () => settings.get() }).runJob,
  });
  t.after(app.close);
  app.settings.save({ delayMinSec: 0, delayMaxSec: 0 });
  const acc = app.accounts.create("A");
  app.accounts.setState(acc.id, "ready");
  app.scheduler.start();
  const r = await cli(["add", "--type", "image", "--prompt", "bãi cọc", "--wait", "--json"], { baseUrl: app.base });
  assert.equal(r.code, 0, r.err);
  const [job] = r.json().jobs;
  assert.equal(job.status, "done");
  assert.equal(job.outputs.length, 1);
  assert.ok(fs.existsSync(job.outputs[0]));
});

test("wait exits non-zero when a job fails and prints its error", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const [job] = app.jobs.enqueue({ type: "image", prompt: "x" });
  app.jobs.update(job.id, { status: "failed", error: "Muse chưa trả kết quả" });
  const r = await cli(["wait", job.id], { baseUrl: app.base });
  assert.equal(r.code, 1);
  assert.match(r.out, /Lỗi.*Muse chưa trả kết quả/);
});

test("batch json queues each scene with refs relative to the file", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const dir = fs.mkdtempSync(path.join(fx, "batch "));
  fs.copyFileSync(refPng, path.join(dir, "canh 1.png"));
  const file = path.join(dir, "scenes.json");
  fs.writeFileSync(file, JSON.stringify([
    { prompt: "Cảnh 1: bãi cọc", type: "image" },
    { prompt: "Cảnh 2: thuyền giặc mắc cọc", duration: 20, refs: ["canh 1.png"] },
  ]));
  const r = await cli(["batch", file, "--json"], { baseUrl: app.base });
  assert.equal(r.code, 0, r.err);
  const jobs = app.jobs.list().reverse();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].type, "image");
  assert.equal(jobs[1].type, "video");
  assert.equal(jobs[1].durationSec, 20);
  assert.equal(jobs[1].refImages.length, 1);
});

test("batch txt queues one job per line using the command-line options", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const file = path.join(fs.mkdtempSync(path.join(fx, "batch ")), "prompts.txt");
  fs.writeFileSync(file, "cảnh một\r\n\r\ncảnh hai\n");
  const r = await cli(["batch", file, "--duration", "15", "--json"], { baseUrl: app.base });
  assert.equal(r.code, 0, r.err);
  const jobs = app.jobs.list();
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((j) => j.durationSec === 15));
});

test("batch refuses everything when one ref file is missing", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const file = path.join(fs.mkdtempSync(path.join(fx, "batch ")), "scenes.json");
  fs.writeFileSync(file, JSON.stringify([{ prompt: "a" }, { prompt: "b", refs: ["khong-co.png"] }]));
  const r = await cli(["batch", file], { baseUrl: app.base });
  assert.equal(r.code, 1);
  assert.match(r.err, /Không tìm thấy ảnh tham chiếu/);
  assert.equal(app.jobs.list().length, 0);
});

test("accounts add then verify by name", async (t) => {
  const driver = createFakeDriver(() => ({ media: [], replyText: "" }), { loggedIn: true });
  const app = await startTestApp({ driver });
  t.after(app.close);
  const added = await cli(["accounts", "add", "Kênh lịch sử 2"], { baseUrl: app.base });
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /đăng nhập muse\.ai/);
  assert.equal(driver.opened.length, 1);
  const verified = await cli(["accounts", "verify", "Kênh lịch sử 2"], { baseUrl: app.base });
  assert.equal(verified.code, 0, verified.err);
  assert.match(verified.out, /Sẵn sàng/);
});

test("start does nothing when the tool already runs", async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const spawned = [];
  const r = await cli(["start"], { baseUrl: app.base, spawnServer: (args) => spawned.push(args) });
  assert.equal(r.code, 0);
  assert.match(r.out, /đã chạy sẵn/);
  assert.equal(spawned.length, 0);
});

test("start launches the tool without opening a browser and waits until it answers", async (t) => {
  const port = await freePort();
  let fakeServer;
  const spawned = [];
  const spawnServer = (args) => {
    spawned.push(args);
    fakeServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accounts: [], jobs: [], settings: {}, scheduler: {} }));
    });
    setTimeout(() => fakeServer.listen(port, "127.0.0.1"), 200);
  };
  t.after(() => new Promise((r) => (fakeServer ? fakeServer.close(r) : r())));
  const r = await cli(["start"], { baseUrl: `http://127.0.0.1:${port}`, spawnServer });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(spawned, [["--no-open"]]);
  assert.match(r.out, /Đã bật tool/);
});

test("help lists the commands", async () => {
  const r = await cli(["help"]);
  assert.equal(r.code, 0);
  for (const cmd of ["start", "status", "add", "batch", "wait", "jobs", "accounts"]) assert.match(r.out, new RegExp(cmd));
});
