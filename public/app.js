const $ = (sel, el = document) => el.querySelector(sel);

const JOB_STATUS = {
  queued: ["Chờ", ""],
  running: ["Đang tạo", "run"],
  postprocessing: ["Hậu kỳ", "run"],
  done: ["Xong", "ok"],
  failed: ["Lỗi", "bad"],
  refused: ["Bị từ chối", "bad"],
  cancelled: ["Đã hủy", ""],
};
const ACCOUNT_STATE = {
  needs_login: ["Cần đăng nhập", "warn"],
  ready: ["Sẵn sàng", "ok"],
  cooldown: ["Hết lượt", "warn"],
  error: ["Lỗi", "bad"],
};

let state = null;
let activeTab = "create";
let jobType = "video";
let refs = []; // [{ path, url }]
let libraryKey = "";

// ---------- tiện ích ----------
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `Lỗi ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 3200);
}

const run = (fn) => (...args) => fn(...args).catch((err) => toast(err.message, true));

function timeText(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

const clipText = (sec) => `${sec} giây · ${Math.ceil(sec / 10)} clip`;
const accountName = (id) => state?.accounts.find((a) => a.id === id)?.name ?? "";

// ---------- tab ----------
function showTab(name) {
  activeTab = name;
  for (const tab of document.querySelectorAll("[role=tab]")) {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll("[role=tabpanel]")) {
    panel.hidden = panel.id !== `tab-${name}`;
  }
  if (name === "settings") renderSettings();
  if (name === "library") loadLibrary(true);
  render();
}

// ---------- render chung ----------
function render() {
  if (!state) return;
  const { scheduler, jobs, accounts } = state;
  $("#queue-status").textContent = scheduler.paused
    ? "Hàng đợi đang tạm dừng"
    : scheduler.running
      ? `Đang chạy ${scheduler.running} việc`
      : scheduler.waiting === "resting"
        ? "Tài khoản đang nghỉ giữa 2 việc (giảm rủi ro bị khóa)"
        : "Đang chờ việc";
  $("#toggle-queue").textContent = scheduler.paused ? "Chạy tiếp" : "Tạm dừng";
  $("#banner").hidden = scheduler.waiting !== "no_accounts";

  const pending = jobs.filter((j) => ["queued", "running", "postprocessing"].includes(j.status)).length;
  $("#count-queue").textContent = pending || "";
  $("#count-accounts").textContent = accounts.length || "";

  if (activeTab === "queue") renderQueue();
  if (activeTab === "accounts") renderAccounts();
  if (activeTab === "library") loadLibrary(false);
}

// ---------- hàng đợi ----------
function jobLabel(job) {
  if (job.type === "image") return "Ảnh";
  return `Video ${job.durationSec}s${job.upscale1080 ? " · 1080p" : ""}`;
}

function renderQueue() {
  const list = $("#queue-list");
  if (!state.jobs.length) {
    list.innerHTML = `<div class="empty">Chưa có việc nào. Vào tab "Tạo mới" để thêm.</div>`;
    return;
  }
  list.innerHTML = state.jobs
    .map((job) => {
      const [label, cls] = JOB_STATUS[job.status] ?? [job.status, ""];
      const progress =
        job.type === "video" && job.status === "running" ? ` · clip ${job.progress.clip}/${job.progress.totalClips}` : "";
      const running = ["running", "postprocessing"].includes(job.status);
      const actions = [];
      if (["queued", "running", "postprocessing"].includes(job.status)) actions.push(["cancel", "Hủy"]);
      if (["failed", "refused", "cancelled"].includes(job.status)) actions.push(["retry", "Thử lại"]);
      if (job.status === "done" && job.outputs[0]) actions.push(["folder", "Mở thư mục"]);
      if (!running) actions.push(["delete", "Xóa"]);
      const showReply = job.status !== "done" && job.replyText;
      return `
        <div class="job" data-job-row data-id="${esc(job.id)}">
          <div class="job-main">
            <span class="tag">${esc(jobLabel(job))}${job.refImages.length ? ` · ${job.refImages.length} ảnh tham chiếu` : ""}</span>
            <p class="job-prompt" title="${esc(job.prompt)}">${esc(job.prompt)}</p>
            <div class="meta">
              <span>Tạo lúc ${esc(timeText(job.createdAt))}</span>
              ${job.accountId ? `<span>Tài khoản: ${esc(accountName(job.accountId))}</span>` : ""}
              ${job.attempts ? `<span>Đã thử ${job.attempts} lần</span>` : ""}
            </div>
            ${job.error && job.status !== "done" ? `<div class="note">${esc(job.error)}</div>` : ""}
            ${showReply ? `<div class="note soft">Muse trả lời: “${esc(job.replyText)}”</div>` : ""}
          </div>
          <div class="job-side">
            <span class="badge ${cls}">${esc(label)}${esc(progress)}</span>
            <div class="actions">
              ${actions.map(([act, text]) => `<button class="btn${act === "delete" ? " danger" : ""}" data-act="${act}">${text}</button>`).join("")}
            </div>
          </div>
        </div>`;
    })
    .join("");
}

$("#queue-list").addEventListener(
  "click",
  run(async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.closest("[data-job-row]").dataset.id;
    const job = state.jobs.find((j) => j.id === id);
    btn.disabled = true;
    try {
      if (btn.dataset.act === "cancel") await api("POST", `/api/jobs/${id}/cancel`);
      if (btn.dataset.act === "retry") await api("POST", `/api/jobs/${id}/retry`);
      if (btn.dataset.act === "delete") await api("DELETE", `/api/jobs/${id}`);
      if (btn.dataset.act === "folder") await api("POST", "/api/open-folder", { path: job.outputs[0] });
    } finally {
      btn.disabled = false;
    }
  }),
);

$("#toggle-queue").addEventListener(
  "click",
  run(async () => {
    await api("POST", state?.scheduler.paused ? "/api/queue/resume" : "/api/queue/pause");
  }),
);

// ---------- tài khoản ----------
function renderAccounts() {
  const list = $("#account-list");
  if (!state.accounts.length) {
    list.innerHTML = `<div class="empty">Chưa có tài khoản nào.</div>`;
    return;
  }
  list.innerHTML = state.accounts
    .map((a) => {
      let [label, cls] = ACCOUNT_STATE[a.state] ?? [a.state, ""];
      if (a.state === "cooldown" && a.cooldownUntil) label = `Hết lượt đến ${timeText(a.cooldownUntil)}`;
      const today = new Date().toDateString() === new Date(a.usage?.date + "T00:00").toDateString() ? a.usage.jobs : 0;
      return `
        <div class="card account" data-account-card data-id="${esc(a.id)}">
          <h3>${esc(a.name)} <span class="badge ${cls}">${esc(label)}</span>${a.busy ? `<span class="badge run">Đang chạy</span>` : ""}</h3>
          <div class="meta">
            <span>Hôm nay: ${today} việc</span>
            ${a.lastUsedAt ? `<span>Dùng lần cuối ${esc(timeText(a.lastUsedAt))}</span>` : ""}
          </div>
          ${a.state === "needs_login" ? `<p class="hint">Đăng nhập muse.ai trong cửa sổ Chrome của tài khoản này, xong bấm nút bên dưới.</p>` : ""}
          ${a.lastError && a.state !== "ready" ? `<div class="note">${esc(a.lastError)}</div>` : ""}
          <label class="check"><input type="checkbox" data-act="toggle" ${a.enabled ? "checked" : ""}> Dùng tài khoản này</label>
          <div class="actions" style="justify-content:flex-start">
            ${a.state === "needs_login" ? `<button class="btn primary" data-act="verify">Đã đăng nhập</button>` : ""}
            <button class="btn" data-act="open" ${a.busy ? "disabled" : ""}>Mở cửa sổ</button>
            ${a.state !== "needs_login" ? `<button class="btn" data-act="verify" ${a.busy ? "disabled" : ""}>Kiểm tra đăng nhập</button>` : ""}
            <button class="btn" data-act="rename">Đổi tên</button>
            <button class="btn danger" data-act="delete" ${a.busy ? "disabled" : ""}>Xóa</button>
          </div>
        </div>`;
    })
    .join("");
}

$("#account-list").addEventListener(
  "click",
  run(async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.dataset.act === "toggle") return;
    const id = el.closest("[data-account-card]").dataset.id;
    const account = state.accounts.find((a) => a.id === id);
    if (el.dataset.act === "open") {
      await api("POST", `/api/accounts/${id}/open`);
      toast("Đã mở cửa sổ Chrome của tài khoản");
    }
    if (el.dataset.act === "verify") {
      el.disabled = true;
      try {
        const updated = await api("POST", `/api/accounts/${id}/verify`);
        toast(updated.state === "ready" ? "Đăng nhập OK, tài khoản sẵn sàng" : "Chưa thấy đăng nhập muse.ai", updated.state !== "ready");
      } finally {
        el.disabled = false;
      }
    }
    if (el.dataset.act === "rename") {
      const name = prompt("Tên mới cho tài khoản", account.name);
      if (name !== null) await api("PATCH", `/api/accounts/${id}`, { name });
    }
    if (el.dataset.act === "delete" && confirm(`Xóa tài khoản "${account.name}" và hồ sơ Chrome của nó?`)) {
      await api("DELETE", `/api/accounts/${id}`);
    }
  }),
);

$("#account-list").addEventListener(
  "change",
  run(async (e) => {
    if (e.target.dataset.act !== "toggle") return;
    const id = e.target.closest("[data-account-card]").dataset.id;
    await api("PATCH", `/api/accounts/${id}`, { enabled: e.target.checked });
  }),
);

$("#account-form").addEventListener(
  "submit",
  run(async (e) => {
    e.preventDefault();
    const input = $("#account-name");
    await api("POST", "/api/accounts", { name: input.value });
    input.value = "";
    toast("Đã mở cửa sổ Chrome, hãy đăng nhập muse.ai trong đó");
  }),
);

// ---------- thư viện ----------
async function loadLibrary(force) {
  const key = state ? state.jobs.filter((j) => j.status === "done").map((j) => j.id).join(",") : "";
  if (!force && key === libraryKey) return;
  libraryKey = key;
  const items = await api("GET", "/api/library").catch(() => []);
  const list = $("#library-list");
  const count = items.reduce((n, j) => n + j.items.length, 0);
  $("#library-summary").textContent = count ? `${count} file` : "";
  if (!count) {
    list.innerHTML = `<div class="empty">Chưa có kết quả nào.</div>`;
    return;
  }
  list.innerHTML = items
    .flatMap((job) =>
      job.items.map(
        (item, index) => `
        <div class="card media-card" data-job="${esc(job.id)}" data-index="${index}" data-path="${esc(item.path)}">
          ${item.kind === "video"
            ? `<video src="${esc(item.url)}" controls preload="metadata"></video>`
            : `<img src="${esc(item.url)}" alt="" loading="lazy">`}
          <div class="media-body">
            <span class="tag">${item.kind === "video" ? `Video ${job.durationSec ?? ""}s` : "Ảnh"} · ${esc(timeText(job.updatedAt))}</span>
            <p class="job-prompt" title="${esc(job.prompt)}">${esc(job.prompt)}</p>
            <div class="actions" style="justify-content:flex-start">
              <a class="btn" href="${esc(item.url)}" download>Tải về</a>
              <button class="btn" data-act="folder">Mở thư mục</button>
              ${item.kind === "image" ? `<button class="btn" data-act="ref">Dùng làm tham chiếu</button>` : ""}
            </div>
          </div>
        </div>`,
      ),
    )
    .join("");
}

$("#library-list").addEventListener(
  "click",
  run(async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const card = btn.closest(".media-card");
    if (btn.dataset.act === "folder") await api("POST", "/api/open-folder", { path: card.dataset.path });
    if (btn.dataset.act === "ref") {
      const ref = await api("POST", `/api/library/${card.dataset.job}/use-as-ref`, { index: Number(card.dataset.index) });
      refs.push(ref);
      renderRefs();
      showTab("create");
      toast("Đã thêm ảnh vào ảnh tham chiếu");
    }
  }),
);

$("#open-downloads").addEventListener("click", run(() => api("POST", "/api/open-folder", { path: "" })));

// ---------- tạo mới ----------
function setType(type) {
  jobType = type;
  for (const b of document.querySelectorAll("[data-type]")) b.setAttribute("aria-pressed", String(b.dataset.type === type));
  $("#video-options").hidden = type !== "video";
}

function updateBulk() {
  const bulk = $("#bulk").checked;
  $("#prompt").placeholder = bulk ? "Mỗi dòng là một prompt riêng…" : "Mô tả ảnh/video bạn muốn tạo…";
  $("#prompt-hint").textContent = bulk
    ? "Mỗi dòng không trống sẽ thành một việc, dùng chung ảnh tham chiếu và tùy chọn bên dưới."
    : "Muse sẽ nhận đúng nội dung này kèm câu yêu cầu tạo ngay.";
}

function renderRefs() {
  $("#refs").innerHTML = refs
    .map((r, i) => `<div class="ref"><img src="${esc(r.url)}" alt=""><button type="button" data-i="${i}" aria-label="Bỏ ảnh">✕</button></div>`)
    .join("");
}

async function uploadFiles(files) {
  $("#create-error").textContent = "";
  if (!files.length) return;
  if (refs.length + files.length > 9) throw new Error("Tối đa 9 ảnh tham chiếu");
  const form = new FormData();
  for (const f of files) form.append("files", f);
  const res = await fetch("/api/uploads", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  refs.push(...data);
  renderRefs();
}

const showCreateError = (err) => ($("#create-error").textContent = err.message);

for (const b of document.querySelectorAll("[data-type]")) b.addEventListener("click", () => setType(b.dataset.type));
$("#bulk").addEventListener("change", updateBulk);
$("#duration").addEventListener("input", (e) => ($("#duration-out").textContent = clipText(Number(e.target.value))));
$("#refs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-i]");
  if (!b) return;
  refs.splice(Number(b.dataset.i), 1);
  renderRefs();
});

const dropzone = $("#dropzone");
dropzone.addEventListener("click", () => $("#ref-input").click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    $("#ref-input").click();
  }
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("over");
  uploadFiles([...e.dataTransfer.files]).catch(showCreateError);
});
$("#ref-input").addEventListener("change", (e) => {
  uploadFiles([...e.target.files]).catch(showCreateError).finally(() => (e.target.value = ""));
});

$("#create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#create-error").textContent = "";
  const common = {
    type: jobType,
    refImages: refs.map((r) => r.path),
    count: Number($("#count").value) || 1,
    durationSec: Number($("#duration").value),
    upscale1080: $("#upscale").checked,
  };
  const text = $("#prompt").value;
  try {
    const made = $("#bulk").checked
      ? await api("POST", "/api/jobs/bulk", { ...common, lines: text })
      : await api("POST", "/api/jobs", { ...common, prompt: text });
    toast(`Đã thêm ${made.length} việc vào hàng đợi`);
    $("#prompt").value = "";
    refs = [];
    renderRefs();
  } catch (err) {
    showCreateError(err);
  }
});

// ---------- cài đặt ----------
const TEMPLATE_KEYS = ["image", "video", "continue", "refSuffix"];

function renderSettings() {
  if (!state) return;
  const form = $("#settings-form");
  const s = state.settings;
  for (const input of form.querySelectorAll("input[name]")) {
    if (input.type === "checkbox") input.checked = Boolean(s[input.name]);
    else input.value = s[input.name];
  }
  for (const key of TEMPLATE_KEYS) form.elements[`tpl-${key}`].value = s.messageTemplates[key];
  $("#settings-error").textContent = "";
}

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const patch = { messageTemplates: {} };
  for (const input of form.querySelectorAll("input[name]")) {
    patch[input.name] = input.type === "checkbox" ? input.checked : Number(input.value);
  }
  for (const key of TEMPLATE_KEYS) patch.messageTemplates[key] = form.elements[`tpl-${key}`].value;
  try {
    const saved = await api("PUT", "/api/settings", patch);
    state.settings = saved;
    renderSettings();
    toast("Đã lưu cài đặt");
  } catch (err) {
    $("#settings-error").textContent = err.message;
  }
});

// ---------- khởi động ----------
for (const tab of document.querySelectorAll("[role=tab]")) tab.addEventListener("click", () => showTab(tab.dataset.tab));

function connect() {
  const events = new EventSource("/api/events");
  events.addEventListener("state", (e) => {
    state = JSON.parse(e.data);
    render();
  });
  events.onerror = () => {
    $("#queue-status").textContent = "Mất kết nối tới tool, đang thử lại…";
  };
}

setType("video");
updateBulk();
connect();
