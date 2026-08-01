/**
 * chatClickabilitySignal.test.ts
 * ---------------------------------------------------------------------------
 * 源码级契约测试:钉住 DESIGN.md §14.5「聊天正文的可点性信号」在桌面端的落地。
 *
 * 两条规则都没有类型保护 —— 改回去不会报错,只会静默让「哪个能点」重新看不出来,
 * 所以只能在源码层守:
 *   ① 聊天正文里可点的行内元素一律 **常显下划线**(不是 hover 才出现);
 *   ② 聊天正文 **不使用 `--msg-link`**(它是主题契约,10 个内置主题各自定义、用户导入
 *      VS Code 主题时 linkColor 也映射到它;而移动端没有链接色概念。要「两端统一 +
 *      外链本地同形」,正文必须退出这个 token)。token 本身保留给其它界面,所以这里
 *      只断言**这三个聊天正文文件**不再引用它,而不是全局搜。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHAT_BODY_FILES = [
  'src/renderer/components/chat/MarkdownRenderer.tsx',
  'src/renderer/components/chat/UserMessage.tsx',
  'src/renderer/components/chat/UserMessageUrlLink.tsx',
] as const;

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/** 去掉块注释与行注释:规则说明里会写到 --msg-link / hover:underline,不该被判违规。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('聊天正文的可点性信号(DESIGN.md §14.5)', () => {
  it('规则②:聊天正文三个文件都不再引用 --msg-link', () => {
    for (const rel of CHAT_BODY_FILES) {
      const code = stripComments(read(rel));
      expect(code, `${rel} 仍在聊天正文里使用 --msg-link`).not.toContain('--msg-link');
    }
  });

  it('规则①:markdown 链接类名是常显下划线,且不带颜色 token', () => {
    const src = read(CHAT_BODY_FILES[0]);
    const decl = /const MARKDOWN_LINK_CLASS = '([^']*)'/.exec(src);
    expect(decl, '未找到 MARKDOWN_LINK_CLASS 定义').not.toBeNull();
    const cls = decl![1];
    expect(cls, '缺少常显下划线').toMatch(/(^|\s)underline(\s|$)/);
    expect(cls, '下划线不得只在 hover 出现').not.toMatch(/hover:underline/);
    expect(cls, '正文链接不应再染主题链接色').not.toContain('--msg-link');
  });

  it('规则①:可点的文件 chip 也有常显下划线(改前只有 hover 变色 + 指针形状)', () => {
    const src = read(CHAT_BODY_FILES[0]);
    // FileTargetChip 的 className 块:从组件名往后取第一段 cn(...) 调用。
    const chipStart = src.indexOf('function FileTargetChip');
    expect(chipStart, '未找到 FileTargetChip').toBeGreaterThan(-1);
    const classNameCall = /className=\{cn\(([\s\S]*?)\)\}/.exec(src.slice(chipStart));
    expect(classNameCall, '未找到 FileTargetChip 的 className').not.toBeNull();
    const block = stripComments(classNameCall![1]);
    expect(block, 'FileTargetChip 缺少常显下划线').toMatch(/'underline[^']*'/);
    // 底色改为与 markdown 行内 code 同一 token:按规则①底色只表达排版语义,
    // 可点性由下划线单独承担(也解掉旧的 dark 模式撞色:实色 1.26:1 vs 半透明 1.26~1.28:1)。
    expect(block, 'chip 底色应与 markdown 行内 code 同 token').toContain('--msg-md-inline-code-bg');
    // 「可点态只多一条下划线」:文字色必须与不可点的行内 code 一致 —— 后者不写 color、
    // 靠继承(对齐 GitHub 的 `.markdown-body code`),所以 chip 也不许钉 text-。
    expect(block, 'chip 不得钉死文字色(应与行内 code 一样继承)').not.toMatch(/'text-\[/);
  });

  it('规则①:正文裸写的路径不进等宽 chip 分支(两端同口径)', () => {
    const src = read(CHAT_BODY_FILES[0]);
    // 裸路径的未点亮态是普通正文;若仍按 label 形态进 FileTargetChip,同一句里
    // 点亮/未点亮的两条路径会在字体、底色、下划线三处齐变。
    expect(stripComments(src), '裸路径标记未接入 chip 分支判定')
      .toMatch(/if \(fromBarePath \|\| !shouldRenderCodeReferenceLabel\(/);
    // 标记只是内部信道,不该落到 DOM 上。
    expect(stripComments(src), '未从 anchorProps 里剥掉裸路径标记')
      .toMatch(/delete safeProps\[BARE_PATH_ATTR\]/);
  });

  it('规则⑤:远程会话的点亮判据只有一处,且不在本文件里自己判', () => {
    const src = stripComments(read(CHAT_BODY_FILES[0]));
    // 远程会话 fs:stat 回 unknown 时,歧义形状(裸名 `array.map`、分隔符无扩展
    // `and/or`)不得乐观升级成 resolved-local —— 否则加了常显下划线后,普通行内 code
    // 会被展示成可点文件、点了必失败(PR #1144 review 实捉桌面侧漏了这道门槛)。
    // 判据已收敛进 lib/markdownTarget.decideRemoteLit(行为用例在 markdownTarget.test.ts),
    // 这里只守「本文件不再自己判 verdict」。
    expect(src, '点亮判据不再经 decideRemoteLit').toMatch(/decideRemoteLit\(/);
    expect(src, '本文件又开始自己拿 verdict 做点亮判断了 —— 判据必须单点')
      .not.toMatch(/verdict === '(file|directory|nonfile|unknown)'/);
  });

  it('规则⑤前置:远程点亮态是缓存的**纯派生**,组件不自己存结论', () => {
    // 三轮 review 各捉到同一个状态机的一条边(TTL 到期无通道 / 派生值没被新结论覆盖 /
    // 另一挂载点写入的确定态传不过来),根因都是「组件自己存了一份结论,而真值在可变
    // 缓存里」。第 10 轮止损重构把双源(syncResolved useMemo ?? asyncResolved useState)
    // 合并成单一 state + 一个纯派生函数,任何新的状态迁移都只有一处需要改对。
    const src = stripComments(read(CHAT_BODY_FILES[0]));
    expect(src, '双真值来源回来了 —— memo 那一份不吃缓存变化,必然再漏一条边')
      .not.toMatch(/syncResolved|asyncResolved/);
    expect(src, '缺少统一的派生函数 resolveFromCache').toMatch(/resolveFromCache/);
    // 渲染用的读法必须是 ForRender 版:普通 peek 不返回 unknown,断链期间的乐观点亮
    // 就只能存在组件里 —— 那正是双源的来源。
    expect(src, '渲染态没走 peekRemotePathVerdictForRender —— 乐观点亮态会退回组件自存')
      .toMatch(/peekRemotePathVerdictForRender\(/);
    // 缓存变化必须有通道进来(按 key 过滤)。
    expect(src, '没有订阅缓存变化 —— 别处写入的确定态传不到本实例')
      .toMatch(/subscribeRemotePathVerdictChange\(/);
  });

  it('规则①:可点的引用 chip 带下划线,不可点的静态 chip 不带(判据单点)', () => {
    const src = read('src/renderer/components/chat/InlineReferenceChip.tsx');
    // 会话 / 项目深链 chip 复用本组件;改前它只有底色 + 边框 + pointer,没有下划线,
    // 是「可点但无下划线」的反例。判据只能是 interactive 一处,cursor 与下划线同源。
    const interactiveLine = src
      .split('\n')
      .find((l) => l.includes('interactive &&') && l.includes('cursor-pointer'));
    expect(interactiveLine, '未找到 interactive 的样式分支').toBeDefined();
    expect(interactiveLine!, '可点 chip 缺常显下划线').toMatch(/underline/);
    // underline 只能出现在 interactive 那一行 —— 否则就是脱离判据无条件给出,
    // 静态 chip 也会跟着变成「有下划线却点不动」。
    const underlineLines = stripComments(src)
      .split('\n')
      .filter((l) => l.includes('underline'));
    expect(underlineLines, '下划线出现在 interactive 之外的地方').toEqual([interactiveLine!]);
  });

  it('规则①:用户消息气泡里的链接同样常显下划线,不靠 hover', () => {
    for (const rel of [CHAT_BODY_FILES[1], CHAT_BODY_FILES[2]]) {
      const code = stripComments(read(rel));
      expect(code, `${rel} 仍在用 hover:underline 作为可点信号`).not.toContain('hover:underline');
    }
  });
});
