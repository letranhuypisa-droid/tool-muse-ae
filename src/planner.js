import { ValidationError } from "./util.js";

// muse.ai luôn trả video 10 giây.
export const CLIP_SECONDS = 10;
export const MAX_DURATION = 60;

export function planClips(durationSec) {
  if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > MAX_DURATION) {
    throw new ValidationError(`Thời lượng phải là số nguyên từ 1 đến ${MAX_DURATION} giây`);
  }
  return { totalClips: Math.ceil(durationSec / CLIP_SECONDS), trimSec: durationSec };
}
