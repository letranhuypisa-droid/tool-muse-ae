import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRunner } from "../src/runner.js";
import { createFakeDriver } from "../src/muse/fakeDriver.js";
import { MuseError } from "../src/muse/errors.js";
import { createJobService } from "../src/jobs.js";
import { createJsonStore } from "../src/store.js";
import { getPaths, ensureDirs, normalizeSettings } from "../src/config.js";
import { probe } from "../src/media/ffmpeg.js";
import { localDate } from "../src/util.js";
import { makeFixtureDir, makeClip, makeImage } from "./helpers/fixtures.js";

let fx, clipBytes, pngBytes, refPng;

before(async () => {
  fx = await makeFixtureDir();
  clipBytes = fs.readFileSync(await makeClip(fx, "clip.mp4", { width: 1152, height: 768 }));
  refPng = await makeImage(fx, "ref.png", { width: 1152, height: 768 });
  pngBytes = fs.readFileSync(refPng);
});

function setup(handler) {
  const root = fs.mkdtempSync(path.join(fx, "root "));
  const paths = getPaths(root);
  ensureDirs(paths);
  const jobs = createJobService({ store: createJsonStore(path.join(paths.data, "jobs.json"), []) });
  const driver = createFakeDriver(handler);
  const runner = createRunner({ driver, jobs, paths, getSettings: () => normalizeSettings({}) });
  const account = { id: "acc_1" };
  const run = (job, signal = new AbortController().signal) => runner.runJob(jobs.get(job.id), account, { signal });
  return { paths, jobs, driver, run };
}

const video = () => ({ media: [{ kind: "video", ext: "mp4", bytes: clipBytes }], replyText: "Xong rồi" });
const image = (n = 1) => ({
  media: Array.from({ length: n }, () => ({ kind: "image", ext: "webp", bytes: pngBytes })),
  replyText: "Xong rồi",
});

test("image job saves every image and marks done", async () => {
  const { jobs, run, driver, paths } = setup(() => image(2));
  const [job] = jobs.enqueue({ type: "image", prompt: "mèo", refImages: [refPng] });
  assert.deepEqual(await run(job), { ok: true });
  const done = jobs.get(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.outputs.length, 2);
  for (const out of done.outputs) {
    assert.ok(fs.existsSync(out));
    assert.ok(out.startsWith(path.join(paths.downloads, localDate(new Date()))));
    assert.ok(out.endsWith(".webp"));
  }
  assert.equal(driver.calls[0].message, "Tạo ngay 1 ảnh, không cần hỏi lại: mèo Dùng ảnh đính kèm làm ảnh tham chiếu.");
  assert.deepEqual(driver.calls[0].files, [refPng]);
});

test("video 15 s 1080p: two turns, second attaches last frame", async () => {
  const { jobs, run, driver } = setup(() => video());
  const [job] = jobs.enqueue({ type: "video", prompt: "Mèo cam", durationSec: 15, refImages: [refPng] });
  assert.deepEqual(await run(job), { ok: true });
  assert.equal(driver.calls.length, 2);
  assert.deepEqual(driver.calls[0].files, [refPng]);
  assert.ok(driver.calls[0].message.startsWith("Tạo ngay 1 video"));
  assert.ok(driver.calls[1].files[0].endsWith("_clip1_last.png"));
  assert.ok(driver.calls[1].message.startsWith("Dùng ảnh đính kèm làm khung hình mở đầu"));
  const done = jobs.get(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.rawFiles.length, 2);
  assert.deepEqual(done.progress, { clip: 2, totalClips: 2 });
  assert.match(path.basename(done.outputs[0]), new RegExp(`^${job.id}_meo-cam\\.mp4$`));
  const p = await probe(done.outputs[0]);
  assert.equal(p.width, 1620);
  assert.equal(p.height, 1080);
  assert.ok(Math.abs(p.duration - 15) < 0.15, String(p.duration));
});

test("video without refs sends no attachment on clip 1", async () => {
  const { jobs, run, driver } = setup(() => video());
  const [job] = jobs.enqueue({ type: "video", prompt: "x", durationSec: 5, upscale1080: false });
  await run(job);
  assert.deepEqual(driver.calls[0].files, []);
  assert.equal(driver.calls[0].message, "Tạo ngay 1 video, không cần hỏi lại: x");
  assert.equal((await probe(jobs.get(job.id).outputs[0])).width, 1152);
});

test("resume: job with 1 raw clip only runs clip 2", async () => {
  const { jobs, run, driver, paths } = setup(() => video());
  const [job] = jobs.enqueue({ type: "video", prompt: "x", durationSec: 20 });
  const raw = path.join(paths.raw, `${job.id}_clip1.mp4`);
  fs.writeFileSync(raw, clipBytes);
  jobs.update(job.id, { rawFiles: [raw] });
  await run(job);
  assert.equal(driver.calls.length, 1);
  assert.equal(jobs.get(job.id).status, "done");
});

test("raw clips complete → only post-processing runs", async () => {
  const { jobs, run, driver, paths } = setup(() => video());
  const [job] = jobs.enqueue({ type: "video", prompt: "x", durationSec: 8 });
  const raw = path.join(paths.raw, `${job.id}_clip1.mp4`);
  fs.writeFileSync(raw, clipBytes);
  jobs.update(job.id, { rawFiles: [raw] });
  await run(job);
  assert.equal(driver.calls.length, 0);
  assert.equal(jobs.get(job.id).status, "done");
});

test("no media + limit reply → LIMIT, rawFiles kept", async () => {
  let n = 0;
  const { jobs, run } = setup(() => (n++ === 0 ? video() : { media: [], replyText: "You've reached your daily limit" }));
  const [job] = jobs.enqueue({ type: "video", prompt: "x", durationSec: 20 });
  const outcome = await run(job);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "LIMIT");
  assert.equal(outcome.replyText, "You've reached your daily limit");
  assert.equal(jobs.get(job.id).rawFiles.length, 1);
});

test("no media + chatty reply → TRANSIENT with replyText", async () => {
  const { jobs, run } = setup(() => ({ media: [], replyText: "Bạn muốn mèo màu gì?" }));
  const [job] = jobs.enqueue({ type: "video", prompt: "x" });
  const outcome = await run(job);
  assert.equal(outcome.code, "TRANSIENT");
  assert.equal(outcome.replyText, "Bạn muốn mèo màu gì?");
});

test("refusal reply → REFUSED", async () => {
  const { jobs, run } = setup(() => ({ media: [], replyText: "I can't create that, it goes against our policy" }));
  const [job] = jobs.enqueue({ type: "image", prompt: "x" });
  assert.equal((await run(job)).code, "REFUSED");
});

test("MuseError BROWSER (e.g. profile in use) → TRANSIENT", async () => {
  const { jobs, run } = setup(() => { throw new MuseError("BROWSER", "profile in use"); });
  const [job] = jobs.enqueue({ type: "image", prompt: "x" });
  const outcome = await run(job);
  assert.equal(outcome.code, "TRANSIENT");
  assert.match(outcome.message, /profile in use/);
});

test("MuseError NOT_LOGGED_IN → NOT_LOGGED_IN", async () => {
  const { jobs, run } = setup(() => { throw new MuseError("NOT_LOGGED_IN", "Cần đăng nhập"); });
  const [job] = jobs.enqueue({ type: "image", prompt: "x" });
  assert.equal((await run(job)).code, "NOT_LOGGED_IN");
});

test("ffmpeg failure → FFMPEG, raw clip kept", async () => {
  const { jobs, run } = setup(() => ({ media: [{ kind: "video", ext: "mp4", bytes: Buffer.from("not a video") }], replyText: "" }));
  const [job] = jobs.enqueue({ type: "video", prompt: "x", durationSec: 5 });
  const outcome = await run(job);
  assert.equal(outcome.code, "FFMPEG");
  assert.equal(jobs.get(job.id).rawFiles.length, 1);
});

test("aborted signal stops before the next turn", async () => {
  const controller = new AbortController();
  const { jobs, run, driver } = setup(() => { controller.abort(); return video(); });
  const [job] = jobs.enqueue({ type: "video", prompt: "x", durationSec: 20 });
  const outcome = await run(job, controller.signal);
  assert.equal(outcome.code, "TRANSIENT");
  assert.equal(outcome.message, "Đã hủy");
  assert.equal(driver.calls.length, 1);
});

test("driver.close is always called", async () => {
  const { jobs, run, driver } = setup(() => { throw new Error("boom"); });
  const [job] = jobs.enqueue({ type: "image", prompt: "x" });
  const outcome = await run(job);
  assert.equal(outcome.code, "TRANSIENT");
  assert.deepEqual(driver.closed, ["acc_1"]);
});

test("job cancelled during a turn is not marked done", async () => {
  let jobsRef;
  const { jobs, run } = setup((accountId, req) => {
    const [j] = jobsRef.list();
    jobsRef.update(j.id, { status: "cancelled" });
    return video();
  });
  jobsRef = jobs;
  const [job] = jobs.enqueue({ type: "video", prompt: "x", durationSec: 5 });
  const outcome = await run(job);
  assert.equal(outcome.message, "Đã hủy");
  assert.equal(jobs.get(job.id).status, "cancelled");
  assert.deepEqual(jobs.get(job.id).outputs, []);
});

test("image job cancelled during a turn is not marked done", async () => {
  let jobsRef;
  const { jobs, run } = setup(() => {
    const [j] = jobsRef.list();
    jobsRef.update(j.id, { status: "cancelled" });
    return image();
  });
  jobsRef = jobs;
  const [job] = jobs.enqueue({ type: "image", prompt: "x" });
  await run(job);
  assert.equal(jobs.get(job.id).status, "cancelled");
});

test("undelivered message → TRANSIENT with a clear Vietnamese reason", async () => {
  const { jobs, run } = setup(() => ({ media: [], replyText: "Delivery not confirmed" }));
  const [job] = jobs.enqueue({ type: "image", prompt: "x" });
  const outcome = await run(job);
  assert.equal(outcome.code, "TRANSIENT");
  assert.match(outcome.message, /không nhận tin nhắn/);
});
