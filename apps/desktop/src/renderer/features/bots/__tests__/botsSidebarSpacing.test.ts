/**
 * 伙伴列表行的**数值基线**。
 *
 * 为什么要有这么一份写死数字的静态扫描:这一行的左右间距已经被反复打回过
 * (行尾挂过齿轮 → 齿轮下线 → `pr-2` 占位残留 → 右边比左边窄一截)。截图目检
 * 抓不住 2px,jsdom 也量不出 Tailwind 类的真实像素,唯一能"再漂移就直接红"的
 * 办法就是把定稿数值本身钉在测试里。
 *
 * 数值来自定稿原型 `Cindy-伙伴原型/styles.css` 的行布局:
 *
 *   .row       { display:flex; align-items:center; border-radius:12px }   → rounded-xl,行容器**不带**内边距
 *   .row-open  { flex:1; padding:8px 10px; gap:10px }                     → px-2.5 py-2 gap-2.5(左右对称)
 *   .row-l1    { display:flex; align-items:baseline; gap:8px }            → gap-2
 *   .row-l2    { display:flex; align-items:center; gap:8px; margin-top:2px } → gap-2 + 外层 flex-col gap-0.5
 *   .row-name  { font-size:14px }                                        → text-14
 *   .row-time  { font-size:11px; flex:none }                             → text-11 shrink-0
 *   .row-prev  { font-size:12.5px }                                      → text-12(仓库字号阶梯里最近的一档)
 *   .badge     { min-width:18px; height:18px; padding:0 6px; radius:9999 } → h-[18px] min-w-[18px] px-1.5 rounded-full
 *   .av-40     { 40px }                                                   → BotAvatar size="md"
 *   .side-list { padding:0 12px 12px }                                    → 容器 px-3
 *
 * 改这些数字之前先去改原型,不要反过来。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'BotsSidebar.tsx'), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** 去掉注释后的代码。注释里可以复盘历史(「以前这里有 pr-2」),JSX 里不能再有。 */
const code = source
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 可点行本体(头像 + 两行文字)的类名串。 */
const ROW_BUTTON_CLASS =
  'flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left';

describe('伙伴行的间距基线', () => {
  it('行容器不带内边距,也不再给行尾留占位列', () => {
    // 容器只负责选中态背景与圆角;任何 padding / gap 落在这里都会变成
    // 「左边 12+x、右边 x」的不对称。
    expect(source).toContain(
      "'group relative flex w-full items-center rounded-xl transition-colors',",
    );
    // 行尾那一列(齿轮 / 状态图标 / 待办点)已经整体下线,连同它的 `pr-2`。
    expect(code).not.toContain('pr-2');
    expect(code).not.toMatch(/<span className="flex shrink-0 items-center gap-1/);
  });

  it('唯一的可点区域用对称的 10px 左右内边距、8px 上下内边距', () => {
    expect(source).toContain(ROW_BUTTON_CLASS);
    // px-2.5 = 10px 两侧。出现 px-3 / pl-* / pr-* 都意味着又不对称了。
    expect(ROW_BUTTON_CLASS).toContain('px-2.5');
    expect(ROW_BUTTON_CLASS).toContain('py-2');
    expect(ROW_BUTTON_CLASS).not.toMatch(/\bp[lrxse]-(?!2\.5)/);
  });

  it('头像与正文之间 10px', () => {
    expect(ROW_BUTTON_CLASS).toContain('gap-2.5');
    expect(source).toContain('<BotAvatar bot={bot} size="md" />');
  });

  it('两行之间 2px,行内元素之间 8px', () => {
    expect(source).toContain('<span className="flex min-w-0 flex-1 flex-col gap-0.5">');
    expect(source).toContain('<span className="flex items-baseline gap-2">');
    expect(source).toContain('<span className="flex items-center gap-2">');
  });

  it('五要素的字号与固定尺寸不漂', () => {
    // 名字 14px / 时间 11px / 预览 12px。
    expect(source).toContain("'min-w-0 flex-1 truncate text-14 leading-5',");
    expect(source).toContain("cn('shrink-0 text-11', mutedClass)");
    expect(source).toContain("'min-w-0 flex-1 truncate text-12 leading-4',");
    // 徽标 18×18,左右各 6px。
    expect(source).toContain(
      'flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--bot-unread-bg)] px-1.5 text-11 font-medium leading-none text-[var(--bot-unread-fg)]',
    );
    // 待办点 6×6。
    expect(source).toContain('className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--bot-unread-bg)]"');
  });

  it('未读徽标与待办点都长在第二行内,不另开一列', () => {
    const start = source.indexOf('<span className="flex items-center gap-2">');
    const secondLine = source.slice(start, source.indexOf('</button>', start));
    expect(secondLine).toContain("aria-label={t('bots.list.unread', { count: unread })}");
    expect(secondLine).toContain(
      "aria-label={t('bots.inbox.sidebarAttention', { count: attention })}",
    );
  });

  it('归档行、空态卡与小节头跟伙伴行同一套左右内边距', () => {
    expect(source).toContain(
      'group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors',
    );
    // 空态卡:定稿 `.side-empty{padding:12px 14px}`,并且与行同宽(不缩 8px)。
    expect(source).toContain(
      'flex w-full flex-col items-start gap-1 rounded-xl border border-dashed border-[var(--border-default)] px-3.5 py-3',
    );
    // 小节头与行内正文左边缘对齐:容器 px-3(12px) + 10px。
    expect(source).toContain('<div className="flex items-center justify-between px-2.5 pb-2">');
    expect(source).toContain(
      'mb-1 flex items-center gap-2 px-2.5 text-10 font-medium text-[var(--sidebar-list-muted)]',
    );
    // 列表容器本身:定稿 `.side-list{padding:0 12px 12px}`。
    expect(source).toContain('<div className="flex min-h-0 flex-1 flex-col px-3 pt-2">');
  });
});
