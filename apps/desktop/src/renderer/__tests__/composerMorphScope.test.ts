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
