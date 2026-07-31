/**
 * deriveAutoTitleSeed —— 会话自动起名的素材推导。
 *
 * 核心契约:isUserText 决定这段素材能不能喂给标题模型。用户一个字没写时合成的
 * 描述(文件名 / @mention / 被引用会话标题)只能当占位标题 —— 把它发给模型只会
 * 得到「我没有看到用户消息的内容」这类回复(见 PR #296 的线上表现)。
 */
import { describe, expect, it } from 'vitest';

import { deriveAutoTitleSeed, type AgentInputQueuedMessage } from '../agentInputQueue';
import type { AttachedFile, MentionedResource } from '@/lib/fileTypes';

const LABELS = { image: '图片', file: '文件' };

function queued(patch: {
  text?: string;
  quotesEncoded?: boolean;
  agentReferences?: AgentInputQueuedMessage['agentReferences'];
  files?: Partial<AttachedFile>[];
  mentions?: MentionedResource[];
}): AgentInputQueuedMessage {
  return {
    text: patch.text ?? '',
    agentReferences: patch.agentReferences,
    files: patch.files as AttachedFile[] | undefined,
    mentions: patch.mentions,
    chatMessage: { quotesEncoded: patch.quotesEncoded === true },
  } as unknown as AgentInputQueuedMessage;
}

describe('deriveAutoTitleSeed — 用户写了字', () => {
  it('原样返回用户文字并标记为可喂模型', () => {
    expect(deriveAutoTitleSeed(queued({ text: '帮我排查登录失败' }), LABELS)).toEqual({
      text: '帮我排查登录失败',
      isUserText: true,
    });
  });

  it('图片配文字时用文字,不退化成文件名', () => {
    const seed = deriveAutoTitleSeed(
      queued({ text: '这个报错怎么修', files: [{ name: '截屏.png', category: 'image' }] }),
      LABELS,
    );

    expect(seed).toEqual({ text: '这个报错怎么修', isUserText: true });
  });
});

describe('deriveAutoTitleSeed — 用户一个字没写', () => {
  it('纯图片有文件名 → 用文件名(比「图片」信息量大)', () => {
    const seed = deriveAutoTitleSeed(
      queued({ files: [{ name: '设计稿-v3.png', category: 'image' }] }),
      LABELS,
    );

    expect(seed).toEqual({ text: '设计稿-v3.png', isUserText: false });
  });

  it('粘贴的截图 → 回落到「图片」,不拿 clipboard-<ts>.png 这种实现名当标题', () => {
    // 线上形状:useAttachments 给粘贴图同时填 name 与 originalName 为生成名,
    // 真实来源只体现在 path 的 scheme 上(review P1:此前只看名字,漏掉了它)。
    const seed = deriveAutoTitleSeed(
      queued({
        files: [
          {
            name: 'clipboard-1753500000000.png',
            originalName: 'clipboard-1753500000000.png',
            path: 'clipboard://paste-1753500000000',
            category: 'image',
          },
        ],
      }),
      LABELS,
    );

    expect(seed).toEqual({ text: '图片', isUserText: false });
  });

  it('图片查看器 / 浏览器注释等 clipboard:// 同型附件一样只给类别词', () => {
    expect(
      deriveAutoTitleSeed(
        queued({
          files: [
            {
              name: 'annotated-1753500000000.png',
              originalName: 'annotated-1753500000000.png',
              path: 'clipboard://lightbox-annotated-1753500000000',
              category: 'image',
            },
          ],
        }),
        LABELS,
      ),
    ).toEqual({ text: '图片', isUserText: false });
  });

  it('clipboard 截图与真实文件同时在场时,用真实文件名', () => {
    const seed = deriveAutoTitleSeed(
      queued({
        files: [
          {
            name: 'clipboard-1753500000000.png',
            originalName: 'clipboard-1753500000000.png',
            path: 'clipboard://paste-1',
            category: 'image',
          },
          { name: '需求评审.pdf', path: '/tmp/需求评审.pdf', category: 'pdf' },
        ],
      }),
      LABELS,
    );

    expect(seed).toEqual({ text: '需求评审.pdf', isUserText: false });
  });

  it('纯 PDF / office / 其他文件 → 用文件名', () => {
    expect(deriveAutoTitleSeed(queued({ files: [{ name: '需求评审.pdf', category: 'pdf' }] }), LABELS))
      .toEqual({ text: '需求评审.pdf', isUserText: false });
    expect(deriveAutoTitleSeed(queued({ files: [{ name: '排期.xlsx', category: 'office' }] }), LABELS))
      .toEqual({ text: '排期.xlsx', isUserText: false });
    expect(deriveAutoTitleSeed(queued({ files: [{ name: 'server.log', category: 'text' }] }), LABELS))
      .toEqual({ text: 'server.log', isUserText: false });
  });

  it('非图片附件没有文件名 → 回落到「文件」', () => {
    const seed = deriveAutoTitleSeed(
      queued({ files: [{ name: '', path: '', category: 'file' }] }),
      LABELS,
    );

    expect(seed).toEqual({ text: '文件', isUserText: false });
  });

  it('文件名带路径时只取 basename(POSIX 与 Windows 都认)', () => {
    expect(deriveAutoTitleSeed(queued({ files: [{ name: '/a/b/报告.pdf', category: 'pdf' }] }), LABELS))
      .toEqual({ text: '报告.pdf', isUserText: false });
    expect(
      deriveAutoTitleSeed(queued({ files: [{ name: 'C:\\docs\\报告.pdf', category: 'pdf' }] }), LABELS),
    ).toEqual({ text: '报告.pdf', isUserText: false });
  });

  it('纯 @mention → 用 mention 名', () => {
    const seed = deriveAutoTitleSeed(
      queued({ mentions: [{ type: 'file', name: 'index.ts', path: 'src/index.ts' }] }),
      LABELS,
    );

    expect(seed).toEqual({ text: 'index.ts', isUserText: false });
  });

  it('优先级:文件名 > mention 名 > 引用标题 > 类别词', () => {
    // 文件名压过 mention 名。
    expect(
      deriveAutoTitleSeed(
        queued({
          mentions: [{ type: 'dir', name: 'renderer', path: 'src/renderer' }],
          files: [{ name: '设计稿.png', category: 'image' }],
        }),
        LABELS,
      ),
    ).toEqual({ text: '设计稿.png', isUserText: false });

    // 附件拿不到文件名(粘贴的截图)时,mention 名压过类别词兜底。
    expect(
      deriveAutoTitleSeed(
        queued({
          text: '@src/renderer/',
          mentions: [{ type: 'dir', name: 'renderer', path: 'src/renderer' }],
          files: [{ name: 'clipboard://x', path: 'clipboard://x', category: 'image' }],
        }),
        LABELS,
      ),
    ).toEqual({ text: 'renderer', isUserText: false });
  });

  it('纯 @mention 消息不算用户文字:chip 序列化出的 @token 被剔除', () => {
    // ChatInput 把 mention chip 序列化成 `@<path>` 进 wire text;若不剔除,这条
    // 消息会被当成用户散文发给标题模型,describeMentions 永远走不到。
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@src/index.ts',
        mentions: [{ type: 'file', name: 'index.ts', path: 'src/index.ts' }],
      }),
      LABELS,
    );

    expect(seed).toEqual({ text: 'index.ts', isUserText: false });
  });

  it('path 含空格的 mention 走引号形式 @"..." ,同样被剔除', () => {
    // ChatInput 对含空格/引号的 path 用 formatMentionRef 加引号序列化;
    // 只匹配裸形式会漏掉它,导致这条消息被当成用户散文送进标题模型。
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@"my docs/file name.md"',
        mentions: [{ type: 'file', name: 'file name.md', path: 'my docs/file name.md' }],
      }),
      LABELS,
    );

    expect(seed).toEqual({ text: 'file name.md', isUserText: false });
  });

  it('dir chip 的引号形式(尾斜杠在引号内)同样被剔除', () => {
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@"my docs/sub dir/"',
        mentions: [{ type: 'dir', name: 'sub dir', path: 'my docs/sub dir' }],
      }),
      LABELS,
    );

    expect(seed).toEqual({ text: 'sub dir', isUserText: false });
  });

  it('只按 path 剔除:正文里手打的 @<文件名> 不被误删', () => {
    // 用户插了 chip @src/index.ts,又在文字里手打了 @index.ts —— 后者是正文,
    // 若把 mention.name 也当 token 剔除,这条消息会被误判成「没有文字」。
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@src/index.ts 对比一下 @index.ts',
        mentions: [{ type: 'file', name: 'index.ts', path: 'src/index.ts' }],
      }),
      LABELS,
    );

    expect(seed?.isUserText).toBe(true);
    expect(seed?.text).toBe('对比一下 @index.ts');
  });

  it('agent chip 的 path 就存 name,无需额外特例即可剔除', () => {
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@code-reviewer',
        mentions: [{ type: 'agent', name: 'code-reviewer', path: 'code-reviewer' }],
      }),
      LABELS,
    );

    expect(seed).toEqual({ text: 'code-reviewer', isUserText: false });
  });

  it('token 后紧跟标点(`@a/b.ts,`)时仍被剔除,wire token 不漏进标题素材', () => {
    // `@\S+` 会把标点一并吞进同一段,精确匹配落空 —— 不做边界回退的话这条消息
    // 会被当成用户散文,标题里出现 `@src/index.ts,`(review)。
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@src/index.ts,这里为什么会崩',
        mentions: [{ type: 'file', name: 'index.ts', path: 'src/index.ts' }],
      }),
      LABELS,
    );

    expect(seed?.isUserText).toBe(true);
    expect(seed?.text).toBe(',这里为什么会崩');
  });

  it('chip 后只跟一个标点 → 不算用户文字,回落到合成描述', () => {
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@src/index.ts。',
        mentions: [{ type: 'file', name: 'index.ts', path: 'src/index.ts' }],
      }),
      LABELS,
    );

    expect(seed).toEqual({ text: 'index.ts', isUserText: false });
  });

  it('英文句末的 ASCII 句点也算边界(仅当它是 token 末字符)', () => {
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@src/index.ts.',
        mentions: [{ type: 'file', name: 'index.ts', path: 'src/index.ts' }],
      }),
      LABELS,
    );

    // 剔除后只剩一个句点 → 不算用户文字,回落到合成描述。
    expect(seed).toEqual({ text: 'index.ts', isUserText: false });
  });

  it('句点不在末尾时不算边界,`@foo` + `.bar` 这类更长路径不被切坏', () => {
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@src/foo.bar 看看这个',
        mentions: [{ type: 'file', name: 'foo', path: 'src/foo' }],
      }),
      LABELS,
    );

    expect(seed?.isUserText).toBe(true);
    expect(seed?.text).toBe('@src/foo.bar 看看这个');
  });

  it('边界回退不切坏更长的真实路径:`@src/index.tsx` 不被当成 `@src/index.ts` + `x`', () => {
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@src/index.ts 和手打的 @src/index.tsx 有什么区别',
        mentions: [{ type: 'file', name: 'index.ts', path: 'src/index.ts' }],
      }),
      LABELS,
    );

    expect(seed?.isUserText).toBe(true);
    expect(seed?.text).toBe('和手打的 @src/index.tsx 有什么区别');
  });

  it('dir chip 的尾斜杠 + 标点同样被剔除', () => {
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@src/renderer/,还有别的吗',
        mentions: [{ type: 'dir', name: 'renderer', path: 'src/renderer' }],
      }),
      LABELS,
    );

    expect(seed?.isUserText).toBe(true);
    expect(seed?.text).toBe(',还有别的吗');
  });

  it('chip 后无分隔符直接接中文正文时也剔除(用户不打空格)', () => {
    // ChatInput 不会替用户补分隔符,`@\S+` 会把 chip 与正文吞成一个 token。
    // ref 是纯 ASCII 而紧跟一个汉字 —— 这个形状判成边界,wire token 不进标题素材。
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@src/index.ts这里为什么会崩',
        mentions: [{ type: 'file', name: 'index.ts', path: 'src/index.ts' }],
      }),
      LABELS,
    );

    expect(seed).toEqual({ text: '这里为什么会崩', isUserText: true });
  });

  it('脚本切换边界不误伤同为 ASCII 的更长路径', () => {
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@src/index.tsx 有什么区别',
        mentions: [{ type: 'file', name: 'index.ts', path: 'src/index.ts' }],
      }),
      LABELS,
    );

    // `x` 仍是 ASCII → 不是边界,整个 token 原样保留(它是手打的另一个路径)。
    expect(seed?.isUserText).toBe(true);
    expect(seed?.text).toBe('@src/index.tsx 有什么区别');
  });

  it('mention 旁边有真正的文字时仍算用户文字', () => {
    const seed = deriveAutoTitleSeed(
      queued({
        text: '@src/index.ts 这里为什么会崩',
        mentions: [{ type: 'file', name: 'index.ts', path: 'src/index.ts' }],
      }),
      LABELS,
    );

    expect(seed?.isUserText).toBe(true);
    expect(seed?.text).toBe('这里为什么会崩');
  });

  it('没有 mention 的消息原样透传,哪怕只有标点/表情', () => {
    // 「剔除后只剩标点不算文字」只针对剔除残渣。用户亲手打的 `???` 是他消息的
    // 全部内容,拿它当标题就是所见即所得,这里无权替他判定「这不算话」。
    expect(deriveAutoTitleSeed(queued({ text: '???' }), LABELS)).toEqual({
      text: '???',
      isUserText: true,
    });
  });

  it('用户手打的 @xxx(无对应 mention)不被剔除,仍算用户文字', () => {
    const seed = deriveAutoTitleSeed(queued({ text: '@张三 帮忙看下' }), LABELS);

    expect(seed).toEqual({ text: '@张三 帮忙看下', isUserText: true });
  });

  it('什么都没有 → null,调用方保留默认标题', () => {
    expect(deriveAutoTitleSeed(queued({}), LABELS)).toBeNull();
    expect(deriveAutoTitleSeed(queued({ text: '   \n  ' }), LABELS)).toBeNull();
  });
});

describe('deriveAutoTitleSeed — 会话/项目引用', () => {
  const HREF = 'cindy://session/src-1';

  it('只拖一个任务引用 → 用被引用会话的标题,而不是 [Referenced conversation] 机器块', () => {
    const seed = deriveAutoTitleSeed(
      queued({
        text: HREF,
        agentReferences: [
          {
            kind: 'session',
            start: 0,
            end: HREF.length,
            href: HREF,
            sessionId: 'src-1',
            title: '推文内容准备',
          },
        ],
      }),
      LABELS,
    );

    expect(seed).toEqual({ text: '推文内容准备', isUserText: false });
  });

  it('只拖一个项目引用 → 用项目名', () => {
    const href = 'cindy://project/p1';
    const seed = deriveAutoTitleSeed(
      queued({
        text: href,
        agentReferences: [
          {
            kind: 'project',
            start: 0,
            end: href.length,
            href,
            name: 'cindy',
            workingDir: '/Users/dash/Code/Cindy/cindy',
          },
        ],
      }),
      LABELS,
    );

    expect(seed).toEqual({ text: 'cindy', isUserText: false });
  });

  it('引用旁边有用户文字时用文字,引用展开的机器块不混进标题', () => {
    const text = `看看 ${HREF} 里的结论`;
    const start = text.indexOf(HREF);
    const seed = deriveAutoTitleSeed(
      queued({
        text,
        agentReferences: [
          {
            kind: 'session',
            start,
            end: start + HREF.length,
            href: HREF,
            sessionId: 'src-1',
            title: '推文内容准备',
          },
        ],
      }),
      LABELS,
    );

    expect(seed?.isUserText).toBe(true);
    expect(seed?.text).toContain('看看');
    expect(seed?.text).toContain('里的结论');
    expect(seed?.text).not.toContain('Referenced');
    expect(seed?.text).not.toContain(HREF);
  });
});
