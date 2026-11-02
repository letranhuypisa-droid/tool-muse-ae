import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJsonStore } from "../src/store.js";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse store "));
  return path.join(dir, "data.json");
}

test("store returns default when file missing and round-trips writes", () => {
  const file = tmpFile();
  const store = createJsonStore(file, { items: [] });
  assert.deepEqual(store.read(), { items: [] });
  store.write({ a: 1 });
  assert.deepEqual(createJsonStore(file, {}).read(), { a: 1 });
  assert.equal(fs.existsSync(file + ".tmp"), false);
});

test("store default is a copy, not shared", () => {
  const def = { items: [] };
  const store = createJsonStore(tmpFile(), def);
  store.read().items.push(1);
  assert.deepEqual(def, { items: [] });
});

test("store recovers from corrupt JSON", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{oops");
  const store = createJsonStore(file, [1]);
  assert.deepEqual(store.read(), [1]);
  const siblings = fs.readdirSync(path.dirname(file));
  assert.ok(siblings.some((f) => /\.corrupt-\d+$/.test(f)), siblings.join(","));
});

test("store.update applies fn and persists", () => {
  const file = tmpFile();
  const store = createJsonStore(file, { n: 0 });
  const result = store.update((v) => ({ n: v.n + 1 }));
  assert.deepEqual(result, { n: 1 });
  assert.deepEqual(createJsonStore(file, {}).read(), { n: 1 });
});
