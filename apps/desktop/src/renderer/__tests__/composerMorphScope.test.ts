import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(rendererRoot, relativePath), 'utf8');

const chatInput = read('components/new-chat/ChatInput.tsx');
const modelSelector = read('components/new-chat/ModelSelector.tsx');
const permissionSelector = read('components/new-chat/PermissionSelector.tsx');
const extraDirsButton = read('components/new-chat/ExtraDirsButton.tsx');
const settingsModel = read('components/settings/ImDefaultSettingsSection.tsx');
const subagentModel = read('components/settings/SubagentModelSection.tsx');
const createWorker = read('features/cc-agent/CreateWorkerPopover.tsx');
const agentSelect = read('components/new-chat/AgentSelect.tsx');
const workspacePrefs = read('components/settings/HookWorkspacePrefsEditor.tsx');

// 2026-07-22:composer 工具条(含新建对话框 create-agent)统一走脱身上浮 morph;非 composer 场景
// (settings / subagent / CreateWorker)仍用 Radix。取代 origin/main「morph 仅普通工具条 opt-in、
// create-agent 固定尺寸」的旧作用域(脱身上浮方案由用户 2026-07-22 定稿取代原位取代)。
describe('composer morph scope', () => {
  it('ModelSelector 的形变仅 composer 工具条 opt-in;settings/subagent/CreateWorker 不 opt-in(走 Radix)', () => {
    // ChatInput 无条件给 ModelSelector 传 useMorphPopover(create-agent 也 morph,与会话内统一)
    expect(chatInput).toContain('useMorphPopover');
    expect(settingsModel).not.toContain('useMorphPopover');
    expect(subagentModel).not.toContain('useMorphPopover');
    expect(createWorker).not.toContain('useMorphPopover');
  });

  it('ModelSelector 保留 useMorphPopover 作用域开关 + Radix 回退(供 settings field / CreateWorker)', () => {
    expect(modelSelector).toContain('useMorphPopover = false');
    expect(modelSelector).toContain('<PopoverTrigger asChild>{trigger}</PopoverTrigger>');
  });

  it('composer 选完模型后把焦点送回输入框;设置页不传 restoreFocusTarget', () => {
    expect(chatInput).toContain('restoreFocusTarget={composerSuggestionFocusTarget}');
    expect(modelSelector).toContain('restoreFocusTarget?: () => HTMLElement | null');
    expect(modelSelector).toContain('onMouseDown={morphEnabled ? (event) => event.preventDefault() : undefined}');
    expect(settingsModel).not.toContain('restoreFocusTarget');
    expect(subagentModel).not.toContain('restoreFocusTarget');
    expect(createWorker).not.toContain('restoreFocusTarget');
  });

  it('PermissionSelector / ExtraDirsButton 仅 composer 使用,恒走脱身上浮 morph(无 opt-in、无 Radix 回退)', () => {
    expect(permissionSelector).not.toContain('useMorphPopover');
    expect(extraDirsButton).not.toContain('useMorphPopover');
    expect(permissionSelector).toContain('<MorphPopover');
    expect(extraDirsButton).toContain('<MorphPopover');
  });

  it('语音录音展开:会话内与新建对话框共用(expandable 恒真),呼吸动画尊重 reduced-motion', () => {
    expect(chatInput).toContain('const expandable = true;');
    expect(chatInput).toContain('return () => window.clearInterval(id);');
    expect(chatInput).toContain('inline-flex animate-pulse motion-reduce:animate-none');
  });
});

// 设置场景复用工具条控件时的宽度契约(codex review #1490)。DESIGN.md §4
// Select & Dropdown:「Panel width must bind to the trigger width — never narrower
// or wider than the control that opened it」。工具条形态的 trigger 按内容 hug、
// 面板固定 196px,直接放进设置字段会让短标签(Claude / Pi)下面板明显宽于 trigger。
describe('设置字段里的 AgentSelect 宽度契约', () => {
  it('两处设置场景都用 field 形态,不得把工具条形态塞进字段', () => {
    for (const src of [settingsModel, workspacePrefs]) {
      expect(src).toContain('<AgentSelect');
      expect(src).toContain('triggerVariant="field"');
    }
  });

  it('field 形态把面板宽度交给 trigger 实测值,工具条形态保持固定 196px', () => {
    expect(agentSelect).toContain("panelWidthMode: 'trigger' as const");
    expect(agentSelect).toContain('panelWidth: 196');
  });

  it('MorphPopover 支持 trigger 绑定宽度模式(严格等宽,不取 max)', () => {
    const morph = read('components/ui/morph-popover.tsx');
    expect(morph).toContain("panelWidthMode?: 'content' | 'trigger'");
    expect(morph).toContain('desiredW = chipRect.width;');
  });
});

// + 菜单嵌在 480 宽、1px 边框的 Morph 壳里。内层再写死 480 会横向溢出 2px,
// 打开瞬间 scrollIntoView 点亮 .is-scrolling,底部闪 2 秒横向滚动条。
describe('+ 菜单 embedded 宽度契约', () => {
  it('embedded AtMentionPanel 跟 Morph 壳等宽,横轴 overflow 显式 hidden', () => {
    const atMention = read('components/new-chat/AtMentionPanel.tsx');
    const morph = read('components/ui/morph-popover.tsx');
    expect(atMention).toContain("embedded ? 'w-full min-w-0' : 'w-[480px]'");
    expect(atMention).toContain('overflow-x-hidden overflow-y-auto');
    expect(morph).toContain('overflow-x-hidden overflow-y-hidden');
    expect(morph).toContain("content.style.overflowX = 'hidden'");
  });
});

describe('Grok Build 出现在与 cc/codex/pi 相同的 harness 选择入口', () => {
  it('统一选择器候选引擎表派生自 SELECTABLE_AGENT_KINDS,不再手抄三引擎', () => {
    expect(chatInput).toContain(
      "const UNIFIED_AGENT_KINDS: readonly AgentKind[] = SELECTABLE_AGENT_KINDS;",
    );
    expect(chatInput).not.toMatch(
      /UNIFIED_AGENT_KINDS: readonly AgentKind\[\] = \['claude-code', 'codex', 'pi'\]/,
    );
    expect(modelSelector).toContain('SELECTABLE_AGENT_KINDS');
    expect(chatInput).toContain("const OPT_IN_UNIFIED_AGENTS: ReadonlySet<AgentKind> = new Set(['grok-build'])");
    expect(chatInput).toContain(
      'const catalogKinds = UNIFIED_AGENT_KINDS.filter((kind) => !OPT_IN_UNIFIED_AGENTS.has(kind));',
    );
    expect(chatInput).toContain('if (!runtimeAgentsLoaded) return catalogKinds;');
  });

  it('Hook 工作目录偏好不再隐藏 grok-build,并认它为合法 agent', () => {
    expect(workspacePrefs).not.toContain("HOOK_HIDDEN_VENDORS");
    expect(workspacePrefs).toContain("if (vendor === 'grok-build') return 'grok-build'");
    const hookLogic = read('components/settings/hookWorkspacePrefsLogic.ts');
    expect(hookLogic).toContain("'grok-build'");
    expect(hookLogic).toMatch(
      /export const AGENT_KINDS = \['claude-code', 'codex', 'pi', 'grok-build'\]/,
    );
  });

  it('IM 默认设置把 grok-build vendor 映射成 grok-build harness,不再误写成 Codex', () => {
    expect(settingsModel).toContain("if (vendor === 'grok-build') return 'grok-build'");
    expect(settingsModel).not.toMatch(
      /function agentKindOfVendor\(vendor: string\): ImDefaultAgentKind \{\n  return vendor === 'cc' \? 'claude-code' : vendor === 'pi' \? 'pi' : 'codex';/,
    );
  });
});
