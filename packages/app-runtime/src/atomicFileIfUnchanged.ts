import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
export async function writeFileAtomicIfUnchanged(
  file: string,
  content: string,
  expectedText: string,
): Promise<boolean> {
  // 保留原文件权限:rename 会让 config.toml 继承 tmp 的 mode,若原文件被收紧过
  // (如 0600,内含 MCP env secrets),默认 umask 落出的 0644 会把它放宽。原文件
  // 不存在时用保守的 0600。writeFile 的 mode 受 umask 影响,故再显式 chmod 一次
  // (chmod 不受 umask 影响;Windows 上近似 no-op,无副作用)。
  let mode = 0o600;
  try {
    mode = (await fsp.stat(file)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Concurrent callers in the same process can reach this function during the
  // same millisecond. A pid/timestamp name lets them share and delete one
  // temporary file, which makes the winner's rename fail with ENOENT on
  // Windows. Keep every attempt on its own path so the compare-and-rename
  // protocol remains race-safe.
  const tmp = `${file}.xdt-plugins-sync.tmp-${process.pid}-${randomUUID()}`;
  await fsp.writeFile(tmp, content, { encoding: 'utf8', mode });
  try {
    await fsp.chmod(tmp, mode);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  let currentText = '';
  try {
    currentText = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }
  if (currentText !== expectedText) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    return false;
  }
  try {
    await fsp.rename(tmp, file);
    return true;
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

