import fs from "node:fs";
import path from "node:path";
import * as defaultFfmpeg from "./media/ffmpeg.js";
import { FfmpegError } from "./media/ffmpeg.js";
import { classifyReply } from "./muse/classify.js";
import { MuseError } from "./muse/errors.js";
import { buildMessage } from "./muse/messages.js";
import { planClips } from "./planner.js";
import { localDate, slugify } from "./util.js";

const ABORTED = Object.freeze({ ok: false, code: "TRANSIENT", message: "Đã hủy" });

const NO_MEDIA_MESSAGES = {
  LIMIT: "Tài khoản đã hết lượt",
  REFUSED: "Muse từ chối yêu cầu",
  NO_MEDIA: "Muse trả lời nhưng không gửi ảnh/video",
};

function noMedia(replyText) {
  const kind = classifyReply(replyText);
  return { ok: false, code: kind === "NO_MEDIA" ? "TRANSIENT" : kind, message: NO_MEDIA_MESSAGES[kind], replyText };
}

export function createRunner({ driver, jobs, paths, getSettings, ffmpeg = defaultFfmpeg, now = () => new Date() }) {
  const dayDir = () => {
    const dir = path.join(paths.downloads, localDate(now()));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  async function runImage(job, account) {
    const settings = getSettings();
    jobs.update(job.id, { progress: { clip: 1, totalClips: 1 } });
    const message = buildMessage(settings.messageTemplates, {
      kind: "image", prompt: job.prompt, hasRefs: job.refImages.length > 0,
    });
    const turn = await driver.runTurn(account.id, {
      message, files: job.refImages, timeoutMs: settings.imageTimeoutMin * 60_000, jobId: job.id,
    });
    const images = turn.media.filter((m) => m.kind === "image");
    if (!images.length) return noMedia(turn.replyText);
    const dir = dayDir();
    const outputs = images.map((img, i) => {
      const file = path.join(dir, `${job.id}_${i + 1}.${img.ext}`);
      fs.writeFileSync(file, img.bytes);
      return file;
    });
    jobs.update(job.id, { status: "done", outputs, replyText: turn.replyText, error: null });
    return { ok: true };
  }

  async function runVideo(job, account, signal) {
    const settings = getSettings();
    const { totalClips, trimSec } = planClips(job.durationSec);
    const rawFiles = [...job.rawFiles];

    for (let k = rawFiles.length + 1; k <= totalClips; k++) {
      if (signal?.aborted) return ABORTED;
      jobs.update(job.id, { progress: { clip: k, totalClips } });
      let files = job.refImages;
      if (k > 1) {
        const lastFrame = path.join(paths.raw, `${job.id}_clip${k - 1}_last.png`);
        await ffmpeg.extractLastFrame(rawFiles[k - 2], lastFrame);
        files = [lastFrame];
      }
      const kind = k === 1 ? "video" : "continue";
      const message = buildMessage(settings.messageTemplates, { kind, prompt: job.prompt, hasRefs: files.length > 0 });
      const turn = await driver.runTurn(account.id, {
        message, files, timeoutMs: settings.videoTimeoutMin * 60_000, jobId: job.id,
      });
      const clip = turn.media.find((m) => m.kind === "video");
      if (!clip) return noMedia(turn.replyText);
      const raw = path.join(paths.raw, `${job.id}_clip${k}.mp4`);
      fs.writeFileSync(raw, clip.bytes);
      rawFiles.push(raw);
      jobs.update(job.id, { rawFiles: [...rawFiles], replyText: turn.replyText });
    }

    if (signal?.aborted) return ABORTED;
    jobs.update(job.id, { status: "postprocessing", progress: { clip: totalClips, totalClips } });
    const output = path.join(dayDir(), `${job.id}_${slugify(job.prompt)}.mp4`);
    await ffmpeg.finalizeVideo({ inputs: rawFiles, output, trimSec, upscale1080: job.upscale1080 });
    jobs.update(job.id, { status: "done", outputs: [output], error: null });
    return { ok: true };
  }

  return {
    async runJob(job, account, { signal } = {}) {
      try {
        if (signal?.aborted) return ABORTED;
        return job.type === "image" ? await runImage(job, account) : await runVideo(job, account, signal);
      } catch (err) {
        if (err instanceof MuseError) {
          return { ok: false, code: err.code === "NOT_LOGGED_IN" ? "NOT_LOGGED_IN" : "TRANSIENT", message: err.message };
        }
        if (err instanceof FfmpegError) return { ok: false, code: "FFMPEG", message: err.message };
        return { ok: false, code: "TRANSIENT", message: err?.message || String(err) };
      } finally {
        await driver.close(account.id).catch(() => {});
      }
    },
  };
}
