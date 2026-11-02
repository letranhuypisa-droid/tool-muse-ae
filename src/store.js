import fs from "node:fs";
import path from "node:path";

// Trên Windows/OneDrive, file có thể bị khóa chốc lát (đồng bộ, antivirus): thử lại vài lần.
const LOCK_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!LOCK_CODES.has(err.code) || attempt >= 8) throw err;
      sleep(25 * attempt);
    }
  }
}

// Lưu một giá trị JSON vào file. Ghi qua file tạm rồi rename để không bao giờ để lại file ghi dở.
export function createJsonStore(filePath, defaultValue) {
  const fresh = () => structuredClone(defaultValue);

  function read() {
    let text;
    try {
      text = withRetry(() => fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return fresh();
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      withRetry(() => fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`));
      return fresh();
    }
  }

  function write(value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    withRetry(() => fs.writeFileSync(tmp, JSON.stringify(value, null, 2)));
    withRetry(() => fs.renameSync(tmp, filePath));
  }

  function update(fn) {
    const next = fn(read());
    write(next);
    return next;
  }

  return { read, write, update };
}
