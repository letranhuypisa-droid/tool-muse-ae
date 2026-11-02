import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-muse", "index.html");

// Phục vụ trang muse.ai giả cùng sample.mp4 / sample.png.
export function startFakeMuse({ mp4, png }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const files = { "/": [PAGE, "text/html"], "/sample.mp4": [mp4, "video/mp4"], "/sample.png": [png, "image/png"] };
    const hit = files[url.pathname];
    if (!hit) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": hit[1] });
    fs.createReadStream(hit[0]).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
