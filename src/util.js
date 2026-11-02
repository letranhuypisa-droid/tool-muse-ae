import crypto from "node:crypto";

// Lỗi do dữ liệu người dùng nhập sai; message luôn là tiếng Việt để hiện thẳng lên giao diện.
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

export function localDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function randomBetween(min, max, random = Math.random) {
  return min + (max - min) * random();
}
