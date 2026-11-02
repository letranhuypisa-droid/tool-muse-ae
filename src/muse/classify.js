// Đoán lý do khi trợ lý trả lời mà không có ảnh/video. Bổ sung khi gặp câu thật.
// Chỉ dùng cụm từ đủ dài: từ đơn như "limit", "ngày mai" hay xuất hiện trong câu hỏi lại của Muse
// (nhất là khi Muse nhắc lại prompt), và đoán nhầm "hết lượt" sẽ cho cả tài khoản nghỉ 24 giờ.
export const LIMIT_KEYWORDS = [
  "daily limit", "reached your limit", "reached the limit", "reached your daily", "usage limit",
  "limit for today", "limit reached", "out of credits", "no credits", "not enough credits",
  "run out of", "ran out of", "quota", "try again tomorrow", "come back tomorrow", "upgrade to",
  "hết lượt", "hết credit", "hết hạn mức", "đạt giới hạn", "vượt quá giới hạn", "giới hạn hôm nay",
  "giới hạn trong ngày", "giới hạn mỗi ngày", "thử lại vào ngày mai", "thử lại ngày mai", "quay lại vào ngày mai",
];

export const REFUSAL_KEYWORDS = [
  "can't help with", "can't create", "can't make", "can't generate", "can’t help with", "can’t create",
  "can’t make", "can’t generate", "cannot create", "cannot make", "cannot generate", "unable to create",
  "unable to generate", "against our policy", "content policy", "community standards", "violates",
  "không thể tạo", "không thể giúp", "không thể làm", "vi phạm", "chính sách",
];

export function classifyReply(text) {
  const t = String(text ?? "").toLowerCase();
  // muse.ai hiện dòng này dưới tin nhắn khi máy chủ không nhận được nó — Muse chưa hề đọc yêu cầu.
  if (t.includes("delivery not confirmed")) return "UNDELIVERED";
  if (LIMIT_KEYWORDS.some((k) => t.includes(k))) return "LIMIT";
  if (REFUSAL_KEYWORDS.some((k) => t.includes(k))) return "REFUSED";
  return "NO_MEDIA";
}
