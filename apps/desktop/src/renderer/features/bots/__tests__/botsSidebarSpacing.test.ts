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
 *   .row-meta  { width:40px; align-items:flex-end }                       → w-10 items-end
 *   .row-name  { font-size:14px }                                        → text-14
 *   .row-time  { font-size:11px; flex:none }                             → text-11 shrink-0
 *   .row-prev  { font-size:12.5px }                                      → text-12(仓库字号阶梯里最近的一档)
 *   .badge     { min-width:16px; height:16px; padding:0 4px; radius:9999 } → h-4 min-w-4 px-1 rounded-full
 *   .av-40     { 40px }                                                   → BotAvatar size="md"
 *   .side-list { padding:0 12px 12px }                                    → 容器 px-3
 *
 * 未读角标依用户的侧栏细化反馈收小，数字采用等宽，预览不再随未读加粗。
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
const ROW_CONTAINER_CLASS = 'group relative flex w-full items-center rounded-xl transition-colors';

describe('伙伴行的间距基线', () => {
  it('行容器不带内边距,也不再给行尾留占位列', () => {
    // 容器只负责选中态背景与圆角;任何 padding / gap 落在这里都会变成
    // 「左边 12+x、右边 x」的不对称。
    expect(source).toContain(`'${ROW_CONTAINER_CLASS}',`);
    // 伙伴行容器不为行尾操作按钮预留 padding；其它控件可以按自身需要使用 pr-*。
    expect(ROW_CONTAINER_CLASS).not.toMatch(/\bp[rxe]-/);
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
    expect(source).toContain('<span className="flex min-w-0 items-center gap-2">');
  });

  it('五要素的字号与固定尺寸不漂', () => {
    // 名字 14px / 时间 11px / 预览 12px。
    expect(source).toContain("'min-w-0 flex-1 truncate text-14 leading-5',");
    expect(source).toContain("cn('min-h-4 text-11 tabular-nums', mutedClass)");
    expect(source).toContain("'min-w-0 flex-1 truncate text-12 leading-4',");
    // 徽标 16×16,左右各 4px，数字变化不抖动。
    expect(source).toContain(
      'flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--bot-unread-bg)] px-1 text-10 font-medium tabular-nums leading-none text-[var(--bot-unread-fg)]',
    );
  });

  it('时间与未读共用固定右列,不会被名字或预览推来推去', () => {
    const start = source.indexOf(
      '<span className="flex w-10 shrink-0 self-stretch flex-col items-end justify-between py-0.5">',
    );
    const metaColumn = source.slice(start, source.indexOf('</button>', start));
    expect(metaColumn).toContain("aria-label={t('bots.list.unread', { count: unread })}");
    expect(metaColumn).toContain("cn('min-h-4 text-11 tabular-nums', mutedClass)");
  });

  it('管理菜单不再占据消息行宽度', () => {
    expect(source).not.toContain('<MoreHorizontal');
    expect(source).toContain('onContextMenu={(event) => {');
    expect(source).toContain(
      'className="pointer-events-none fixed h-0 w-0"',
    );
  });

  it('归档行与小节头保持间距，空态复用紧凑创建入口', () => {
    expect(source).toContain(
      'group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors',
    );
    // 空态只留创建入口，外层间距固定，不恢复大卡片。
    expect(source).toContain(
      '<div className="px-3 py-3">',
    );
    expect(source).toContain("<BotCreateMenu label={t('bots.add')} />");
    // 小节头与行内正文左边缘对齐:容器 px-3(12px) + 10px。
    expect(source).toContain('<div className="flex items-center justify-between px-2.5 pb-2">');
    expect(source).toContain(
      'mb-1 flex items-center gap-2 px-2.5 text-10 font-medium text-[var(--sidebar-list-muted)]',
    );
    // 列表容器本身:定稿 `.side-list{padding:0 12px 12px}`。
    expect(source).toContain('<div className="flex min-h-0 flex-1 flex-col px-3 pt-2">');
  });
});
