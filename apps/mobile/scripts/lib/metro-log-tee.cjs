// sim-start 通过 NODE_OPTIONS 预加载:把 `expo start` 的输出同时追加到日志文件。
//
// 不用管道 tee:Expo 只在 stdout 是 TTY 时才启用交互(j / r 等快捷键)。也不用 Metro
// reporter:Expo 会强制覆盖 config.reporter。NODE_OPTIONS 会传给 pnpm 和 Metro worker,
// 所以只在 `expo start` 主进程生效。写日志失败不能影响 Metro。
//
// 日志一旦丢了一段(磁盘满、打不开),就删掉日志文件:这时留下的是不完整的内容,
// logcheck 读到它可能把后面的 ERROR 漏掉而误判通过;删掉后 logcheck 报「无法判定」。
// 删除文件不需要磁盘空间。
const fs = require("node:fs");
const { isMainThread } = require("node:worker_threads");

// 先清空再删除:目录不允许删文件时,清空后的日志没有启动标识,logcheck 同样判为无法判定。
// 清空和删除都不需要额外磁盘空间。
function discardLog(logPath, fsImpl, fd = null) {
  try {
    if (fd !== null) fsImpl.ftruncateSync(fd, 0);
    else fsImpl.truncateSync(logPath, 0);
  } catch {
    // 清空失败时仍尝试删除。
  }
  try {
    fsImpl.unlinkSync(logPath);
  } catch {
    // 文件本来就不在,或删不掉:已清空的日志也不会被判通过。
  }
}

// writeSync 在配额或磁盘将满时可能只写进一部分而不报错,写不完整就当作失败。
function writeAll(fd, chunk, fsImpl) {
  const bytes = Buffer.from(chunk);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fsImpl.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!(written > 0)) throw new Error("short write");
    offset += written;
  }
}

function installTee({ logPath, streams, fsImpl = fs, onExit }) {
  let fd = null;
  try {
    fd = fsImpl.openSync(logPath, "a", 0o600);
  } catch {
    discardLog(logPath, fsImpl);
    return;
  }
  let broken = false;
  for (const stream of streams) {
    const write = stream.write;
    stream.write = function teeWrite(chunk, ...rest) {
      if (!broken) {
        try {
          writeAll(fd, chunk, fsImpl);
        } catch {
          broken = true;
          discardLog(logPath, fsImpl, fd);
        }
      }
      return write.call(stream, chunk, ...rest);
    };
  }
  onExit?.(() => {
    try {
      fsImpl.closeSync(fd);
    } catch {
      // 进程正在退出。
    }
  });
}

module.exports = { installTee };

const logPath = process.env.CINDY_METRO_LOG_PATH;

if (logPath && isMainThread && !process.send && process.argv[2] === "start") {
  installTee({
    logPath,
    streams: [process.stdout, process.stderr],
    onExit: (callback) => process.once("exit", callback),
  });
}
