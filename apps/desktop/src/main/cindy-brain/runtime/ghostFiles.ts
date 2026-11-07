import path from 'node:path';

import { isSafeGhostRelativePath } from '../../../shared/ghost.js';

/**
 * 意识沙箱文件供片的纯函数层:路径守卫 / MIME / 启动文档。
 * 与 Electron 解耦,单测直接覆盖(规范 14);唯一调用方是
 * electronSandboxAdapter 的 cindy-ghost:// 协议 handler。
 *
 * 安全模型(docs/dev-rules/plugin-security-and-authoring.md):沙箱能读的只有自己安装
 * 目录里的静态文件。URL 路径必须解码后仍是安全相对路径(复用清单同一套
 * 判定),再经 resolve + 前缀断言双保险,杜绝 ../ 与百分号编码穿越。
 */

/** 合成启动文档的保留路径(不对应磁盘文件)。 */
export const GHOST_BOOT_PATH = '/__boot__';
export const GHOST_MAIL_SDK_PATH = '/__cindy_mail__.js';

/**
 * 把请求 pathname 解析为安装目录内的绝对文件路径;任何越界 / 非法形态返回 null。
 * pathname 形如 `/main.js` / `/assets/a.png`(URL 已按 RFC 分段,这里统一再
 * decodeURIComponent 一次;解码失败 = 非法)。
 */
export function resolveGhostFilePath(installDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // 只剥一个前导斜杠:`//a.js` 剥完剩 `/a.js`,空段过不了安全判定,拒。
  const relative = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  if (!isSafeGhostRelativePath(relative)) return null;
  const resolved = path.resolve(installDir, relative);
  const root = path.resolve(installDir);
  // 前缀断言兜底(理论上 isSafeGhostRelativePath 已挡穿越;双保险不省)。
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function ghostFileMime(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 芯片型意识的合成启动文档:一个空白页 + <script src=entry>。
 * entry 已过清单校验(安全相对路径),此处只做 HTML 属性转义兜底。
 */
export function ghostBootHtml(entry: string): string {
  const src = `/${entry.replace(/"/g, '%22')}`;
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    // meta 与响应头 CSP 会取交集：保留原 default/style 约束，只为图片加入
    // HTTPS；不在这里继承响应头已有的 data:/blob:/media 放行。
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https:">`,
    '</head><body>',
    `<script src="${GHOST_MAIL_SDK_PATH}"></script>`,
    `<script src="${src}"></script>`,
    '</body></html>',
  ].join('');
}

/** library 投影的 MIME 按扩展名粗判(面板展示用;嗅探不做,宿主只供已存文件)。 */
export function mediaTypeForLibraryPath(relPath: string): string {
  const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.m4a': return 'audio/mp4';
    case '.pdf': return 'application/pdf';
    case '.json': return 'application/json; charset=utf-8';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}
