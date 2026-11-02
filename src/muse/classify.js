// Đoán lý do khi trợ lý trả lời mà không có ảnh/video. Bổ sung từ khóa khi gặp câu thật.
export const LIMIT_KEYWORDS = [
  "limit", "credit", "quota", "upgrade", "out of", "try again tomorrow",
  "giới hạn", "hết lượt", "hết credit", "nâng cấp", "ngày mai",
];

export const REFUSAL_KEYWORDS = [
  "can't", "can’t", "cannot", "unable to", "policy", "guidelines",
  "không thể", "chính sách", "vi phạm",
];

export function classifyReply(text) {
  const t = String(text ?? "").toLowerCase();
  if (LIMIT_KEYWORDS.some((k) => t.includes(k))) return "LIMIT";
  if (REFUSAL_KEYWORDS.some((k) => t.includes(k))) return "REFUSED";
  return "NO_MEDIA";
}
