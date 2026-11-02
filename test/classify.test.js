import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReply } from "../src/muse/classify.js";

test("classifyReply detects limits", () => {
  assert.equal(classifyReply("You've reached your daily limit. Upgrade to continue."), "LIMIT");
  assert.equal(classifyReply("Bạn đã hết lượt tạo video hôm nay, thử lại ngày mai nhé"), "LIMIT");
  assert.equal(classifyReply("Sorry, I can't make more videos — you're out of credits"), "LIMIT");
});

test("classifyReply detects refusals", () => {
  assert.equal(classifyReply("I can't create that because it goes against our policy"), "REFUSED");
  assert.equal(classifyReply("Mình không thể tạo nội dung này vì vi phạm chính sách"), "REFUSED");
});

test("classifyReply falls back to NO_MEDIA", () => {
  assert.equal(classifyReply("Bạn muốn mèo màu gì?"), "NO_MEDIA");
  assert.equal(classifyReply(""), "NO_MEDIA");
  assert.equal(classifyReply(undefined), "NO_MEDIA");
});
