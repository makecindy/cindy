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

  it('X 平台名正确且给出单条纯文本回帖格式约束, 不复用 Telegram/Slack 提示', () => {
    const x = buildHookPromptNote('x');
    expect(x).toContain('本会话来自 X。');
    expect(x).toContain('[X 回复格式]');
    expect(x).toContain('转换为纯文本');
    expect(x).toContain('标题、列表、表格');
    expect(x).toContain('上述附件引用除外');
    expect(x).toContain('不要解释或复述这些格式要求');
    const xFormat = x.slice(x.indexOf('[X 回复格式]'));
    expect(xFormat).not.toMatch(/280|字数|字符|长度|简短|压缩|截断|篇幅|不超过|以内/i);
    expect(x).not.toContain('[Telegram 回复格式]');
    expect(x).not.toContain('本会话来自 Slack');
    // 未接线前的回归写法: x 曾被三元兜底误标成 Slack。
    expect(buildHookPromptNote('slack')).not.toContain('[X 回复格式]');
  });

  it('X 提示词陈述取文机制, 而不是要求模型自律(与 turnTextsFor 同一约定)', () => {
    const x = buildHookPromptNote('x');
    // 机制侧: session-runner 的 turnTextsFor 对所有 IM 取 observer.finalText() 当
    // 公开正文; X 的单条限制只在发送层生效。提示词要说明正文会按桌面规则拼出,
    // 让模型不要把结论拆成多条彼此不完整的公开回帖。
    expect(x).toContain('按桌面版规则拼出正式正文');
    expect(x).toContain('以一条回帖发布');
    expect(x).toContain('短过程旁白会被折叠');
    expect(x).not.toContain('只有你的最后一条消息会被发出');
  });

  it('两个平台都在开头声明「不是用户消息」,防止模型把渠道说明当成用户请求(2026-07 实踩)', () => {
    for (const im of ['telegram', 'slack', 'x'] as const) {
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

  it('refScanText: 引用范围可宽于正文, 正文变换仍只作用于正文', async () => {
    // X 只发一条公开回帖, 而图常贴在被折叠的工作过程里。两者绑在一起的话那些
    // 图会静默丢失(PR #1272 review 指出) —— 所以扫描范围与正文范围分开。
    const turnText = '先看图 ![图](xdt-image://chart.png)\n\n结论: 趋势向上。';
    const publicText = '结论: 趋势向上。';
    const r = await collectOutboundAttachments(publicText, [], {
      ...deps({ '/cache/chart.png': Buffer.from('png') }),
      refScanText: turnText,
    });
    expect(r.attachments.map((a) => a.name)).toEqual(['chart.png']);
    // 正文不该被扩回整轮 —— 扩大的只是"哪些引用要收"。
    expect(r.text).toBe(publicText);
    expect(r.text).not.toContain('先看图');
    expect(r.skipped).toBe(0);
  });

  it('refScanText 省略时按 finalText 扫描(既有行为不变)', async () => {
    const r = await collectOutboundAttachments(
      '成果 ![图](xdt-image://chart.png)',
      [],
      deps({ '/cache/chart.png': Buffer.from('png') }),
    );
    expect(r.attachments.map((a) => a.name)).toEqual(['chart.png']);
    expect(r.text).toContain('🖼️ _图(已作为附件发送)_');
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
