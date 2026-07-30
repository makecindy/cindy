import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('subagent nesting render wiring', () => {
  it('routes subagent_group items to a CollabCardShell-based SubagentCard (no new scroll mechanism)', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    // RenderItemView 新增 subagent_group 路由。
    expect(source).toContain("case 'subagent_group':");
    expect(source).toContain('<SubagentCard item={item} actions={actions} />');
    // SubagentCard 走共享 CollabCardShell(其内部即 FoldablePanel,与 ToolGroupCard/WorkGroupCard 同款
    // 折叠路径,未引入新滚动机制)、默认折叠。
    const cardStart = source.indexOf('function SubagentCard(');
    expect(cardStart).toBeGreaterThan(-1);
    const cardEnd = source.indexOf('\nfunction FoldablePanel(', cardStart);
    const cardSource = source.slice(cardStart, cardEnd);
    expect(cardSource).toContain('<CollabCardShell');
    // 展开态走 blockId 共享记忆(默认折叠),不再显式传 defaultExpanded(blockId 存在时该值无效)。
    expect(cardSource).toContain('blockId={item.key}');
    expect(cardSource).not.toContain('defaultExpanded');
    expect(cardSource).toContain('testID="message.subagentToggle"');
    // 递归渲染内层 childItems(经 RenderItemView)+ 子 agent 终稿。
    expect(cardSource).toContain('item.childItems.map');
    expect(cardSource).toContain('<RenderItemView');
    expect(cardSource).toContain('item.summary');
    // 颜色走主题 token(图标 textTertiary),不硬编码 hex。
    expect(cardSource).toContain('colors.textTertiary');
    expect(cardSource).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('guards both render-item dispatch points with an exhaustive log+skip default (compile-time exhaustiveness, no runtime throw)', () => {
    const renderer = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const gallery = readFileSync(resolve(process.cwd(), 'src/session/messageGallery.ts'), 'utf8');
    const helper = readFileSync(resolve(process.cwd(), 'src/session/assertNever.ts'), 'utf8');
    // RenderItemView switch 与 messageGallery visitItem 都以 default: logUnhandledRenderItem(item) 收尾:
    // 入参仍是 never → 给 union 加变体漏处理 → typecheck 拦下(保留 P3 编译期穷尽性);运行时 log+skip 不 throw
    // (render/相册路径无 ErrorBoundary,不能崩整列)。
    expect(helper).toContain('export function logUnhandledRenderItem(value: never): void');
    expect(renderer).toContain("import { logUnhandledRenderItem } from '@/session/assertNever';");
    expect(renderer).toContain('default:');
    expect(renderer).toContain('logUnhandledRenderItem(item);');
    expect(renderer).not.toContain('assertNever(item);'); // render 路径不再 throw
    expect(gallery).toContain("import { logUnhandledRenderItem } from '@/session/assertNever';");
    expect(gallery).toContain('logUnhandledRenderItem(item);');
  });

  it('passes screenWidth into OrcaCollabCard and skips the foldable shell for empty body (F4 + F3)', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const orcaStart = source.indexOf('function OrcaCollabCard(');
    const orcaSource = source.slice(orcaStart, source.indexOf('\nfunction ', orcaStart + 1));
    // F4:OrcaCollabCard 收 screenWidth 并透传给 CollabCardShell。
    expect(orcaSource).toContain('screenWidth?: number');
    expect(orcaSource).toContain('screenWidth={screenWidth}');
    // F3:body 为空 → 静态卡(无 CollabCardShell/chevron/空 body 区);有 body 才走折叠 shell。
    expect(orcaSource).toContain("const body = card.body && card.body.trim() ? card.body : null;");
    expect(orcaSource).toContain('if (!body) {');
    expect(orcaSource).toContain('styles.orcaStaticHeader');
  });

  it('shares one CollabCardShell chrome (FoldablePanel) between SubagentCard and OrcaCollabCard', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    // CollabCardShell 即 FoldablePanel(card 变体)+ Rail 的预设。
    const shellStart = source.indexOf('function CollabCardShell(');
    expect(shellStart).toBeGreaterThan(-1);
    const shellSource = source.slice(shellStart, source.indexOf('\nfunction MobileSystemCard(', shellStart));
    expect(shellSource).toContain('<FoldablePanel');
    expect(shellSource).toContain("variant=\"card\"");
    expect(shellSource).toContain('<Rail layout={layout}>');
    // OrcaCollabCard 改用共享 chrome,数据路径仍是 card(message.orcaCard),且保留既有 testID。
    const orcaStart = source.indexOf('function OrcaCollabCard(');
    const orcaSource = source.slice(orcaStart, source.indexOf('\nfunction ', orcaStart + 1));
    expect(orcaSource).toContain('<CollabCardShell');
    expect(orcaSource).toContain('testID={`message.orcaCard.${card.variant}`}');
    expect(orcaSource).toContain('testID="message.orcaCardBody"');
    expect(orcaSource).not.toContain('styles.systemCard}'); // 不再用裸 systemCard 容器
  });

  it('builds subagent_group via the parentUuid grouping path without touching shared builders', () => {
    const model = readFileSync(resolve(process.cwd(), 'src/session/messageRenderModel.ts'), 'utf8');
    // 无子 agent 时走原始 shared 路径(普通会话零影响),并把 live agent_task 更新接进 shared builder。
    // 两条路径出口都套 dropSyntheticTriggerItems:合成续跑行不进渲染(隐藏 prompt 不露出)。
    expect(model).toContain('if (!hasSubagentMessages(normalized))');
    expect(model).toContain('return dropSyntheticTriggerItems(buildMessageRenderItems(normalized, options, taskUpdates));');
    expect(model).toContain('buildSubagentAwareRenderItems(normalized, buildSubagentResultMeta(messages), options)');
    // 联合类型扩为 mobile-only(shared 类型不动)。
    expect(model).toContain("type: 'subagent_group';");
    expect(model).toContain('| MobileSubagentGroupItem');
    expect(model).toContain('| MobileForkOriginItem');
    // 待发送气泡(pending_send)也是 mobile-only 的联合成员,同样不动 shared 类型。
    expect(model).toContain('| MobilePendingSendItem;');
  });
});
