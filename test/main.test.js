import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/main.js";
import { createFakeDriver } from "../src/muse/fakeDriver.js";

test("startServer serves the UI, recovers interrupted jobs, and closes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse main "));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  const stuck = {
    id: "job_stuck", type: "image", prompt: "x", refImages: [], durationSec: null, upscale1080: null,
    status: "running", progress: { clip: 1, totalClips: 1 }, accountId: "acc_gone", attempts: 0,
    rawFiles: [], outputs: [], replyText: null, error: null, createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z",
  };
  fs.writeFileSync(path.join(root, "data", "jobs.json"), JSON.stringify([stuck]));

  const driver = createFakeDriver(() => ({ media: [], replyText: "" }));
  const server = await startServer({ root, port: 0, driver });
  try {
    const state = await (await fetch(`${server.url}/api/state`)).json();
    assert.equal(state.jobs[0].status, "queued");
    assert.equal(state.jobs[0].accountId, null);
    const html = await (await fetch(server.url)).text();
    assert.match(html, /Muse Manager/);
    for (const dir of ["profiles", "uploads", path.join("downloads", "raw"), path.join("data", "errors")]) {
      assert.ok(fs.existsSync(path.join(root, dir)), dir);
    }
  } finally {
    await server.close();
  }
});
