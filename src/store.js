import fs from "node:fs";
import path from "node:path";

// Lưu một giá trị JSON vào file. Ghi qua file tạm rồi rename để không bao giờ để lại file ghi dở.
export function createJsonStore(filePath, defaultValue) {
  const fresh = () => structuredClone(defaultValue);

  function read() {
    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return fresh();
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      return fresh();
    }
  }

  function write(value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, filePath);
  }

  function update(fn) {
    const next = fn(read());
    write(next);
    return next;
  }

  return { read, write, update };
}
