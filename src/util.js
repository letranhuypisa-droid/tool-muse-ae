import crypto from "node:crypto";

// Lỗi do dữ liệu người dùng nhập sai; message luôn là tiếng Việt để hiện thẳng lên giao diện.
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "Không tìm thấy") {
    super(message);
    this.name = "NotFoundError";
  }
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

export function localDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Tên file an toàn trên Windows: bỏ dấu tiếng Việt, chỉ giữ a-z0-9 và dấu gạch.
export function slugify(text, maxLen = 40) {
  const ascii = String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
  const slug = ascii
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
  return slug || "untitled";
}

export function randomBetween(min, max, random = Math.random) {
  return min + (max - min) * random();
}
