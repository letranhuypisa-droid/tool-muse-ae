import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccountService } from "../src/accounts.js";
import { createJsonStore } from "../src/store.js";
import { bus } from "../src/events.js";
import { ValidationError } from "../src/util.js";

function setup(start = new Date(2026, 10, 2, 9, 0, 0)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse acc "));
  const clock = { now: start };
  const svc = createAccountService({
    store: createJsonStore(path.join(dir, "accounts.json"), []),
    profilesDir: path.join(dir, "profiles"),
    now: () => clock.now,
  });
  return { svc, clock, dir };
}

test("create account defaults", () => {
  const { svc } = setup();
  const a = svc.create("  Tài khoản 1  ");
  assert.equal(a.name, "Tài khoản 1");
  assert.equal(a.state, "needs_login");
  assert.equal(a.enabled, true);
  assert.deepEqual(a.usage, { date: "2026-11-02", jobs: 0 });
  assert.equal(a.cooldownUntil, null);
  assert.equal(a.restUntil, null);
  assert.match(a.id, /^acc_[0-9a-f]{8}$/);
  assert.deepEqual(svc.list().map((x) => x.id), [a.id]);
});

test("account name validation", () => {
  const { svc } = setup();
  assert.throws(() => svc.create("   "), ValidationError);
  assert.throws(() => svc.create("x".repeat(51)), ValidationError);
  const a = svc.create("ok");
  assert.throws(() => svc.update(a.id, { name: "" }), ValidationError);
});

test("usageToday resets on a new day", () => {
  const { svc, clock } = setup();
  const a = svc.create("A");
  svc.recordJobStart(a.id);
  svc.recordJobStart(a.id);
  assert.equal(svc.usageToday(svc.get(a.id)), 2);
  clock.now = new Date(2026, 10, 3, 8, 0, 0);
  assert.equal(svc.usageToday(svc.get(a.id)), 0);
  const after = svc.recordJobStart(a.id);
  assert.deepEqual(after.usage, { date: "2026-11-03", jobs: 1 });
  assert.equal(after.lastUsedAt, clock.now.toISOString());
});

test("refreshCooldowns flips expired cooldown to ready", () => {
  const { svc, clock } = setup();
  const a = svc.create("A");
  svc.setState(a.id, "cooldown", { cooldownUntil: new Date(2026, 10, 2, 10, 0, 0).toISOString() });
  assert.equal(svc.refreshCooldowns(), false);
  assert.equal(svc.get(a.id).state, "cooldown");
  clock.now = new Date(2026, 10, 2, 10, 0, 1);
  assert.equal(svc.refreshCooldowns(), true);
  assert.equal(svc.get(a.id).state, "ready");
  assert.equal(svc.get(a.id).cooldownUntil, null);
});

test("setRest and update enabled", () => {
  const { svc } = setup();
  const a = svc.create("A");
  svc.setRest(a.id, "2026-11-02T09:01:00.000Z");
  assert.equal(svc.get(a.id).restUntil, "2026-11-02T09:01:00.000Z");
  assert.equal(svc.update(a.id, { enabled: false }).enabled, false);
});

test("remove deletes the profile dir", () => {
  const { svc } = setup();
  const a = svc.create("A");
  const dir = svc.profileDir(a.id);
  fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
  svc.remove(a.id);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(svc.get(a.id), undefined);
});

test("unknown id throws", () => {
  const { svc } = setup();
  assert.throws(() => svc.setState("acc_nope", "ready"), /Không tìm thấy/);
});

test("mutations emit change", () => {
  const { svc } = setup();
  let n = 0;
  const on = () => n++;
  bus.on("change", on);
  svc.create("A");
  bus.off("change", on);
  assert.ok(n > 0);
});

test("refreshCooldowns does not rewrite the file when nothing changed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse acc "));
  const real = createJsonStore(path.join(dir, "accounts.json"), []);
  let writes = 0;
  const counting = {
    read: real.read,
    write: (v) => { writes++; real.write(v); },
    update(fn) { const n = fn(real.read()); this.write(n); return n; },
  };
  const svc = createAccountService({ store: counting, profilesDir: dir });
  svc.create("A");
  writes = 0;
  svc.refreshCooldowns();
  assert.equal(writes, 0);
});
