import { spawn } from "node:child_process";
import fs from "node:fs";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export class FfmpegError extends Error {
  constructor(message) {
    super(message);
    this.name = "FfmpegError";
  }
}

function run(cmd, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new FfmpegError("Đã hủy"));
    const p = spawn(cmd, args, { windowsHide: true, signal });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-20000)));
    p.on("error", (e) =>
      reject(new FfmpegError(e.name === "AbortError" ? "Đã hủy" : `Không chạy được ${cmd}: ${e.message}`)),
    );
    p.on("close", (code) => {
      if (code === 0) return resolve(out);
      const tail = err.trim().split(/\r?\n/).slice(-20).join("\n");
      reject(new FfmpegError(`${cmd} lỗi (mã ${code}):\n${tail}`));
    });
  });
}

function parseRate(rate) {
  const [num, den] = String(rate || "").split("/").map(Number);
  const fps = den ? num / den : num;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : 0;
}

// r_frame_rate có thể là 90000/1 với video tốc độ khung hình thay đổi: dùng avg_frame_rate và chặn giá trị vô lý,
// nếu không bộ lọc fps sẽ sinh ra hàng triệu khung hình.
export function streamFps(stream) {
  for (const rate of [stream?.avg_frame_rate, stream?.r_frame_rate]) {
    const fps = parseRate(rate);
    if (fps >= 1 && fps <= 120) return fps;
  }
  return 30;
}

export async function probe(file) {
  const json = JSON.parse(await run(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));
  const video = json.streams.find((s) => s.codec_type === "video");
  if (!video) throw new FfmpegError(`Không tìm thấy hình trong file: ${file}`);
  return {
    width: video.width,
    height: video.height,
    duration: Number(json.format?.duration) || 0,
    fps: streamFps(video),
    hasAudio: json.streams.some((s) => s.codec_type === "audio"),
  };
}

const even = (n) => Math.round(n / 2) * 2;

export function targetSize(width, height, upscale1080) {
  if (!upscale1080) return { width, height };
  if (width >= height) return { width: even((width * 1080) / height), height: 1080 };
  return { width: 1080, height: even((height * 1080) / width) };
}

// Đọc giây cuối và ghi đè liên tục ra một file ảnh: file còn lại chính là khung hình cuối.
export async function extractLastFrame(input, outputPng) {
  await run(FFMPEG, ["-nostdin", "-hide_banner", "-loglevel", "error", "-sseof", "-1", "-i", input, "-update", "1", "-y", outputPng]);
}

export function buildFinalizeArgs({ inputs, output, width, height, fps, trimSec, upscale1080 }) {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  for (const input of inputs) args.push("-i", input.path);

  const filters = [];
  const joinPads = [];
  let extraIndex = inputs.length;
  inputs.forEach((input, i) => {
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
    );
    if (input.hasAudio) {
      filters.push(`[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      // Clip không có tiếng: chèn một đoạn im lặng cùng độ dài để concat vẫn có luồng âm thanh.
      args.push("-f", "lavfi", "-t", String(input.duration), "-i", "anullsrc=r=48000:cl=stereo");
      filters.push(`[${extraIndex}:a]acopy[a${i}]`);
      extraIndex += 1;
    }
    joinPads.push(`[v${i}][a${i}]`);
  });
  filters.push(`${joinPads.join("")}concat=n=${inputs.length}:v=1:a=1[vc][ac]`);

  const target = targetSize(width, height, upscale1080);
  filters.push(
    upscale1080
      ? `[vc]scale=${target.width}:${target.height}:flags=lanczos,unsharp=5:5:0.4[vout]`
      : "[vc]null[vout]",
  );

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "[ac]",
    "-t", String(trimSec),
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    "-y", output,
  );
  return args;
}

export async function finalizeVideo({ inputs, output, trimSec, upscale1080, signal }) {
  const probed = [];
  for (const file of inputs) {
    const p = await probe(file);
    probed.push({ path: file, hasAudio: p.hasAudio, duration: p.duration, width: p.width, height: p.height, fps: p.fps });
  }
  const base = probed[0];
  const args = buildFinalizeArgs({
    inputs: probed,
    output,
    width: base.width,
    height: base.height,
    fps: base.fps || 24,
    trimSec,
    upscale1080,
  });
  try {
    await run(FFMPEG, args, { signal });
  } catch (err) {
    fs.rmSync(output, { force: true });
    throw err;
  }
  const result = await probe(output);
  return { width: result.width, height: result.height, duration: result.duration };
}
