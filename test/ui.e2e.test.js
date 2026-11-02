import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { startTestApp } from "./helpers/testApp.js";
import { makeFixtureDir, makeClip, makeImage } from "./helpers/fixtures.js";
import { createFakeDriver } from "../src/muse/fakeDriver.js";
import { createRunner } from "../src/runner.js";

let browser, clipBytes, pngBytes;

before(async () => {
  const dir = await makeFixtureDir();
  clipBytes = fs.readFileSync(await makeClip(dir, "c.mp4", { width: 320, height: 240, seconds: 10 }));
  pngBytes = fs.readFileSync(await makeImage(dir, "p.png", { width: 64, height: 64 }));
  browser = await chromium.launch({ channel: "chrome", headless: true });
});

after(async () => {
  await browser?.close();
});

async function setup(t) {
  const driver = createFakeDriver((accountId, req) =>
    req.message.includes("video")
      ? { media: [{ kind: "video", ext: "mp4", bytes: clipBytes }], replyText: "Xong rồi" }
      : { media: [{ kind: "image", ext: "png", bytes: pngBytes }], replyText: "Xong rồi" },
  );
  const app = await startTestApp({
    driver,
    tickMs: 100,
    makeRunJob: ({ jobs, paths, settings }) =>
      createRunner({ driver, jobs, paths, getSettings: () => settings.get() }).runJob,
  });
  app.settings.save({ delayMinSec: 0, delayMaxSec: 0 });
  const page = await browser.newPage();
  t.after(async () => {
    await page.close();
    await app.close();
  });
  return { app, page };
}

async function readyAccount(app, name = "A") {
  const acc = (await app.api("POST", "/api/accounts", { name })).body;
  await app.api("POST", `/api/accounts/${acc.id}/verify`);
  return acc;
}

test("create → queue → library flow", async (t) => {
  const { app, page } = await setup(t);
  await readyAccount(app);
  app.scheduler.start();
  await page.goto(app.base);
  await page.getByRole("tab", { name: "Tạo mới" }).click();
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await page.getByLabel("Prompt", { exact: true }).fill("mèo cam");
  await page.getByLabel("Thời lượng").fill("12");
  await assert.doesNotReject(page.getByText("12 giây · 2 clip").waitFor({ timeout: 2000 }));
  await page.getByRole("button", { name: "Thêm vào hàng đợi" }).click();

  await page.getByRole("tab", { name: /Hàng đợi/ }).click();
  const row = page.locator("[data-job-row]", { hasText: "mèo cam" });
  await row.waitFor({ timeout: 5000 });
  await row.getByText("Xong").waitFor({ timeout: 30_000 });

  await page.getByRole("tab", { name: "Thư viện" }).click();
  const video = page.locator("#tab-library video").first();
  await video.waitFor({ timeout: 5000 });
  assert.match(await video.getAttribute("src"), /^\/files\//);
});

test("bulk mode creates one job per line", async (t) => {
  const { app, page } = await setup(t);
  await page.goto(app.base);
  await page.getByLabel("Nhập nhiều prompt").check();
  await page.getByLabel("Prompt", { exact: true }).fill("một\nhai\n\n");
  await page.getByRole("button", { name: "Thêm vào hàng đợi" }).click();
  await page.getByText("Đã thêm 2 việc").waitFor({ timeout: 5000 });
  assert.equal(app.jobs.list().length, 2);
});

test("validation error is shown in Vietnamese", async (t) => {
  const { app, page } = await setup(t);
  await page.goto(app.base);
  await page.getByRole("button", { name: "Thêm vào hàng đợi" }).click();
  await page.getByText("Bạn chưa nhập prompt").waitFor({ timeout: 5000 });
});

test("no_accounts banner shows when the only account is disabled", async (t) => {
  const { app, page } = await setup(t);
  const acc = await readyAccount(app);
  await app.api("PATCH", `/api/accounts/${acc.id}`, { enabled: false });
  await app.api("POST", "/api/jobs", { type: "image", prompt: "x" });
  app.scheduler.start();
  await page.goto(app.base);
  await page.getByText("Tất cả tài khoản đang hết lượt hoặc cần đăng nhập").waitFor({ timeout: 5000 });
});

test("accounts tab shows state and adds an account", async (t) => {
  const { app, page } = await setup(t);
  await page.goto(app.base);
  await page.getByRole("tab", { name: /Tài khoản/ }).click();
  await page.getByPlaceholder("Tên gợi nhớ, ví dụ: Gmail số 2").fill("Tài khoản mới");
  await page.getByRole("button", { name: "Thêm tài khoản" }).click();
  const card = page.locator("[data-account-card]", { hasText: "Tài khoản mới" });
  await card.getByText("Cần đăng nhập").waitFor({ timeout: 5000 });
  await card.getByRole("button", { name: "Đã đăng nhập" }).click();
  await card.getByText("Sẵn sàng").waitFor({ timeout: 5000 });
});

test("shows a Vietnamese message when the tool is not reachable", async (t) => {
  const { app, page } = await setup(t);
  await page.goto(app.base);
  await page.getByLabel("Prompt", { exact: true }).fill("mèo");
  await app.close();
  await page.getByRole("button", { name: "Thêm vào hàng đợi" }).click();
  await page.getByText("Không kết nối được tới tool").waitFor({ timeout: 5000 });
});
