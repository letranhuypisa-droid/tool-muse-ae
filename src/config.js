import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TEMPLATES } from "./muse/messages.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function getPaths(root = ROOT) {
  const data = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  return {
    root,
    data,
    profiles: path.join(root, "profiles"),
    uploads: path.join(root, "uploads"),
    downloads,
    raw: path.join(downloads, "raw"),
    errors: path.join(data, "errors"),
    public: path.join(ROOT, "public"),
  };
}

export function ensureDirs(paths) {
  for (const key of ["data", "profiles", "uploads", "downloads", "raw", "errors"]) {
    fs.mkdirSync(paths[key], { recursive: true });
  }
}

export const DEFAULT_SETTINGS = Object.freeze({
  concurrency: 3,
  cooldownHours: 24,
  delayMinSec: 20,
  delayMaxSec: 60,
  dailyCapPerAccount: 0,
  // "Chạy ẩn": cửa sổ Chrome của việc nằm ngoài màn hình (xem launchOptions trong muse/driver.js); chỉ hiện lúc đăng nhập.
  headless: true,
  imageTimeoutMin: 3,
  videoTimeoutMin: 6,
  maxRetries: 2,
  messageTemplates: DEFAULT_TEMPLATES,
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (value === null || value === "" || typeof value === "boolean" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeTemplates(input) {
  const out = { ...DEFAULT_TEMPLATES };
  if (!input || typeof input !== "object") return out;
  for (const key of Object.keys(DEFAULT_TEMPLATES)) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) continue;
    if (key !== "refSuffix" && !value.includes("{prompt}")) continue;
    out[key] = value;
  }
  return out;
}

export function normalizeSettings(input) {
  const s = input && typeof input === "object" ? input : {};
  const d = DEFAULT_SETTINGS;
  const delayMinSec = clampInt(s.delayMinSec, 0, 600, d.delayMinSec);
  return {
    concurrency: clampInt(s.concurrency, 1, 8, d.concurrency),
    cooldownHours: clampInt(s.cooldownHours, 1, 168, d.cooldownHours),
    delayMinSec,
    delayMaxSec: clampInt(s.delayMaxSec, delayMinSec, 3600, Math.max(delayMinSec, d.delayMaxSec)),
    dailyCapPerAccount: clampInt(s.dailyCapPerAccount, 0, 100000, d.dailyCapPerAccount),
    headless: typeof s.headless === "boolean" ? s.headless : d.headless,
    imageTimeoutMin: clampInt(s.imageTimeoutMin, 1, 30, d.imageTimeoutMin),
    videoTimeoutMin: clampInt(s.videoTimeoutMin, 1, 30, d.videoTimeoutMin),
    maxRetries: clampInt(s.maxRetries, 0, 5, d.maxRetries),
    messageTemplates: normalizeTemplates(s.messageTemplates),
  };
}

export function createSettingsService(store) {
  return {
    get: () => normalizeSettings(store.read()),
    save(patch) {
      const next = normalizeSettings({ ...normalizeSettings(store.read()), ...patch });
      store.write(next);
      return next;
    },
  };
}
