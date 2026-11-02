import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAccountService } from "./accounts.js";
import { ROOT, createSettingsService, ensureDirs, getPaths } from "./config.js";
import { createJobService } from "./jobs.js";
import { createMuseDriver } from "./muse/driver.js";
import { createRunner } from "./runner.js";
import { createScheduler } from "./scheduler.js";
import { createApp } from "./server.js";
import { createJsonStore } from "./store.js";

export async function startServer({ root = ROOT, port = Number(process.env.PORT) || 3000, driver } = {}) {
  const paths = getPaths(root);
  ensureDirs(paths);
  const settings = createSettingsService(createJsonStore(path.join(paths.data, "settings.json"), {}));
  const getSettings = () => settings.get();
  const accounts = createAccountService({
    store: createJsonStore(path.join(paths.data, "accounts.json"), []),
    profilesDir: paths.profiles,
  });
  const jobs = createJobService({ store: createJsonStore(path.join(paths.data, "jobs.json"), []) });

  const museDriver = driver ?? createMuseDriver({ profilesDir: paths.profiles, errorsDir: paths.errors, getSettings });
  const runner = createRunner({ driver: museDriver, jobs, paths, getSettings });
  const scheduler = createScheduler({ accounts, jobs, getSettings, runJob: runner.runJob, driver: museDriver });
  const app = createApp({ accounts, jobs, scheduler, driver: museDriver, settings, paths });

  // Giữ được cổng rồi mới đụng vào dữ liệu: nếu tool đã chạy sẵn, bản thứ hai phải dừng
  // trước khi kịp đổi trạng thái hàng đợi của bản đang chạy.
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  jobs.recoverOnStartup();
  scheduler.start();

  const url = `http://localhost:${server.address().port}`;
  return {
    url,
    async close() {
      scheduler.stop();
      await museDriver.closeAll();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

// --no-open: chạy ngầm (lệnh "npm run muse -- start", hoặc khi Claude bật tool), không mở tab trình duyệt.
const openBrowser = (url) => {
  if (process.argv.includes("--no-open")) return;
  spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT) || 3000;
  try {
    const server = await startServer({ port });
    console.log(`Muse Manager đang chạy tại ${server.url}`);
    console.log("Giữ cửa sổ này mở trong khi dùng tool. Bấm Ctrl+C để tắt.");
    openBrowser(server.url);
    process.on("SIGINT", async () => {
      console.log("Đang tắt…");
      await server.close();
      process.exit(0);
    });
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      console.log(`Cổng ${port} đang được dùng, có thể tool đã mở rồi. Mở lại trang http://localhost:${port}`);
      openBrowser(`http://localhost:${port}`);
    } else {
      console.error("Không khởi động được tool:", err);
    }
    process.exit(1);
  }
}
