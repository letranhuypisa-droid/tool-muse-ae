import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMuseDriver } from "../src/muse/driver.js";
import { MuseError } from "../src/muse/errors.js";
import { normalizeSettings } from "../src/config.js";
import { makeFixtureDir, makeClip, makeImage } from "./helpers/fixtures.js";
import { startFakeMuse } from "./helpers/fakeMuseServer.js";

let dir, server, driver, png;
const PNG_SIG = "89504e47";

before(async () => {
  dir = await makeFixtureDir();
  const mp4 = await makeClip(dir, "sample.mp4", { width: 320, height: 240, seconds: 2 });
  png = await makeImage(dir, "sample.png", { width: 64, height: 48 });
  server = await startFakeMuse({ mp4, png });
  driver = createMuseDriver({
    profilesDir: path.join(dir, "profiles"),
    errorsDir: path.join(dir, "errors"),
    getSettings: () => normalizeSettings({ headless: true }),
    homeUrl: server.url,
  });
});

after(async () => {
  await driver.closeAll();
  await server.close();
});

const turn = (accountId, message, files = []) =>
  driver.runTurn(accountId, { message, files, timeoutMs: 20_000, jobId: "job_test" });

test("runTurn returns the new image and reply", async () => {
  const r = await turn("acc_img", "Tạo ngay 1 ảnh: mèo");
  assert.equal(r.media.length, 1);
  assert.equal(r.media[0].kind, "image");
  assert.equal(r.media[0].ext, "png");
  assert.equal(r.media[0].bytes.subarray(0, 4).toString("hex"), PNG_SIG);
  assert.match(r.replyText, /Xong rồi/);
  await driver.close("acc_img");
});

test("runTurn returns video bytes as mp4", async () => {
  const r = await turn("acc_vid", "Tạo ngay 1 video: mèo");
  assert.equal(r.media.length, 1);
  assert.equal(r.media[0].kind, "video");
  assert.equal(r.media[0].ext, "mp4");
  assert.equal(r.media[0].bytes.subarray(4, 8).toString("latin1"), "ftyp");
  await driver.close("acc_vid");
});

test("old media from earlier turns is not returned again", async () => {
  // Không đóng giữa hai lượt nhưng trang được tải lại; giữ cùng page để có lịch sử chat.
  const page = await driver._pageFor("acc_two");
  await page.goto(server.url);
  const first = await driver._turnOnPage(page, { message: "ảnh một", files: [], timeoutMs: 20_000 });
  const second = await driver._turnOnPage(page, { message: "ảnh hai", files: [], timeoutMs: 20_000 });
  assert.equal(first.media.length, 1);
  assert.equal(second.media.length, 1);
  await driver.close("acc_two");
});

test("multiline prompt is sent as one message", async () => {
  const page = await driver._pageFor("acc_multi");
  await page.goto(server.url);
  const r = await driver._turnOnPage(page, { message: "dòng 1\ndòng 2 video", files: [], timeoutMs: 20_000 });
  assert.equal(await page.evaluate(() => window.__sends), 1);
  assert.equal(r.media[0].kind, "video");
  await driver.close("acc_multi");
});

test("attachments reach the file input", async () => {
  const page = await driver._pageFor("acc_att");
  await page.goto(server.url);
  await driver._attach(page, [png]);
  assert.equal(await page.locator("#previews img").count(), 1);
  await driver.close("acc_att");
});

test("limit reply has no media", async () => {
  const r = await turn("acc_lim", "LIMIT please");
  assert.equal(r.media.length, 0);
  assert.match(r.replyText, /daily limit/);
  await driver.close("acc_lim");
});

test("logged-out page → MuseError NOT_LOGGED_IN with screenshot", async () => {
  const d = createMuseDriver({
    profilesDir: path.join(dir, "profiles"),
    errorsDir: path.join(dir, "errors"),
    getSettings: () => normalizeSettings({ headless: true }),
    homeUrl: server.url + "?loggedout",
    loginWaitMs: 1500,
  });
  await assert.rejects(
    d.runTurn("acc_out", { message: "x", files: [], timeoutMs: 5000, jobId: "job_out" }),
    (err) => err instanceof MuseError && err.code === "NOT_LOGGED_IN",
  );
  assert.equal(await d.checkLoggedIn("acc_out"), false);
  await d.closeAll();
  assert.ok(fs.readdirSync(path.join(dir, "errors")).some((f) => f.startsWith("job_out-")));
});

test("checkLoggedIn true on a logged-in page", async () => {
  assert.equal(await driver.checkLoggedIn("acc_ok"), true);
  assert.equal(driver.isOpen("acc_ok"), true);
  await driver.close("acc_ok");
  assert.equal(driver.isOpen("acc_ok"), false);
});
