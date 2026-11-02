import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { probe, targetSize, extractLastFrame, finalizeVideo, FfmpegError } from "../src/media/ffmpeg.js";
import { makeFixtureDir, makeClip } from "./helpers/fixtures.js";

let dir, landscape, landscape2, portrait;

before(async () => {
  dir = await makeFixtureDir();
  landscape = await makeClip(dir, "land 1.mp4", { width: 1152, height: 768 });
  landscape2 = await makeClip(dir, "land 2.mp4", { width: 1152, height: 768 });
  portrait = await makeClip(dir, "port.mp4", { width: 768, height: 1152 });
});

const near = (a, b, tol = 0.15) => Math.abs(a - b) < tol;

test("targetSize", () => {
  assert.deepEqual(targetSize(1152, 768, true), { width: 1620, height: 1080 });
  assert.deepEqual(targetSize(1280, 720, true), { width: 1920, height: 1080 });
  assert.deepEqual(targetSize(768, 1152, true), { width: 1080, height: 1620 });
  assert.deepEqual(targetSize(1000, 1000, true), { width: 1080, height: 1080 });
  assert.deepEqual(targetSize(1152, 768, false), { width: 1152, height: 768 });
});

test("probe reads size, duration, fps, audio", async () => {
  const p = await probe(landscape);
  assert.equal(p.width, 1152);
  assert.equal(p.height, 768);
  assert.equal(p.hasAudio, true);
  assert.equal(p.fps, 24);
  assert.ok(near(p.duration, 10), String(p.duration));
});

test("extractLastFrame writes a PNG of the same size", async () => {
  const out = path.join(dir, "last frame.png");
  await extractLastFrame(landscape, out);
  const p = await probe(out);
  assert.equal(p.width, 1152);
  assert.equal(p.height, 768);
});

test("finalizeVideo: 2 clips → 15 s, 1080p, with audio", async () => {
  const out = path.join(dir, "final 15.mp4");
  const r = await finalizeVideo({ inputs: [landscape, landscape2], output: out, trimSec: 15, upscale1080: true });
  assert.equal(r.width, 1620);
  assert.equal(r.height, 1080);
  assert.ok(near(r.duration, 15), String(r.duration));
  assert.equal((await probe(out)).hasAudio, true);
});

test("finalizeVideo: single clip trimmed to 4 s, no upscale", async () => {
  const out = path.join(dir, "final 4.mp4");
  const r = await finalizeVideo({ inputs: [landscape], output: out, trimSec: 4, upscale1080: false });
  assert.equal(r.width, 1152);
  assert.equal(r.height, 768);
  assert.ok(near(r.duration, 4), String(r.duration));
});

test("finalizeVideo: portrait upscales to 1080x1620", async () => {
  const out = path.join(dir, "final portrait.mp4");
  const r = await finalizeVideo({ inputs: [portrait], output: out, trimSec: 10, upscale1080: true });
  assert.equal(r.width, 1080);
  assert.equal(r.height, 1620);
});

test("finalizeVideo mixes sizes and silent clip", async () => {
  const silent = await makeClip(dir, "silent.mp4", { width: 1280, height: 720, audio: false });
  const out = path.join(dir, "final mixed.mp4");
  const r = await finalizeVideo({ inputs: [landscape, silent], output: out, trimSec: 20, upscale1080: false });
  assert.equal(r.width, 1152);
  assert.equal(r.height, 768);
  assert.ok(near(r.duration, 20), String(r.duration));
  assert.equal((await probe(out)).hasAudio, true);
});

test("finalizeVideo rejects with FfmpegError on missing input", async () => {
  await assert.rejects(
    finalizeVideo({ inputs: [path.join(dir, "nope.mp4")], output: path.join(dir, "x.mp4"), trimSec: 5, upscale1080: false }),
    FfmpegError,
  );
  assert.equal(fs.existsSync(path.join(dir, "x.mp4")), false);
});
