import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobService } from "../src/jobs.js";
import { createJsonStore } from "../src/store.js";
import { bus } from "../src/events.js";
import { ValidationError } from "../src/util.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse jobs "));
  let t = Date.UTC(2026, 10, 2, 2, 0, 0);
  const jobs = createJobService({
    store: createJsonStore(path.join(dir, "jobs.json"), []),
    now: () => new Date((t += 1000)),
  });
  return { jobs, dir };
}

test("enqueue count=3 makes 3 queued jobs", () => {
  const { jobs } = setup();
  const made = jobs.enqueue({ type: "video", prompt: "mèo", count: 3 });
  assert.equal(made.length, 3);
  for (const j of made) {
    assert.equal(j.status, "queued");
    assert.equal(j.durationSec, 10);
    assert.equal(j.upscale1080, true);
    assert.deepEqual(j.rawFiles, []);
    assert.deepEqual(j.outputs, []);
    assert.equal(j.attempts, 0);
    assert.equal(j.accountId, null);
  }
  assert.equal(new Set(made.map((j) => j.id)).size, 3);
});

test("image jobs have no duration or upscale", () => {
  const { jobs } = setup();
  const [j] = jobs.enqueue({ type: "image", prompt: "mèo", durationSec: 30, upscale1080: true });
  assert.equal(j.durationSec, null);
  assert.equal(j.upscale1080, null);
});

test("enqueue validation", () => {
  const { jobs } = setup();
  const bad = [
    { type: "video", prompt: "   " },
    { type: "gif", prompt: "x" },
    { type: "video", prompt: "x", durationSec: 61 },
    { type: "video", prompt: "x", refImages: Array(10).fill("a.png") },
    { type: "video", prompt: "x", count: 0 },
    { type: "video", prompt: "x", count: 21 },
    { type: "video", prompt: "x".repeat(4001) },
    { type: "video", prompt: "x", upscale1080: "yes" },
  ];
  for (const input of bad) assert.throws(() => jobs.enqueue(input), ValidationError, JSON.stringify(input).slice(0, 60));
  assert.equal(jobs.list().length, 0);
});

test("enqueue keeps multi-line prompt", () => {
  const { jobs } = setup();
  const [j] = jobs.enqueue({ type: "image", prompt: "  dòng 1\ndòng 2  " });
  assert.equal(j.prompt, "dòng 1\ndòng 2");
});

test("nextQueued is FIFO and list is newest first", () => {
  const { jobs } = setup();
  const [a] = jobs.enqueue({ type: "image", prompt: "a" });
  const [b] = jobs.enqueue({ type: "image", prompt: "b" });
  assert.equal(jobs.nextQueued().id, a.id);
  assert.deepEqual(jobs.list().map((j) => j.id), [b.id, a.id]);
  jobs.update(a.id, { status: "running" });
  assert.equal(jobs.nextQueued().id, b.id);
});

test("recoverOnStartup requeues running/postprocessing and keeps rawFiles", () => {
  const { jobs } = setup();
  const [a, b, c] = jobs.enqueue({ type: "video", prompt: "x", count: 3, durationSec: 20 });
  jobs.update(a.id, { status: "running", accountId: "acc_1", rawFiles: ["clip1.mp4"] });
  jobs.update(b.id, { status: "postprocessing", accountId: "acc_2" });
  jobs.update(c.id, { status: "done" });
  assert.equal(jobs.recoverOnStartup(), 2);
  assert.equal(jobs.get(a.id).status, "queued");
  assert.equal(jobs.get(a.id).accountId, null);
  assert.deepEqual(jobs.get(a.id).rawFiles, ["clip1.mp4"]);
  assert.equal(jobs.get(b.id).status, "queued");
  assert.equal(jobs.get(c.id).status, "done");
});

test("cancel/retry/remove state rules", () => {
  const { jobs } = setup();
  const [a] = jobs.enqueue({ type: "image", prompt: "x" });
  assert.equal(jobs.cancel(a.id).status, "cancelled");
  assert.throws(() => jobs.cancel(a.id), ValidationError);
  jobs.update(a.id, { attempts: 2, error: "boom" });
  const r = jobs.retry(a.id);
  assert.equal(r.status, "queued");
  assert.equal(r.attempts, 0);
  assert.equal(r.error, null);
  assert.throws(() => jobs.retry(a.id), ValidationError);
  jobs.update(a.id, { status: "running" });
  assert.throws(() => jobs.remove(a.id), ValidationError);
  jobs.update(a.id, { status: "done" });
  jobs.remove(a.id);
  assert.equal(jobs.get(a.id), undefined);
});

test("update stamps updatedAt and unknown id throws", () => {
  const { jobs } = setup();
  const [a] = jobs.enqueue({ type: "image", prompt: "x" });
  const u = jobs.update(a.id, { replyText: "hi" });
  assert.notEqual(u.updatedAt, a.updatedAt);
  assert.throws(() => jobs.update("job_nope", {}), /Không tìm thấy/);
});

test("mutations emit change", () => {
  const { jobs } = setup();
  let n = 0;
  const on = () => n++;
  bus.on("change", on);
  jobs.enqueue({ type: "image", prompt: "x" });
  bus.off("change", on);
  assert.ok(n > 0);
});
