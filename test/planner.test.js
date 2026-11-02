import { test } from "node:test";
import assert from "node:assert/strict";
import { planClips } from "../src/planner.js";
import { slugify, ValidationError } from "../src/util.js";

test("planClips", () => {
  assert.deepEqual(planClips(1), { totalClips: 1, trimSec: 1 });
  assert.deepEqual(planClips(10), { totalClips: 1, trimSec: 10 });
  assert.deepEqual(planClips(11), { totalClips: 2, trimSec: 11 });
  assert.deepEqual(planClips(60), { totalClips: 6, trimSec: 60 });
  for (const bad of [0, 61, 2.5, NaN, "10", undefined]) {
    assert.throws(() => planClips(bad), ValidationError, String(bad));
  }
});

test("slugify strips Vietnamese diacritics, emoji, Windows-invalid chars, newlines", () => {
  assert.equal(slugify("Mèo cam ngồi bên cửa sổ"), "meo-cam-ngoi-ben-cua-so");
  assert.equal(slugify("Đường phố 🌧️ <đêm>:\n\"mưa\"?*|"), "duong-pho-dem-mua");
  assert.equal(slugify("a".repeat(100)).length, 40);
  assert.equal(slugify("🔥🔥"), "untitled");
  assert.equal(slugify("abc-" + "d".repeat(36) + " xyz"), "abc-" + "d".repeat(36));
});
