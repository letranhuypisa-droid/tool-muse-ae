import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
}

// Thư mục tạm có dấu cách trong tên, giống đường dẫn thật "tool muse AI".
export async function makeFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "muse fixtures "));
}

export async function makeClip(dir, name, { width, height, seconds = 10, audio = true }) {
  const out = path.join(dir, name);
  const args = ["-f", "lavfi", "-i", `testsrc=size=${width}x${height}:rate=24:duration=${seconds}`];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push("-y", out);
  await run(args);
  return out;
}

export async function makeImage(dir, name, { width, height }) {
  const out = path.join(dir, name);
  await run(["-f", "lavfi", "-i", `testsrc=size=${width}x${height}:rate=1`, "-frames:v", "1", "-y", out]);
  return out;
}
