# Muse Account Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local Windows tool (web UI at localhost) that manages many muse.ai accounts, queues image/video jobs across them with N parallel workers, and saves results — videos upscaled to 1080p and cut/chained to a chosen 1–60 s duration.

**Architecture:** Node.js server (Express) holds JSON-file state, a scheduler, and a runner. The runner drives muse.ai through Playwright persistent Chrome profiles (one per account) by sending chat messages and pulling `blob:` media out of the page, then post-processes with ffmpeg. A vanilla-JS single page talks to the server over REST + Server-Sent Events.

**Tech Stack:** Node.js ≥ 24 (ESM), express@5, multer@2, playwright-core (installed Chrome via `channel: "chrome"`, fallback `"msedge"`), ffmpeg/ffprobe on PATH, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-02-muse-account-manager-design.md`

## Global Constraints

- Node ≥ 24, `"type": "module"`. Runtime deps only: `express`, `multer`, `playwright-core`. No Python, no browser downloads.
- Browser: `chromium.launchPersistentContext(profileDir, { channel: "chrome", ... })`; if that throws, retry with `channel: "msedge"`.
- ffmpeg/ffprobe: `process.env.FFMPEG_PATH || "ffmpeg"`, `process.env.FFPROBE_PATH || "ffprobe"`, always `spawn(cmd, argsArray)` — never a shell string (project path contains spaces: `tool muse AI`).
- Server listens on `127.0.0.1`, port `process.env.PORT || 3000`.
- All user-facing text (UI, API error messages) in Vietnamese; code identifiers in English.
- The tool never stores or types passwords. Login is done by the user in a visible window.
- muse.ai home URL: `https://muse.ai/`.
- Clip length 10 s; video duration integer 1–60 s; `totalClips = ceil(D / 10)`.
- Settings defaults (verbatim from spec): `concurrency 3`, `cooldownHours 24`, `delayMinSec 20`, `delayMaxSec 60`, `dailyCapPerAccount 0` (0 = unlimited), `headless false`, `imageTimeoutMin 3`, `videoTimeoutMin 6`, `maxRetries 2`.
- Final video encode: `libx264 -crf 18 -preset medium -pix_fmt yuv420p`, `aac 192k`, `-movflags +faststart`. Upscale: short side → 1080, `flags=lanczos`, `unsharp=5:5:0.4`.
- Output paths: final files `downloads/YYYY-MM-DD/`, raw clips `downloads/raw/`, error screenshots `data/errors/<jobId>-<timestamp>.png`. Dates are local time.
- One account runs at most one job at a time.

## Review Focus

1. **Multi-line / Vietnamese / emoji prompts** — a newline in the prompt must not send the chat message early, and file names must stay valid on Windows. Pinned by: Task 2 `slugify` tests, Task 6 fake-muse multiline test (driver uses `fill()`, never `type()`).
2. **Paths with spaces** (the project lives in `…\tool muse AI\`) — ffmpeg and Chrome must work there. Pinned by: Task 3 fixtures created in a temp dir named `muse fixtures *`.
3. **Chained clips that don't match** (different size, missing audio track) — the final video must still render at the first clip's size with an audio track. Pinned by: Task 3 `finalizeVideo mixes sizes and silent clip`.
4. **Account busy or profile locked** — opening the window / deleting an account that is running a job must be refused (409), and a Chrome "profile in use" launch failure must count as a temporary error, not crash the worker. Pinned by: Task 7 409 tests, Task 6 runner `BROWSER → TRANSIENT` test.
5. **Bad uploads** (HEIC, PDF, > 20 MB, > 9 images) — rejected with a Vietnamese message, nothing queued. Pinned by: Task 7 upload tests, Task 4 enqueue validation.

---

### Task 1: Scaffold, JSON store, settings

**Files:**
- Create: `package.json`, `.gitignore`, `src/util.js`, `src/store.js`, `src/config.js`, `src/muse/messages.js`
- Test: `test/store.test.js`, `test/config.test.js`

**Interfaces:**
- Produces:
  - `src/util.js`: `class ValidationError extends Error`; `newId(prefix: string): string` (`prefix + "_" + 8 hex chars`); `localDate(d: Date): string` (`"YYYY-MM-DD"`, local time); `slugify(text: string, maxLen = 40): string`; `randomBetween(min: number, max: number, random = Math.random): number`.
  - `src/store.js`: `createJsonStore(filePath: string, defaultValue: T) → { read(): T, write(value: T): void, update(fn: (T) => T): T }` — synchronous; write = write `filePath + ".tmp"` then `renameSync`; unreadable/invalid JSON → rename to `filePath + ".corrupt-<ms>"` and return a deep copy of `defaultValue`.
  - `src/muse/messages.js`: `DEFAULT_TEMPLATES = { image, video, continue, refSuffix }`; `buildMessage(templates, { kind: "image"|"video"|"continue", prompt: string, hasRefs: boolean }): string`.
  - `src/config.js`: `ROOT`; `getPaths(root = ROOT) → { root, data, profiles, uploads, downloads, raw, errors, public }` (`raw = downloads/raw`, `errors = data/errors`); `ensureDirs(paths): void`; `DEFAULT_SETTINGS`; `normalizeSettings(input: object): Settings`; `createSettingsService(store) → { get(): Settings, save(patch: object): Settings }`.

- [ ] **Step 1: Init repo and package**

`git init`; `package.json` with `"name": "muse-account-manager"`, `"type": "module"`, `"engines": { "node": ">=24" }`, scripts `"start": "node src/main.js"`, `"test": "node --test --test-concurrency=1 \"test/**/*.test.js\""`. `npm install express@5 multer@2 playwright-core`. `.gitignore`: `node_modules/ data/ profiles/ uploads/ downloads/`.

- [ ] **Step 2: Write failing tests**

```js
// test/store.test.js
test("store returns default when file missing and round-trips writes", ...)
  // read() deepEquals default; write({a:1}); new store on same path reads {a:1}; no ".tmp" file left
test("store recovers from corrupt JSON", ...)
  // write "{oops" to file; read() deepEquals default; a sibling file matching /\.corrupt-\d+$/ exists
test("store.update applies fn and persists", ...)

// test/config.test.js
test("normalizeSettings fills defaults", () => {
  const s = normalizeSettings({});
  assert.equal(s.concurrency, 3); assert.equal(s.cooldownHours, 24);
  assert.equal(s.delayMinSec, 20); assert.equal(s.delayMaxSec, 60);
  assert.equal(s.dailyCapPerAccount, 0); assert.equal(s.headless, false);
  assert.equal(s.imageTimeoutMin, 3); assert.equal(s.videoTimeoutMin, 6); assert.equal(s.maxRetries, 2);
  assert.deepEqual(s.messageTemplates, DEFAULT_TEMPLATES);
});
test("normalizeSettings clamps and repairs", () => {
  const s = normalizeSettings({ concurrency: 99, delayMinSec: 50, delayMaxSec: 10, maxRetries: -1,
    messageTemplates: { image: "no placeholder" } });
  assert.equal(s.concurrency, 8); assert.equal(s.delayMaxSec, 50); assert.equal(s.maxRetries, 0);
  assert.equal(s.messageTemplates.image, DEFAULT_TEMPLATES.image); // template without {prompt} rejected
});
test("buildMessage", () => {
  assert.equal(buildMessage(DEFAULT_TEMPLATES, { kind: "image", prompt: "mèo", hasRefs: false }),
    "Tạo ngay 1 ảnh, không cần hỏi lại: mèo");
  assert.equal(buildMessage(DEFAULT_TEMPLATES, { kind: "video", prompt: "mèo", hasRefs: true }),
    "Tạo ngay 1 video, không cần hỏi lại: mèo Dùng ảnh đính kèm làm ảnh tham chiếu.");
  assert.equal(buildMessage(DEFAULT_TEMPLATES, { kind: "continue", prompt: "mèo", hasRefs: true }),
    "Dùng ảnh đính kèm làm khung hình mở đầu, tạo ngay 1 video nối tiếp liền mạch, không cần hỏi lại: mèo");
});
```

- [ ] **Step 3: Run — expect FAIL** (`npm test` → modules not found)

- [ ] **Step 4: Implement**

Exact copy for `DEFAULT_TEMPLATES`:
- `image`: `Tạo ngay 1 ảnh, không cần hỏi lại: {prompt}`
- `video`: `Tạo ngay 1 video, không cần hỏi lại: {prompt}`
- `continue`: `Dùng ảnh đính kèm làm khung hình mở đầu, tạo ngay 1 video nối tiếp liền mạch, không cần hỏi lại: {prompt}`
- `refSuffix`: `Dùng ảnh đính kèm làm ảnh tham chiếu.`

`buildMessage` replaces `{prompt}` and appends `" " + refSuffix` only for `image`/`video` with `hasRefs`. Clamp ranges in `normalizeSettings`: concurrency int 1–8, cooldownHours 1–168, delayMinSec 0–600, delayMaxSec ≥ delayMinSec and ≤ 3600, dailyCapPerAccount int ≥ 0, timeouts 1–30, maxRetries 0–5, headless boolean; each template must be a string containing `{prompt}` (except `refSuffix`) else default.

- [ ] **Step 5: Run — expect PASS**, then commit `feat: scaffold, json store, settings`.

---

### Task 2: Pure helpers — clip planner, slugify, reply classifier

**Files:**
- Create: `src/planner.js`, `src/muse/classify.js`
- Modify: `src/util.js` (slugify body if not done in Task 1)
- Test: `test/planner.test.js`, `test/classify.test.js`

**Interfaces:**
- Produces:
  - `src/planner.js`: `CLIP_SECONDS = 10`, `MAX_DURATION = 60`; `planClips(durationSec: number) → { totalClips: number, trimSec: number }` — throws `ValidationError("Thời lượng phải là số nguyên từ 1 đến 60 giây")` for non-integer or out of range.
  - `src/muse/classify.js`: `LIMIT_KEYWORDS: string[]`, `REFUSAL_KEYWORDS: string[]`, `classifyReply(text: string): "LIMIT"|"REFUSED"|"NO_MEDIA"` — case-insensitive substring match, LIMIT checked first.

- [ ] **Step 1: Write failing tests**

```js
test("planClips", () => {
  assert.deepEqual(planClips(1),  { totalClips: 1, trimSec: 1 });
  assert.deepEqual(planClips(10), { totalClips: 1, trimSec: 10 });
  assert.deepEqual(planClips(11), { totalClips: 2, trimSec: 11 });
  assert.deepEqual(planClips(60), { totalClips: 6, trimSec: 60 });
  for (const bad of [0, 61, 2.5, NaN, "10"]) assert.throws(() => planClips(bad), ValidationError);
});
test("slugify strips Vietnamese diacritics, emoji, Windows-invalid chars, newlines", () => {
  assert.equal(slugify("Mèo cam ngồi bên cửa sổ"), "meo-cam-ngoi-ben-cua-so");
  assert.equal(slugify("Đường phố 🌧️ <đêm>:\n\"mưa\"?*|"), "duong-pho-dem-mua");
  assert.equal(slugify("a".repeat(100)).length, 40);
  assert.equal(slugify("🔥🔥"), "untitled");
});
test("classifyReply", () => {
  assert.equal(classifyReply("You've reached your daily limit. Upgrade to continue."), "LIMIT");
  assert.equal(classifyReply("Bạn đã hết lượt tạo video hôm nay, thử lại ngày mai nhé"), "LIMIT");
  assert.equal(classifyReply("I can't create that because it goes against our policy"), "REFUSED");
  assert.equal(classifyReply("Mình không thể tạo nội dung này vì vi phạm chính sách"), "REFUSED");
  assert.equal(classifyReply("Bạn muốn mèo màu gì?"), "NO_MEDIA");
  assert.equal(classifyReply(""), "NO_MEDIA");
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement.** Keywords — LIMIT: `limit, credit, quota, upgrade, out of, try again tomorrow, giới hạn, hết lượt, hết credit, nâng cấp, ngày mai`. REFUSAL: `can't, cannot, unable to, policy, guidelines, không thể, chính sách, vi phạm`. `slugify`: NFD, strip `\u0300-\u036f`, `đ/Đ → d`, lowercase, non `[a-z0-9]` runs → `-`, trim `-`, cut to `maxLen` then trim trailing `-`, empty → `"untitled"`.

- [ ] **Step 4: Run — expect PASS**, commit `feat: clip planner, slugify, reply classifier`.

---

### Task 3: ffmpeg module

**Files:**
- Create: `src/media/ffmpeg.js`, `test/helpers/fixtures.js`
- Test: `test/ffmpeg.test.js`

**Interfaces:**
- Produces (`src/media/ffmpeg.js`):
  - `probe(file: string) → Promise<{ width, height, duration, fps, hasAudio }>` (ffprobe `-show_streams -show_format -of json`; `duration` from format; `fps` = evaluated `r_frame_rate` of the video stream).
  - `targetSize(width, height, upscale1080: boolean) → { width, height }` — no upscale → unchanged; landscape/square (`w >= h`) → `h = 1080`, `w = round(w*1080/h)` rounded to even; portrait → `w = 1080`, `h` likewise.
  - `extractLastFrame(input: string, outputPng: string) → Promise<void>` — `-sseof -0.1 -i input -frames:v 1 -update 1 -y outputPng`.
  - `buildFinalizeArgs({ inputs: [{ path, hasAudio, duration }], output, width, height, fps, trimSec, upscale1080 }) → string[]`
  - `finalizeVideo({ inputs: string[], output: string, trimSec: number, upscale1080: boolean }) → Promise<{ width, height, duration }>` — probes every input, base size/fps = first input, builds args, runs ffmpeg, probes output.
  - `class FfmpegError extends Error` (message includes last 20 lines of stderr).
- Produces (`test/helpers/fixtures.js`): `makeFixtureDir() → Promise<string>` (temp dir whose name contains a space: `muse fixtures <random>`); `makeClip(dir, name, { width, height, seconds = 10, audio = true }) → Promise<string>` (`testsrc=size=WxH:rate=24` + `sine=frequency=440`, `-shortest`); `makeImage(dir, name, { width, height }) → Promise<string>` (PNG, `testsrc`, 1 frame).

Filter graph `buildFinalizeArgs` must produce (W,H = first clip size; TW,TH = `targetSize`):
```
per input i:   [i:v]scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=FPS,format=yuv420p[v{i}]
audio i:       hasAudio ? [i:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}]
               : extra input `-f lavfi -t <duration> -i anullsrc=r=48000:cl=stereo` (index k) → [k:a]acopy[a{i}]
join:          [v0][a0][v1][a1]…concat=n=N:v=1:a=1[vc][ac]
upscale:       [vc]scale=TW:TH:flags=lanczos,unsharp=5:5:0.4[vout]   (else [vc]null[vout])
output:        -map [vout] -map [ac] -t trimSec -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart -y output
```

- [ ] **Step 1: Write failing tests**

```js
test("targetSize", () => {
  assert.deepEqual(targetSize(1152, 768, true), { width: 1620, height: 1080 });
  assert.deepEqual(targetSize(1280, 720, true), { width: 1920, height: 1080 });
  assert.deepEqual(targetSize(768, 1152, true), { width: 1080, height: 1620 });
  assert.deepEqual(targetSize(1152, 768, false), { width: 1152, height: 768 });
});
test("probe reads size, duration, audio", async () => {
  const c = await makeClip(dir, "a.mp4", { width: 1152, height: 768 });
  const p = await probe(c);
  assert.equal(p.width, 1152); assert.equal(p.height, 768); assert.equal(p.hasAudio, true);
  assert.ok(Math.abs(p.duration - 10) < 0.15); assert.equal(p.fps, 24);
});
test("extractLastFrame writes a PNG of the same size", ...)  // probe(png).width === 1152
test("finalizeVideo: 2 clips → 15 s, 1080p, with audio", async () => {
  const r = await finalizeVideo({ inputs: [c1, c2], output: out, trimSec: 15, upscale1080: true });
  assert.equal(r.width, 1620); assert.equal(r.height, 1080);
  assert.ok(Math.abs(r.duration - 15) < 0.15); assert.equal((await probe(out)).hasAudio, true);
});
test("finalizeVideo: single clip trimmed to 4 s, no upscale", ...)  // 1152x768, 4 s
test("finalizeVideo: portrait upscales to 1080x1620", ...)
test("finalizeVideo mixes sizes and silent clip", async () => {
  const a = await makeClip(dir, "x.mp4", { width: 1152, height: 768 });
  const b = await makeClip(dir, "y.mp4", { width: 1280, height: 720, audio: false });
  const r = await finalizeVideo({ inputs: [a, b], output: out, trimSec: 20, upscale1080: false });
  assert.equal(r.width, 1152); assert.equal(r.height, 768);
  assert.ok(Math.abs(r.duration - 20) < 0.15); assert.equal((await probe(out)).hasAudio, true);
});
test("finalizeVideo rejects with FfmpegError on missing input", ...)
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run — expect PASS**, commit `feat: ffmpeg probe, last frame, finalize (concat/trim/upscale)`.

---

### Task 4: Account and job services, change events

**Files:**
- Create: `src/events.js`, `src/accounts.js`, `src/jobs.js`
- Test: `test/accounts.test.js`, `test/jobs.test.js`

**Interfaces:**
- Consumes: `createJsonStore`, `newId`, `localDate`, `ValidationError`, `planClips` (for duration validation).
- Produces:
  - `src/events.js`: `bus: EventEmitter`; `notifyChange(): void` (emits `"change"`).
  - `src/accounts.js`: `createAccountService({ store, profilesDir, now = () => new Date() })` →
    `list(): Account[]`, `get(id): Account|undefined`, `create(name: string): Account`, `update(id, { name?, enabled? }): Account`, `remove(id): void` (also deletes `profilesDir/<id>`), `setState(id, state, { cooldownUntil?, lastError? } = {}): Account`, `recordJobStart(id): Account`, `setRest(id, untilIso: string): Account`, `refreshCooldowns(): boolean`, `usageToday(account): number`, `profileDir(id): string`.
    Account = `{ id, name, enabled, state: "needs_login"|"ready"|"cooldown"|"error", cooldownUntil: string|null, restUntil: string|null, usage: { date, jobs }, lastUsedAt: string|null, lastError: string|null, createdAt }`. New account: `state "needs_login"`, `enabled true`. Name: trimmed, 1–50 chars, else `ValidationError("Tên tài khoản phải từ 1 đến 50 ký tự")`.
  - `src/jobs.js`: `createJobService({ store, now = () => new Date() })` →
    `enqueue(input): Job[]`, `list(): Job[]` (newest first), `get(id)`, `update(id, patch): Job`, `nextQueued(): Job|undefined` (oldest `queued`), `cancel(id): Job`, `retry(id): Job`, `remove(id): void`, `recoverOnStartup(): number`.
    Job = `{ id, type, prompt, refImages, durationSec, upscale1080, status, progress: { clip, totalClips }, accountId, attempts, rawFiles, outputs, replyText, error, createdAt, updatedAt }`.
  - Every mutating method calls `notifyChange()`.

Enqueue rules: `type ∈ {image, video}`; `prompt` trimmed 1–4000 chars (keep internal newlines); `refImages` array of ≤ 9 strings; `count` int 1–20 → that many jobs; video: `durationSec` validated via `planClips`, `upscale1080` boolean default `true`; image: `durationSec = null`, `upscale1080 = null`. Vietnamese `ValidationError` messages. `cancel`: only `queued|running|postprocessing`. `retry`: only `failed|refused|cancelled` → `queued`, `attempts 0`, `error null` (keeps `rawFiles`). `remove`: refuses `running|postprocessing`.

- [ ] **Step 1: Write failing tests**

```js
test("create account defaults", ...)        // state needs_login, enabled true, usage {date: today, jobs: 0}
test("usageToday resets on a new day", ...) // recordJobStart twice; advance now by 1 day → usageToday 0; recordJobStart → usage.jobs 1 with new date
test("refreshCooldowns flips expired cooldown to ready", ...)
test("remove deletes the profile dir", ...)
test("account name validation", ...)        // "" and 51 chars throw ValidationError
test("enqueue count=3 makes 3 queued jobs", ...)
test("enqueue validation", () => {
  // prompt "   " ; type "gif" ; durationSec 61 ; refImages length 10 ; count 0 → each throws ValidationError
});
test("enqueue keeps multi-line prompt", ...) // "dòng 1\ndòng 2" preserved
test("nextQueued is FIFO", ...)
test("recoverOnStartup requeues running/postprocessing and keeps rawFiles", ...)
test("cancel/retry/remove state rules", ...)
test("mutations emit change", ...)          // bus listener count of "change" events > 0
```

- [ ] **Step 2: Run — expect FAIL** · **Step 3: Implement** · **Step 4: Run — expect PASS** · **Step 5: Commit** `feat: account and job services`.

---

### Task 5: Scheduler

**Files:**
- Create: `src/scheduler.js`
- Test: `test/scheduler.test.js`

**Interfaces:**
- Consumes: account service, job service (Task 4), `randomBetween`, `localDate`.
- Produces:
  - `pickAccount(accounts: Account[], { settings, now: Date, busyIds: Set<string>, today: string }) → Account|null` — eligible: `enabled`, `state === "ready"`, not in `busyIds`, `restUntil` null or ≤ now, and (`dailyCapPerAccount === 0` or today's usage < cap). Order: today's usage ascending, then `lastUsedAt` ascending (null first).
  - `createScheduler({ accounts, jobs, getSettings, runJob, driver, now = () => new Date(), random = Math.random, tickMs = 2000 })` → `{ start(), stop(), pause(), resume(), tick(): Promise<void>, whenIdle(): Promise<void>, status(): { paused, running, waiting: null|"no_accounts" }, cancel(jobId): Promise<void> }`.
  - `runJob(job, account, { signal: AbortSignal }) → Promise<Outcome>`; `Outcome = { ok: true } | { ok: false, code: "LIMIT"|"NOT_LOGGED_IN"|"REFUSED"|"TRANSIENT"|"FFMPEG", message: string, replyText?: string }`.

`tick()`: `accounts.refreshCooldowns()`; while `running < concurrency` and not paused: `job = jobs.nextQueued()`, `account = pickAccount(...)`; if either missing stop; else `jobs.update(job.id, { status: "running", accountId })`, `accounts.recordJobStart(account.id)`, start `runJob` (not awaited) with an `AbortController` kept per job id. `waiting = "no_accounts"` when a queued job exists, nothing is running, and `pickAccount` returned null.

Outcome handling (after `runJob` settles; if the job is already `cancelled`, only free the account):
| Outcome | Job | Account |
|---|---|---|
| ok | (runner set `done`) | `setRest(now + randomBetween(delayMinSec, delayMaxSec) s)` |
| LIMIT | `queued`, `accountId null`, `error = message` | `setState("cooldown", { cooldownUntil: now + cooldownHours })` |
| NOT_LOGGED_IN | `queued`, `accountId null` | `setState("needs_login", { lastError: message })` |
| REFUSED | `refused`, `replyText` | rest as ok |
| TRANSIENT | `attempts + 1`; `> maxRetries` → `failed` else `queued`; `error = message` | rest as ok |
| FFMPEG | `failed`, `error = message` | rest as ok |
| runJob throws | treat as TRANSIENT with the error message | rest as ok |

`cancel(jobId)`: `jobs.cancel(jobId)`, abort its controller, `await driver.close(accountId)` if running.

- [ ] **Step 1: Write failing tests** (fake `runJob` returning controllable promises; fake clock via `now`; `random = () => 0`)

```js
test("never exceeds concurrency and never double-books an account", ...) // 4 ready accounts, 6 jobs, concurrency 3 → after tick: 3 running, 3 distinct accountIds
test("picks least-used account today", ...)
test("skips disabled, needs_login, cooldown, resting and capped accounts", ...)
test("LIMIT puts account in cooldown and requeues job without spending an attempt", ...) // attempts stays 0, cooldownUntil = now + 24h
test("NOT_LOGGED_IN marks account needs_login and requeues", ...)
test("TRANSIENT retries up to maxRetries then fails", ...) // maxRetries 2 → third TRANSIENT → status failed, attempts 3
test("REFUSED stores reply and does not retry", ...)
test("rest delay applied after a job", ...) // delayMinSec 20, random 0 → restUntil = now + 20s; account not picked before that
test("pause stops new pickups; resume continues", ...)
test("waiting = no_accounts when all accounts unavailable", ...)
test("cancel aborts the running job and closes the driver", ...) // signal.aborted true, driver.close called with accountId, job status cancelled after settle
```

- [ ] **Step 2: Run — expect FAIL** · **Step 3: Implement** · **Step 4: Run — expect PASS** · **Step 5: Commit** `feat: scheduler`.

---

### Task 6: muse.ai driver, fake driver, runner

**Files:**
- Create: `src/muse/selectors.js`, `src/muse/errors.js`, `src/muse/driver.js`, `src/muse/fakeDriver.js`, `src/runner.js`, `test/fixtures/fake-muse/index.html`
- Test: `test/driver.fake-muse.test.js`, `test/runner.test.js`

**Interfaces:**
- Consumes: `buildMessage`, `classifyReply`, `planClips`, `slugify`, `localDate`, ffmpeg module, job service.
- Produces:
  - `src/muse/selectors.js`: `HOME_URL = "https://muse.ai/"`, `COMPOSER = 'textarea[placeholder="Message"]'`, `FILE_INPUT = 'input[type="file"]'`, `STOP_BUTTON = 'button[aria-label="Stop"]'`, `CHAT_LOG = '[role="log"]'`, `VIDEO_WRAPPER = '[data-hatch-video-wrapper="true"]'`, `VIDEO_SRC_ATTR = "data-hatch-video-src"`, `IMAGE_BUTTON = '[data-pel-click="chat_media_click"]'`.
  - `src/muse/errors.js`: `class MuseError extends Error { code: "NOT_LOGGED_IN"|"TIMEOUT"|"BROWSER" }`.
  - Driver interface (real and fake): `{ openWindow(accountId): Promise<void>, checkLoggedIn(accountId): Promise<boolean>, runTurn(accountId, { message, files, timeoutMs, jobId }): Promise<TurnResult>, close(accountId): Promise<void>, closeAll(): Promise<void>, isOpen(accountId): boolean }`; `TurnResult = { media: [{ kind: "image"|"video", ext: "webp"|"png"|"jpg"|"mp4", bytes: Buffer }], replyText: string }`.
  - `createMuseDriver({ profilesDir, errorsDir, getSettings, homeUrl = HOME_URL })`.
  - `createFakeDriver(handler: (accountId, req, callIndex) => TurnResult|Promise<TurnResult>)` → driver interface plus `calls: [{ accountId, message, files }]`, `closed: string[]`.
  - `src/runner.js`: `createRunner({ driver, jobs, paths, getSettings, ffmpeg, now = () => new Date() }) → { runJob(job, account, { signal }): Promise<Outcome> }`.

Real driver `runTurn` algorithm (spec §6.2):
1. Get/launch the account's persistent context (`headless` from settings; `openWindow` always headful — if open headless, close and relaunch). Launch failure → `MuseError("BROWSER")`.
2. `page.goto(homeUrl)`; wait `COMPOSER` ≤ 20 s, else `MuseError("NOT_LOGGED_IN")`.
3. If `files.length`: `setInputFiles(FILE_INPUT, files)`; wait ≤ 20 s until the composer's ancestor (up to 4 levels above the textarea) contains ≥ `files.length` `img` elements; continue regardless.
4. `fill(COMPOSER, message)` (never `type` — newlines would send early), then `press("Enter")`.
5. Wait `STOP_BUTTON` visible ≤ 30 s (ignore timeout), then hidden ≤ `timeoutMs` (timeout → `MuseError("TIMEOUT")`), then 3 s; then wait ≤ 30 s until no media element after the anchor has `aria-busy="true"`.
6. In page: anchor = the last element inside `CHAT_LOG` whose own text contains `message.slice(0, 60)`; media = `VIDEO_WRAPPER` elements and `IMAGE_BUTTON img` elements that follow the anchor in document order (`anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING`). For each: `fetch(src)` → base64 + mime. `replyText` = `CHAT_LOG.innerText` after the last occurrence of the message prefix, trimmed.
7. mime → ext: `image/webp→webp`, `image/png→png`, `image/jpeg→jpg`, `video/mp4→mp4`; unknown skipped.
8. On any thrown error: screenshot to `errorsDir/<jobId>-<Date.now()>.png` (best-effort), rethrow (non-MuseError wrapped as `BROWSER`).

`checkLoggedIn`: goto home, `COMPOSER` visible within 20 s.

Runner `runJob` (spec §7):
- Image: `buildMessage(kind "image")` → one turn (`timeoutMs = imageTimeoutMin`) → images saved `downloads/<localDate>/<jobId>_<n>.<ext>` (n from 1) → `jobs.update({ status: "done", outputs, replyText })`.
- Video: `{ totalClips, trimSec } = planClips(durationSec)`; for `k = rawFiles.length + 1 … totalClips`: files = `k === 1 ? refImages : [lastFrame of rawFiles[k-2] → downloads/raw/<jobId>_clip<k-1>_last.png]`, kind `k === 1 ? "video" : "continue"`, `hasRefs = files.length > 0`, timeout `videoTimeoutMin`; first `video` media → `downloads/raw/<jobId>_clip<k>.mp4`; after each clip `jobs.update({ rawFiles, progress: { clip: k, totalClips } })`. Then `status "postprocessing"` → `finalizeVideo({ inputs: rawFiles, output: downloads/<localDate>/<jobId>_<slugify(prompt)>.mp4, trimSec, upscale1080 })` → `status "done"`, `outputs: [output]`.
- No media of the wanted kind → `code = classifyReply(replyText)`; `NO_MEDIA` → `TRANSIENT`; return with `replyText`.
- `MuseError NOT_LOGGED_IN` → `NOT_LOGGED_IN`; `TIMEOUT`/`BROWSER` → `TRANSIENT`; `FfmpegError` → `FFMPEG`; `signal.aborted` at any check → `{ ok: false, code: "TRANSIENT", message: "Đã hủy" }`.
- `finally`: `await driver.close(account.id)`.

Fake muse page (`test/fixtures/fake-muse/index.html`, served by a test HTTP server with `sample.mp4` and `sample.png` generated via Task 3 fixtures): `[role=log]` + textarea + hidden multiple file input with a preview area that appends an `img` per chosen file. On Enter: append the user's text bubble, show the Stop button, after 1.5 s hide it and append an assistant bubble `"Xong rồi"` plus — if the message contains `video` — a `div[data-hatch-video-wrapper=true][data-hatch-video-src=<blob of /sample.mp4>]`, else a `button[data-pel-click=chat_media_click] > img[src=<blob of /sample.png>]`; if the message contains `LIMIT`, reply `"You've reached your daily limit"` with no media. Query `?loggedout` → no textarea. The page also counts sends in `window.__sends`.

- [ ] **Step 1: Write failing driver tests** (real Chrome, headless, `homeUrl` = fake page)

```js
test("runTurn returns the new image and reply", ...)       // media[0].kind "image", ext "png", bytes PNG signature; replyText includes "Xong rồi"
test("runTurn returns video bytes as mp4", ...)            // ext "mp4", bytes.slice(4,8) === "ftyp"
test("old media from earlier turns is not returned again", ...) // 2 turns; second returns exactly 1 item
test("multiline prompt is sent as one message", ...)       // message "dòng 1\ndòng 2 video"; window.__sends === 1
test("attachments reach the file input", ...)              // files [png]; preview img count 1
test("logged-out page → MuseError NOT_LOGGED_IN", ...)
test("checkLoggedIn true/false", ...)
```

- [ ] **Step 2: Write failing runner tests** (fake driver, real ffmpeg fixtures, temp `paths`)

```js
test("image job saves every image and marks done", ...)  // fake returns 2 images → outputs length 2, files exist, ext webp
test("video 15 s 1080p: two turns, second attaches last frame", async () => {
  // calls[0].files deepEquals job.refImages; calls[0].message starts "Tạo ngay 1 video"
  // calls[1].files[0] endsWith "_clip1_last.png"; calls[1].message starts "Dùng ảnh đính kèm làm khung hình mở đầu"
  // output probe: 1620x1080 (fixture clips 1152x768), duration 15 ± 0.15; status done
});
test("resume: job with 1 raw clip only runs clip 2", ...)  // calls.length === 1
test("raw clips complete → only post-processing runs", ...) // calls.length === 0, status done
test("no media + limit reply → LIMIT, rawFiles kept", ...)
test("no media + chatty reply → TRANSIENT with replyText", ...)
test("MuseError BROWSER (e.g. profile in use) → TRANSIENT", ...)
test("MuseError NOT_LOGGED_IN → NOT_LOGGED_IN", ...)
test("driver.close is always called", ...)
```

- [ ] **Step 3: Run — expect FAIL** · **Step 4: Implement** · **Step 5: Run — expect PASS** · **Step 6: Commit** `feat: muse.ai driver, fake driver, job runner`.

---

### Task 7: HTTP API and live events

**Files:**
- Create: `src/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: all services, scheduler, driver, `createSettingsService`.
- Produces: `createApp({ accounts, jobs, scheduler, driver, settings, paths }) → express.Application` (no listen).

Routes (JSON; `ValidationError` → 400 `{ error }`, unknown id → 404 `{ error: "Không tìm thấy" }`, busy → 409 `{ error: "Tài khoản đang chạy việc, thử lại sau" }`):
| Method & path | Behavior |
|---|---|
| `GET /api/state` | `{ accounts, jobs, settings, scheduler: status() }` |
| `GET /api/events` | SSE; on `bus` `"change"` (debounced 200 ms) send `event: state` with the same payload; heartbeat comment every 25 s |
| `POST /api/accounts` `{ name }` | create, then `driver.openWindow(id)` (not awaited) → 201 account |
| `POST /api/accounts/:id/open` | 409 if busy; `driver.openWindow(id)` |
| `POST /api/accounts/:id/verify` | `checkLoggedIn` → `setState("ready"|"needs_login")`, then `driver.close(id)`; returns account |
| `PATCH /api/accounts/:id` | `{ name?, enabled? }` |
| `DELETE /api/accounts/:id` | 409 if busy; `driver.close` then `remove` |
| `POST /api/uploads` | multer, field `files`, ≤ 9 files, each ≤ 20 MB, mime `image/jpeg|png|webp` only else 400 `"Chỉ nhận ảnh JPG, PNG hoặc WEBP, tối đa 20 MB, tối đa 9 ảnh"`; saved to `uploads/<newId("ref")>.<ext>` → `[{ path, url: "/uploads/<file>" }]` |
| `POST /api/jobs` | `jobs.enqueue(body)` → 201 jobs; `refImages` entries must resolve inside `paths.uploads` else 400 |
| `POST /api/jobs/bulk` | `{ lines, ...common }` → one `enqueue` per non-empty trimmed line |
| `POST /api/jobs/:id/cancel` | `scheduler.cancel(id)` |
| `POST /api/jobs/:id/retry` / `DELETE /api/jobs/:id` | job service rules |
| `POST /api/queue/pause` / `resume` | scheduler |
| `GET /api/settings` / `PUT /api/settings` | settings service |
| `GET /api/library` | `done` jobs with `outputs` mapped to `{ url: "/files/<relative path>", kind }` |
| `POST /api/library/:jobId/use-as-ref` `{ index }` | copy that image output into `uploads/` → `{ path, url }` |
| `POST /api/open-folder` `{ path }` | must resolve inside `paths.downloads` else 400; `spawn("explorer", ["/select,", abs])` |
| static | `/files` → downloads, `/uploads` → uploads, `/` → `public/` |

"Busy" = an account that is the `accountId` of a `running|postprocessing` job.

- [ ] **Step 1: Write failing tests** (`app.listen(0)` + `fetch`; fake driver; temp paths)

```js
test("GET /api/state shape", ...)
test("POST /api/jobs validation returns Vietnamese 400", ...)   // prompt "" → 400, body.error is non-empty string
test("POST /api/jobs/bulk makes one job per non-empty line", ...) // "a\n\n b \n" → 2 jobs
test("refImages outside uploads are rejected", ...)              // "C:\\Windows\\win.ini" → 400
test("upload accepts png, rejects pdf, oversize, and 10 files", ...)
test("open window / delete on a busy account → 409", ...)
test("verify sets ready when fake driver says logged in", ...)
test("open-folder outside downloads → 400", ...)
test("SSE sends a state event after a change", ...)
test("library lists done outputs with /files urls that serve the file", ...)
```

- [ ] **Step 2: Run — expect FAIL** · **Step 3: Implement** · **Step 4: Run — expect PASS** · **Step 5: Commit** `feat: http api and sse`.

---

### Task 8: Web UI

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/styles.css`
- Test: `test/ui.e2e.test.js`

**Interfaces:**
- Consumes: Task 7 routes only.

Five tabs, Vietnamese copy (spec §9): **Tạo mới**, **Hàng đợi**, **Tài khoản**, **Thư viện**, **Cài đặt**. State comes from `GET /api/state` then `EventSource("/api/events")`; the page re-renders the active tab on each `state` event. Status labels: `queued "Chờ"`, `running "Đang tạo"` (+ `"clip k/n"` for video), `postprocessing "Hậu kỳ"`, `done "Xong"`, `failed "Lỗi"`, `refused "Bị từ chối"`, `cancelled "Đã hủy"`. Account states: `needs_login "Cần đăng nhập"`, `ready "Sẵn sàng"`, `cooldown "Hết lượt đến HH:mm"`, `error "Lỗi"`. Scheduler banner when `waiting === "no_accounts"`: `"Tất cả tài khoản đang hết lượt hoặc cần đăng nhập"`. Create form: type toggle, prompt textarea, drag-and-drop/file picker (uploads immediately via `/api/uploads`, shows thumbnails with remove), duration slider 1–60 (default 10) + 1080p switch (default on) shown only for video, count 1–20, "Nhập nhiều prompt" toggle switching to one-prompt-per-line → `/api/jobs/bulk`. Add-account flow: name prompt → window opens → card shows "Đã đăng nhập" button → `/verify`. Library: grid with `<img>`/`<video controls>`, download link (`download` attribute), "Mở thư mục", "Dùng làm tham chiếu" (images) which switches to Tạo mới with the ref attached. Layout must work at 1280 px and at the ROG Ally's 1920×1080 at 150% scaling.

- [ ] **Step 1: Write failing e2e test** (start `createApp` with fake driver returning fixture PNG/MP4 and a scheduler with `tickMs 100`; drive with playwright-core headless Chrome)

```js
test("create → queue → library flow", async () => {
  // add account via API + verify → ready
  // open "/", tab Tạo mới, choose Video, fill prompt "mèo", duration 12, keep 1080p, click "Thêm vào hàng đợi"
  // Hàng đợi tab shows a row containing "mèo"; within 20 s the row shows "Xong"
  // Thư viện tab has 1 <video> whose src starts with "/files/"
});
test("bulk mode creates one job per line", ...)
test("no_accounts banner shows when the only account is disabled", ...)
```

- [ ] **Step 2: Run — expect FAIL** · **Step 3: Implement** · **Step 4: Run — expect PASS** · **Step 5: Commit** `feat: web ui`.

---

### Task 9: Wiring, launcher, README

**Files:**
- Create: `src/main.js`, `start.bat`, `README.md`
- Test: `test/main.test.js`

**Interfaces:**
- Consumes: everything.
- Produces: `startServer({ root = ROOT, port = Number(process.env.PORT) || 3000, driver } = {}) → Promise<{ url, close() }>` in `src/main.js`; running the file directly calls it and opens the default browser with `spawn("cmd", ["/c", "start", "", url])`.

`startServer`: `getPaths` + `ensureDirs`, stores at `data/accounts.json` (`[]`), `data/jobs.json` (`[]`), `data/settings.json` (`{}`), `jobs.recoverOnStartup()`, real driver unless one is injected, runner, scheduler (`start()`), app listening on `127.0.0.1`. `close()` stops the scheduler, `driver.closeAll()`, closes the server. `SIGINT` → `close()`.

`start.bat`: `cd /d "%~dp0"`, run `npm install` if `node_modules` is missing, then `node src/main.js`; `pause` on error. README (Vietnamese): requirements (Node 24, ffmpeg, Chrome), how to start, how to add an account and log in, what 1080p/duration really do, ban-risk note, where files go, how to fix selectors (`src/muse/selectors.js`).

- [ ] **Step 1: Failing test** — `startServer({ root: tmp, port: 0, driver: fake })` → `GET /api/state` 200; a job left `running` in `data/jobs.json` before start comes back `queued`; `close()` resolves.
- [ ] **Step 2: Run — FAIL** · **Step 3: Implement** · **Step 4: `npm test` — whole suite PASS** · **Step 5: Commit** `feat: launcher and wiring`.

---

### Task 10: Live check on muse.ai (needs the user)

**Files:**
- Modify (only if the live DOM differs): `src/muse/selectors.js`, `src/muse/driver.js`, `src/muse/classify.js`

Each step that sends a message spends the account's quota — **ask the user before it**.

- [ ] **Step 1:** `start.bat`; add account "Thử 1" in the UI; the user logs in to muse.ai in the opened Chrome window; click "Đã đăng nhập" → state "Sẵn sàng".
- [ ] **Step 2 (no quota):** with a small script using `createMuseDriver`, attach one PNG through `FILE_INPUT`, confirm the preview appears (Step 3 of the driver algorithm), then remove it without sending. Fix the preview wait if it never matches.
- [ ] **Step 3 (ask first):** queue 1 image job with a reference image → expect status "Xong" and a `.webp` in `downloads/<today>/`.
- [ ] **Step 4 (ask first):** queue 1 video job, 15 s, 1080p → expect 2 raw clips and a final MP4 that `ffprobe` reports as 1080 on the short side, 15 ± 0.15 s, with audio.
- [ ] **Step 5:** note any real limit/refusal text seen and add it to `classify.js` keywords with a test case; commit `fix: tune muse.ai selectors from live run` (only if anything changed).
