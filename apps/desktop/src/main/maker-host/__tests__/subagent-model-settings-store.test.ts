import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/cindy-subagent-model-test'),
  },
}));

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'test-owner', generation: 1 }),
  ownerScopedUserDataPath: (...parts: string[]) => path.join('/tmp/cindy-subagent-model-test', ...parts),
}));

import {
  __testing,
  readSubagentModelSettings,
  readSubagentModelSettingsState,
  resetSubagentModelSettings,
  writeSubagentModelSettingsPatch,
} from '../subagent-model-settings-store';
import { reconcileSubagentModelSettingsPatch } from '../../../shared/subagentModelSettings';

const settingsDir = '/tmp/cindy-subagent-model-test';
const settingsFile = path.join(settingsDir, 'subagent-model-settings.json');

describe('subagent model settings store', () => {
  beforeEach(() => {
    fs.mkdirSync(settingsDir, { recursive: true });
    resetSubagentModelSettings();
  });

  afterEach(() => {
    resetSubagentModelSettings();
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  it('defaults both agents to no override', () => {
    expect(readSubagentModelSettings()).toEqual({
      claudeCode: null,
      claudeCodeProviderId: null,
      codex: null,
      codexProviderId: null,
    });
  });

  it('persists only the configured Claude model', () => {
    writeSubagentModelSettingsPatch({ claudeCode: 'claude-haiku-4-5-20251001' });

    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).toEqual({
      claudeCode: 'claude-haiku-4-5-20251001',
    });
    expect(readSubagentModelSettings()).toEqual({
      claudeCode: 'claude-haiku-4-5-20251001',
      claudeCodeProviderId: null,
      codex: null,
      codexProviderId: null,
    });
  });

  it('persists (model, providerId) written in one patch', () => {
    writeSubagentModelSettingsPatch({
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: 'anthropic',
    });

    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).toEqual({
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: 'anthropic',
    });
    expect(readSubagentModelSettings()).toEqual({
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: 'anthropic',
      codex: null,
      codexProviderId: null,
    });
  });

  it('removes the override file when Claude returns to unspecified', () => {
    writeSubagentModelSettingsPatch({ claudeCode: 'claude-haiku-4-5-20251001' });
    writeSubagentModelSettingsPatch({ claudeCode: null });

    expect(fs.existsSync(settingsFile)).toBe(false);
    expect(readSubagentModelSettings().claudeCode).toBeNull();
  });

  it('clearing the model together with providerId removes the whole override', () => {
    writeSubagentModelSettingsPatch({
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: 'anthropic',
    });
    writeSubagentModelSettingsPatch({ claudeCode: null, claudeCodeProviderId: null });

    expect(fs.existsSync(settingsFile)).toBe(false);
    expect(readSubagentModelSettings()).toEqual({
      claudeCode: null,
      claudeCodeProviderId: null,
      codex: null,
      codexProviderId: null,
    });
  });

  it('drops an orphan on-disk providerId whose model is unspecified', () => {
    // 外部手改文件留下的孤儿来源:磁盘直读同样执行配对不变量,不让 isCustomized 误报。
    expect(
      __testing.normalize({ claudeCodeProviderId: 'anthropic' }),
    ).toEqual({
      claudeCode: null,
      claudeCodeProviderId: null,
      codex: null,
      codexProviderId: null,
    });
  });

  it('self-heals an orphan on-disk providerId key on the settings-state read path', () => {
    // raw override key 直接决定 isCustomized/customizedKeys(override store 语义):
    // 手改文件留下的孤儿 providerId 必须在 State 读入口被清掉,不能报「已自定义」
    // 却显示「不指定」(codex review)。
    fs.writeFileSync(settingsFile, JSON.stringify({ claudeCodeProviderId: 'anthropic' }), 'utf-8');

    const state = readSubagentModelSettingsState();
    expect(state.value.claudeCodeProviderId).toBeNull();
    expect(state.customizedKeys).toEqual([]);
    expect(state.isCustomized).toBe(false);
    // 孤儿是唯一 override:清掉后整个文件按「全默认」删除。
    expect(fs.existsSync(settingsFile)).toBe(false);
  });

  it('normalizes malformed disk values to no override', () => {
    expect(
      __testing.normalize({
        claudeCode: '  claude-sonnet-4-6  ',
        claudeCodeProviderId: 42,
        codex: 'bad\nmodel',
        codexProviderId: '  xd  ',
      }),
    ).toEqual({
      claudeCode: 'claude-sonnet-4-6',
      claudeCodeProviderId: null,
      codex: null,
      // codex 模型归一化为「不指定」后其来源随配对不变量一并清除,不留孤儿。
      codexProviderId: null,
    });
  });

  it('reconciles a model-clearing patch to also clear its providerId (IPC boundary contract)', () => {
    const current = {
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: 'anthropic',
      codex: 'gpt-5.5',
      codexProviderId: 'xd',
    };
    // 来源依附模型:显式清模型的 patch 未带 providerId 时,不得留下孤儿来源落盘。
    expect(reconcileSubagentModelSettingsPatch({ claudeCode: null }, current)).toEqual({
      claudeCode: null,
      claudeCodeProviderId: null,
    });
    expect(
      reconcileSubagentModelSettingsPatch({ codex: null, claudeCode: 'claude-opus-5' }, current),
    ).toEqual({
      codex: null,
      codexProviderId: null,
      claudeCode: 'claude-opus-5',
    });
    // 存储已有模型时,provider-only patch 原样通过。
    expect(
      reconcileSubagentModelSettingsPatch({ claudeCodeProviderId: 'anthropic' }, current),
    ).toEqual({
      claudeCodeProviderId: 'anthropic',
    });
  });

  it('rejects a provider-only patch while the effective model is unspecified', () => {
    // 模型本就未指定时来源无所依附:provider-only patch 不得写出「显示不指定却
    // isCustomized」的孤儿 override(codex review)。
    const current = {
      claudeCode: null,
      claudeCodeProviderId: null,
      codex: null,
      codexProviderId: null,
    };
    expect(
      reconcileSubagentModelSettingsPatch({ claudeCodeProviderId: 'anthropic' }, current),
    ).toEqual({
      claudeCodeProviderId: null,
    });
  });
});
