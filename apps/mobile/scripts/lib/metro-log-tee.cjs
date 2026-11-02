// sim-start 通过 NODE_OPTIONS 预加载:把 `expo start` 的输出同时追加到日志文件。
//
// 不用管道 tee:Expo 只在 stdout 是 TTY 时才启用交互(j / r 等快捷键)。也不用 Metro
// reporter:Expo 会强制覆盖 config.reporter。NODE_OPTIONS 会传给 pnpm 和 Metro worker,
// 所以只在 `expo start` 主进程生效。写日志失败不能影响 Metro。
const { closeSync, openSync, writeSync } = require("node:fs");
const { isMainThread } = require("node:worker_threads");

const logPath = process.env.CINDY_METRO_LOG_PATH;

if (logPath && isMainThread && !process.send && process.argv[2] === "start") {
  let fd = null;
  try {
    fd = openSync(logPath, "a", 0o600);
  } catch {
    // 拿不到日志文件时照常运行,logcheck 会报告日志缺失或没有打包记录。
  }
  if (fd !== null) {
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write;
      stream.write = function teeWrite(chunk, ...rest) {
        try {
          writeSync(fd, typeof chunk === "string" ? chunk : Buffer.from(chunk));
        } catch {
          // 磁盘满等情况下放弃这一段日志。
        }
        return write.call(stream, chunk, ...rest);
      };
    }
    process.once("exit", () => {
      try {
        closeSync(fd);
      } catch {
        // 进程正在退出。
      }
    });
  }
}
