import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeSettings, createSettingsService, getPaths, ensureDirs } from "../src/config.js";
import { createJsonStore } from "../src/store.js";
import { DEFAULT_TEMPLATES, buildMessage } from "../src/muse/messages.js";

test("normalizeSettings fills defaults", () => {
  const s = normalizeSettings({});
  assert.equal(s.concurrency, 3);
  assert.equal(s.cooldownHours, 24);
  assert.equal(s.delayMinSec, 20);
  assert.equal(s.delayMaxSec, 60);
  assert.equal(s.dailyCapPerAccount, 0);
  assert.equal(s.headless, false);
  assert.equal(s.imageTimeoutMin, 3);
  assert.equal(s.videoTimeoutMin, 6);
  assert.equal(s.maxRetries, 2);
  assert.deepEqual(s.messageTemplates, DEFAULT_TEMPLATES);
});

test("normalizeSettings clamps and repairs", () => {
  const s = normalizeSettings({
    concurrency: 99, delayMinSec: 50, delayMaxSec: 10, maxRetries: -1,
    messageTemplates: { image: "no placeholder" },
  });
  assert.equal(s.concurrency, 8);
  assert.equal(s.delayMaxSec, 50);
  assert.equal(s.maxRetries, 0);
  assert.equal(s.messageTemplates.image, DEFAULT_TEMPLATES.image);
});

test("normalizeSettings ignores garbage types", () => {
  const s = normalizeSettings({ concurrency: "abc", headless: "yes", cooldownHours: null });
  assert.equal(s.concurrency, 3);
  assert.equal(s.headless, false);
  assert.equal(s.cooldownHours, 24);
});

test("settings service saves a patch and keeps other values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse cfg "));
  const svc = createSettingsService(createJsonStore(path.join(dir, "settings.json"), {}));
  assert.equal(svc.get().concurrency, 3);
  const saved = svc.save({ concurrency: 5 });
  assert.equal(saved.concurrency, 5);
  assert.equal(saved.cooldownHours, 24);
  assert.equal(svc.get().concurrency, 5);
});

test("getPaths and ensureDirs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse root "));
  const p = getPaths(root);
  assert.equal(p.raw, path.join(root, "downloads", "raw"));
  assert.equal(p.errors, path.join(root, "data", "errors"));
  ensureDirs(p);
  for (const k of ["data", "profiles", "uploads", "downloads", "raw", "errors"]) {
    assert.ok(fs.existsSync(p[k]), k);
  }
});

test("buildMessage", () => {
  assert.equal(buildMessage(DEFAULT_TEMPLATES, { kind: "image", prompt: "mèo", hasRefs: false }),
    "Tạo ngay 1 ảnh, không cần hỏi lại: mèo");
  assert.equal(buildMessage(DEFAULT_TEMPLATES, { kind: "video", prompt: "mèo", hasRefs: true }),
    "Tạo ngay 1 video, không cần hỏi lại: mèo Dùng ảnh đính kèm làm ảnh tham chiếu.");
  assert.equal(buildMessage(DEFAULT_TEMPLATES, { kind: "continue", prompt: "mèo", hasRefs: true }),
    "Dùng ảnh đính kèm làm khung hình mở đầu, tạo ngay 1 video nối tiếp liền mạch, không cần hỏi lại: mèo");
});
