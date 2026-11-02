import { test } from "node:test";
import assert from "node:assert/strict";
import { launchOptions } from "../src/muse/driver.js";

test("hidden jobs use a real Chrome window placed off-screen (muse.ai rejects headless sends)", () => {
  const o = launchOptions({ hidden: true, hiddenMode: "offscreen" });
  assert.equal(o.headless, false);
  assert.ok(o.args.some((a) => a.startsWith("--window-position=-")), o.args.join(" "));
  assert.ok(o.args.includes("--disable-renderer-backgrounding"));
  assert.ok(o.args.includes("--disable-backgrounding-occluded-windows"));
});

test("login windows are normal visible windows", () => {
  const o = launchOptions({ hidden: false, hiddenMode: "offscreen" });
  assert.equal(o.headless, false);
  assert.ok(!o.args.some((a) => a.startsWith("--window-position")));
});

test("tests can still run truly headless", () => {
  const o = launchOptions({ hidden: true, hiddenMode: "headless" });
  assert.equal(o.headless, true);
  assert.deepEqual(o.args, []);
});
