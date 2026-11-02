// Mẫu tin nhắn gửi cho trợ lý muse.ai. Người dùng sửa được trong Cài đặt; {prompt} là chỗ chèn prompt.
export const DEFAULT_TEMPLATES = Object.freeze({
  image: "Tạo ngay 1 ảnh, không cần hỏi lại: {prompt}",
  video: "Tạo ngay 1 video, không cần hỏi lại: {prompt}",
  continue: "Dùng ảnh đính kèm làm khung hình mở đầu, tạo ngay 1 video nối tiếp liền mạch, không cần hỏi lại: {prompt}",
  refSuffix: "Dùng ảnh đính kèm làm ảnh tham chiếu.",
});

export function buildMessage(templates, { kind, prompt, hasRefs }) {
  const text = templates[kind].replace("{prompt}", () => prompt);
  if (hasRefs && kind !== "continue") return `${text} ${templates.refSuffix}`;
  return text;
}
