import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ghostBootHtml, ghostFileMime, resolveGhostFilePath } from '../ghostFiles.js';

const ROOT = path.resolve('/fake/brain/demo');

describe('resolveGhostFilePath · 供片路径守卫', () => {
  it('正常相对路径解析到安装目录内', () => {
    expect(resolveGhostFilePath(ROOT, '/main.js')).toBe(path.join(ROOT, 'main.js'));
    expect(resolveGhostFilePath(ROOT, '/assets/a.png')).toBe(path.join(ROOT, 'assets', 'a.png'));
  });

  it('路径穿越一律拒绝(裸 ../ 与百分号编码)', () => {
    expect(resolveGhostFilePath(ROOT, '/../evil.js')).toBeNull();
    expect(resolveGhostFilePath(ROOT, '/a/../../evil.js')).toBeNull();
    expect(resolveGhostFilePath(ROOT, '/%2e%2e/evil.js')).toBeNull();
    expect(resolveGhostFilePath(ROOT, '/a/%2e%2e/%2e%2e/evil.js')).toBeNull();
  });

  it('反斜杠 / 空段 / 隐藏文件段 / 非法编码拒绝', () => {
    expect(resolveGhostFilePath(ROOT, '/a\\b.js')).toBeNull();
    expect(resolveGhostFilePath(ROOT, '//a.js')).toBeNull();
    expect(resolveGhostFilePath(ROOT, '/.env')).toBeNull();
    expect(resolveGhostFilePath(ROOT, '/%zz')).toBeNull();
  });
});

describe('ghostFileMime / ghostBootHtml', () => {
  it('常见扩展名 MIME 正确,未知回退二进制', () => {
    expect(ghostFileMime('a.js')).toContain('text/javascript');
    expect(ghostFileMime('a.html')).toContain('text/html');
    expect(ghostFileMime('a.wasm')).toBe('application/octet-stream');
  });

  it('启动文档引用 entry 且带 CSP', () => {
    const html = ghostBootHtml('main.js');
    expect(html).toContain('<script src="/main.js">');
    expect(html).toContain('Content-Security-Policy');
    // boot 同时受 meta 与响应头 CSP 约束；meta 相对基线只增加 HTTPS 图片，
    // 不能把响应头原有的 data/blob 图片或 media 能力带进有效交集。
    expect(html).toContain("img-src 'self' https:");
    expect(html).not.toContain("img-src 'self' data:");
    expect(html).not.toContain('blob:');
    expect(html).not.toContain('media-src');
  });
});
