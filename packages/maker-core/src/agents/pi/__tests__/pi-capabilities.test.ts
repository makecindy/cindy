/**
 * PiAgent capabilities 契约 —— 锁住无人值守链路依赖的安全不变量:
 * permissionModes 必须**从严到宽**声明,`[0]` 是最严档(hook-control/defaults.ts
 * 在「显式档不被支持」时回落 `permissionModes[0]`,顺序错了会把更严的选择静默放宽)。
 */
import { describe, expect, it } from 'vitest';

import { PiAgent } from '../index.js';
import type { AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

function buildAgent(): PiAgent {
  const deps: AgentDeps = {
    auth: {
      getState: async () => ({ authenticated: true, identity: 't', authSource: 'api-key' as const }),
      triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {},
      getAuthEnv: async () => ({}),
    },
    runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
    binaryPath: '/nonexistent/pi',
    logger: noopLogger,
    capabilityAdditions: { availableModels: [] },
  };
  return new PiAgent(deps);
}

describe('PiAgent capabilities contract', () => {
  it('declares permission modes strict→wide with ask first (unattended clamp safety)', () => {
    const ids = buildAgent().capabilities.permissionModes.map((m) => m.id);
    expect(ids).toEqual(['ask', 'auto', 'bypassPermissions']);
    // [0] 必须是最严档 —— hook-control 回落取它
    expect(ids[0]).toBe('ask');
    // 最宽档必须在末位
    expect(ids[ids.length - 1]).toBe('bypassPermissions');
  });

  it('every permission mode ships an English fallback label + description', () => {
    for (const m of buildAgent().capabilities.permissionModes) {
      expect(m.displayName && m.displayName.length > 0).toBe(true);
      expect(m.description && m.description.length > 0).toBe(true);
      // fallback 必须是英文(真实文案走 i18n);粗判:不含 CJK
      expect(/[一-鿿]/.test(`${m.displayName}${m.description}`)).toBe(false);
    }
  });

  it('declares Fast support so supported ChatGPT models can expose the toggle', () => {
    expect(buildAgent().capabilities.hasFastMode).toBe(true);
  });

  it('exposes Pi native minimal thinking', () => {
    expect(buildAgent().capabilities.effortLevels.map((level) => level.id)).toContain('minimal');
  });

  it('exposes attachments, precise rewind, Extra Dirs, and compaction memory', () => {
    const capabilities = buildAgent().capabilities;
    expect(capabilities.multimodal.file.supported).toBe(true);
    expect(capabilities.rewind.supported).toBe(true);
    expect(capabilities.extraDirs.supported).toBe(true);
    expect(capabilities.memory.supported.supported).toBe(true);
    expect(capabilities.memory.resettable).toBe(true);
    expect(capabilities.memory.setEnabledMidSession?.supported).toBe(false);
  });
});
