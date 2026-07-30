/**
 * hook-control/outbound 单测: xdt 引用收集/去重/限额与正文变换。
 * IO 全注入(readFile / resolveImageUrl), 不碰真盘。
 */

import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildHookPromptNote,
  collectOutboundAttachments,
  hasOutboundRefs,
  guessMime,
  xdtFileUrlToAbsPath,
} from '../outbound';

const log = { warn: vi.fn() };

beforeEach(() => {
  log.warn.mockClear();
});

describe('buildHookPromptNote', () => {
  it('Telegram 告知 Agent 使用 Rich Markdown 内容标准，Slack 保持原提示', () => {
    const telegram = buildHookPromptNote('telegram');
    expect(telegram).toContain('[Telegram 回复格式]');
    expect(telegram).toContain('GitHub Flavored Markdown');
    expect(telegram).toContain('不要输出原始 HTML');
    expect(telegram).toContain('不要在最终正文中复述过程');
    expect(telegram).toContain('附件发送不完整');
    expect(telegram).not.toContain('静默丢弃');
    expect(buildHookPromptNote('slack')).not.toContain('[Telegram 回复格式]');
  });

  it('两个平台都在开头声明「不是用户消息」,防止模型把渠道说明当成用户请求(2026-07 实踩)', () => {
    for (const im of ['telegram', 'slack'] as const) {
      const note = buildHookPromptNote(im);
      // guard 必须在附件正文之前出现,才能在模型读到附件指令前先定性。
      expect(note).toContain('不是用户发来的消息');
      expect(note).toContain('不要把它当作用户的请求');
      expect(note.indexOf('不是用户发来的消息')).toBeLessThan(note.indexOf('要把文件发给用户'));
    }
  });
});

function deps(
  files: Record<string, Buffer>,
  opts: {
    allowedFileRoots?: string[];
    realpaths?: Record<string, string>;
  } = {},
) {
  return {
    resolveImageUrl: (url: string) => ({
      absPath: url.replace('xdt-image://', '/cache/').replace('cindy-media://', '/blobs/'),
    }),
    allowedFileRoots: opts.allowedFileRoots,
    realpath: vi.fn(
      async (absPath: string) => opts.realpaths?.[path.resolve(absPath)] ?? path.resolve(absPath),
    ),
    readFile: vi.fn(async (absPath: string) => {
      const buf = files[absPath];
      if (!buf) throw new Error(`ENOENT: ${absPath}`);
      return buf;
    }),
    log,
  };
}

describe('collectOutboundAttachments', () => {
  it('图片引用 + 旁路图去重收集, 正文替换成提示; 文件链接剥离', async () => {
    const text =
      '成果:\n![效果图](xdt-image://img1.png)\n详见 [报告](xdt-file:///out/report.md) 收工';
    const r = await collectOutboundAttachments(
      text,
      ['/cache/img1.png', '/cache/extra.png'],
      deps(
        {
          '/cache/img1.png': Buffer.from('png1'),
          '/cache/extra.png': Buffer.from('png2'),
          '/out/report.md': Buffer.from('# 报告'),
        },
        { allowedFileRoots: ['/out'] },
      ),
    );
    expect(r.attachments.map((a) => a.name)).toEqual(['img1.png', 'extra.png', 'report.md']);
    expect(r.attachments[0].mimeType).toBe('image/png');
    expect(r.attachments[2].mimeType).toBe('text/markdown');
    expect(r.text).toContain('🖼️ _效果图(已作为附件发送)_');
    expect(r.text).not.toContain('xdt-image://');
    expect(r.text).not.toContain('xdt-file://');
    expect(r.skipped).toBe(0);
  });

  it('cindy-media 图片引用同样收集(媒体总仓双协议;只认 xdt-image 会让 hook Slack 拿不到生成图)', async () => {
    const hash = 'b'.repeat(64);
    const text = `画好了 ![猫](cindy-media://blobs/${hash}.png)`;
    const r = await collectOutboundAttachments(
      text,
      [],
      deps({
        [`/blobs/blobs/${hash}.png`]: Buffer.from('png-bytes'),
      }),
    );
    expect(r.attachments.map((a) => a.name)).toEqual([`${hash}.png`]);
    expect(r.attachments[0].mimeType).toBe('image/png');
    expect(r.text).not.toContain('cindy-media://');
    expect(r.skipped).toBe(0);
  });

  it('读盘失败 / 解析失败只跳过并计数, 不抛错', async () => {
    const text = '![a](xdt-image://gone.png) [b](xdt-file:///tmp/missing.bin)';
    const r = await collectOutboundAttachments(text, [], {
      resolveImageUrl: () => {
        throw new Error('not found');
      },
      allowedFileRoots: ['/tmp'],
      realpath: async (absPath: string) => path.resolve(absPath),
      readFile: async () => {
        throw new Error('ENOENT');
      },
      log,
    });
    expect(r.attachments).toHaveLength(0);
    expect(r.skipped).toBe(2);
    // 失败引用不再谎称已发送，且明确告知用户附件没有完整送达。
    expect(r.text).not.toContain('xdt-file://');
    expect(r.text).not.toContain('已作为附件发送');
    expect(r.text).toContain('🖼️ _a_');
    expect(r.text).toContain('b');
    expect(r.text).toContain('Attachment delivery incomplete: 2 items');
  });

  it('同一路径重复引用只收一份', async () => {
    const text = '![x](xdt-image://same.png) 再看一遍 ![x](xdt-image://same.png)';
    const r = await collectOutboundAttachments(
      text,
      ['/cache/same.png'],
      deps({
        '/cache/same.png': Buffer.from('bytes'),
      }),
    );
    expect(r.attachments).toHaveLength(1);
  });

  it('不读取 allowedFileRoots 之外的 xdt-file 本地路径', async () => {
    const d = deps(
      {
        '/repo/report.md': Buffer.from('ok'),
        '/Users/me/.ssh/id_rsa': Buffer.from('secret'),
      },
      { allowedFileRoots: ['/repo'] },
    );

    const r = await collectOutboundAttachments(
      '[报告](xdt-file:///repo/report.md) [secret](xdt-file:///Users/me/.ssh/id_rsa)',
      [],
      d,
    );

    expect(r.attachments.map((a) => a.name)).toEqual(['report.md']);
    expect(d.readFile).toHaveBeenCalledWith('/repo/report.md');
    expect(d.readFile).not.toHaveBeenCalledWith('/Users/me/.ssh/id_rsa');
    expect(r.skipped).toBe(1);
    expect(r.text).not.toContain('xdt-file://');
  });

  it('未提供 allowedFileRoots 时 fail-closed, 不读取 xdt-file', async () => {
    const d = deps({ '/repo/report.md': Buffer.from('ok') });

    const r = await collectOutboundAttachments('[报告](xdt-file:///repo/report.md)', [], d);

    expect(r.attachments).toHaveLength(0);
    expect(d.readFile).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it('拒绝相对路径与非法编码的 xdt-file，且坏链接不拖垮其余回复', async () => {
    const d = deps(
      {
        '/repo/report.md': Buffer.from('ok'),
      },
      { allowedFileRoots: ['/repo'] },
    );

    const r = await collectOutboundAttachments(
      '[relative](xdt-file://report.md) [bad](xdt-file:///repo/50%.md) [ok](xdt-file:///repo/report.md)',
      [],
      d,
    );

    expect(r.attachments.map((a) => a.name)).toEqual(['report.md']);
    expect(d.readFile).toHaveBeenCalledTimes(1);
    expect(r.skipped).toBe(2);
    expect(r.text).toContain('relative');
    expect(r.text).toContain('bad');
    expect(r.text).not.toContain('xdt-file://');
    expect(r.text).toContain('Attachment delivery incomplete: 2 items');
    expect(log.warn).toHaveBeenCalledWith(
      'outbound file attachment skipped because xdt-file URL was invalid',
    );
  });

  it('拒绝 realpath 指向 workspace 外的 symlink 路径', async () => {
    const d = deps(
      {
        '/repo/link-to-secret': Buffer.from('secret'),
      },
      {
        allowedFileRoots: ['/repo'],
        realpaths: {
          [path.resolve('/repo')]: path.resolve('/repo'),
          [path.resolve('/repo/link-to-secret')]: path.resolve('/Users/me/.ssh/id_rsa'),
        },
      },
    );

    const r = await collectOutboundAttachments('[secret](xdt-file:///repo/link-to-secret)', [], d);

    expect(r.attachments).toHaveLength(0);
    expect(d.readFile).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it('多 allowed roots 时单个 root realpath 失败仍继续检查后续 root', async () => {
    const d = deps(
      {
        '/repo/sub/report.md': Buffer.from('ok'),
      },
      {
        allowedFileRoots: ['/repo', '/repo/sub'],
      },
    );
    d.realpath.mockImplementation(async (absPath: string) => {
      if (path.resolve(absPath) === path.resolve('/repo')) throw new Error('ENOENT');
      return path.resolve(absPath);
    });

    const r = await collectOutboundAttachments('[报告](xdt-file:///repo/sub/report.md)', [], d);

    expect(r.attachments.map((a) => a.name)).toEqual(['report.md']);
    expect(d.readFile).toHaveBeenCalledWith('/repo/sub/report.md');
    expect(r.skipped).toBe(0);
  });
});

describe('辅助函数', () => {
  it('xdtFileUrlToAbsPath: Windows 盘符路径剥掉多余前导斜杠(2026-07-16 实踩:附件被判目录外静默丢弃)', () => {
    expect(xdtFileUrlToAbsPath('xdt-file:///C:\\Users\\x\\wd\\hello.txt')).toBe(
      'C:\\Users\\x\\wd\\hello.txt',
    );
    expect(xdtFileUrlToAbsPath('xdt-file:///C:/Users/x/wd/hello.txt')).toBe(
      'C:/Users/x/wd/hello.txt',
    );
    // Unix 绝对路径不受影响(前导 / 就是根)
    expect(xdtFileUrlToAbsPath('xdt-file:///home/u/f.txt')).toBe('/home/u/f.txt');
    // URL 编码照常解
    expect(xdtFileUrlToAbsPath('xdt-file:///C:/Users/x/%E6%8A%A5%E5%91%8A.md')).toBe(
      'C:/Users/x/报告.md',
    );
    expect(() => xdtFileUrlToAbsPath('xdt-file://relative.txt')).toThrow('absolute path');
    expect(() => xdtFileUrlToAbsPath('xdt-file:///C:\\dir\\a 50%.txt')).toThrow(URIError);
  });

  it('hasOutboundRefs / guessMime', () => {
    expect(hasOutboundRefs('纯文本')).toBe(false);
    expect(hasOutboundRefs('![a](xdt-image://x)')).toBe(true);
    expect(hasOutboundRefs('[a](xdt-file:///x)')).toBe(true);
    expect(guessMime('/a/b.PNG')).toBe('image/png');
    expect(guessMime('/a/voice.ogg')).toBe('audio/ogg');
    expect(guessMime('/a/clip.mp4')).toBe('video/mp4');
    expect(guessMime('/a/report.pdf')).toBe('application/pdf');
    expect(guessMime('/a/b.tar.gz')).toBe('application/octet-stream');
  });
});
