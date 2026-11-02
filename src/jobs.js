import { notifyChange } from "./events.js";
import { planClips } from "./planner.js";
import { NotFoundError, ValidationError, newId } from "./util.js";

const MAX_PROMPT = 4000;
const MAX_REFS = 9;
const MAX_COUNT = 20;

function validate(input) {
  const { type, prompt, refImages = [], durationSec = 10, upscale1080 = true, count = 1 } = input ?? {};
  if (type !== "image" && type !== "video") throw new ValidationError("Loại việc phải là Ảnh hoặc Video");
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text) throw new ValidationError("Bạn chưa nhập prompt");
  if (text.length > MAX_PROMPT) throw new ValidationError(`Prompt tối đa ${MAX_PROMPT} ký tự`);
  if (!Array.isArray(refImages) || refImages.length > MAX_REFS || refImages.some((r) => typeof r !== "string")) {
    throw new ValidationError(`Tối đa ${MAX_REFS} ảnh tham chiếu`);
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new ValidationError(`Số bản phải từ 1 đến ${MAX_COUNT}`);
  }
  if (type === "video") {
    planClips(durationSec);
    if (typeof upscale1080 !== "boolean") throw new ValidationError("Tùy chọn 1080p không hợp lệ");
  }
  return {
    type,
    prompt: text,
    refImages,
    durationSec: type === "video" ? durationSec : null,
    upscale1080: type === "video" ? upscale1080 : null,
    count,
  };
}

export function createJobService({ store, now = () => new Date() }) {
  function mutate(id, fn) {
    let result;
    store.update((list) => {
      const i = list.findIndex((j) => j.id === id);
      if (i < 0) throw new NotFoundError("Không tìm thấy việc");
      list[i] = { ...fn({ ...list[i] }), updatedAt: now().toISOString() };
      result = list[i];
      return list;
    });
    notifyChange();
    return result;
  }

  const get = (id) => store.read().find((j) => j.id === id);

  function requireStatus(id, allowed, message) {
    const job = get(id);
    if (!job) throw new NotFoundError("Không tìm thấy việc");
    if (!allowed.includes(job.status)) throw new ValidationError(message);
  }

  return {
    get,
    list: () => [...store.read()].reverse(),
    nextQueued: () => store.read().find((j) => j.status === "queued"),

    enqueue(input) {
      const v = validate(input);
      const made = [];
      for (let i = 0; i < v.count; i++) {
        const stamp = now().toISOString();
        made.push({
          id: newId("job"),
          type: v.type,
          prompt: v.prompt,
          refImages: [...v.refImages],
          durationSec: v.durationSec,
          upscale1080: v.upscale1080,
          status: "queued",
          progress: { clip: 0, totalClips: v.type === "video" ? planClips(v.durationSec).totalClips : 1 },
          accountId: null,
          attempts: 0,
          rawFiles: [],
          outputs: [],
          replyText: null,
          error: null,
          createdAt: stamp,
          updatedAt: stamp,
        });
      }
      store.update((list) => [...list, ...made]);
      notifyChange();
      return made;
    },

    update: (id, patch) => mutate(id, (j) => ({ ...j, ...patch })),

    cancel(id) {
      requireStatus(id, ["queued", "running", "postprocessing"], "Chỉ hủy được việc đang chờ hoặc đang chạy");
      return mutate(id, (j) => ({ ...j, status: "cancelled" }));
    },

    retry(id) {
      requireStatus(id, ["failed", "refused", "cancelled"], "Chỉ chạy lại được việc lỗi, bị từ chối hoặc đã hủy");
      return mutate(id, (j) => ({ ...j, status: "queued", attempts: 0, error: null, accountId: null }));
    },

    remove(id) {
      requireStatus(id, ["queued", "done", "failed", "refused", "cancelled"], "Không xóa được việc đang chạy");
      store.update((list) => list.filter((j) => j.id !== id));
      notifyChange();
    },

    recoverOnStartup() {
      let n = 0;
      const stamp = now().toISOString();
      store.update((list) =>
        list.map((j) => {
          if (j.status !== "running" && j.status !== "postprocessing") return j;
          n += 1;
          return { ...j, status: "queued", accountId: null, updatedAt: stamp };
        }),
      );
      if (n) notifyChange();
      return n;
    },
  };
}
