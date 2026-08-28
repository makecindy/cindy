import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGENT_KINDS,
  DRAFT_AGENT_KINDS,
  isAgentKind,
  requireAgentKind,
  requireDraftAgentKind,
} from '../agentKindGate';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8');

/** 取某个 wire channel 的 handler 源码片段(到下一个 ipcMain.handle 为止)。 */
function handlerSource(channel: string): string {
  const start = registerSource.indexOf(`MAKER_INVOKE.${channel},`);
  expect(start, `${channel} handler not found in register.ts`).toBeGreaterThan(-1);
  const next = registerSource.indexOf('ipcMain.handle(', start);
  return registerSource.slice(start, next > start ? next : registerSource.length);
}

/** 会话面 wire 入口:grok-build 会话要靠它们拿能力、命令、技能、@ 资源与定制。 */
const SESSION_FACING_CHANNELS = [
  'GET_CAPABILITIES',
  'LIST_AGENT_COMMANDS',
  'LIST_AGENT_SKILLS',
  'SCAN_AT_RESOURCES',
  'LIST_CUSTOMIZATIONS',
] as const;

/** New Maker 草稿面 wire 入口:只有三个 vendor 有草稿槽。 */
const DRAFT_FACING_CHANNELS = ['GET_NEW_MAKER_DEFAULTS', 'APPLY_NEW_MAKER_DRAFT_PREF'] as const;

describe('agentKind IPC gate', () => {
  it('accepts every AgentKind including Grok Build at the session-facing gate', () => {
    expect([...AGENT_KINDS].sort()).toEqual(['claude-code', 'codex', 'grok-build', 'pi']);
    for (const kind of AGENT_KINDS) {
      expect(requireAgentKind(kind)).toBe(kind);
      expect(isAgentKind(kind)).toBe(true);
    }
  });

  it('rejects values that are not agent kinds', () => {
    // 'grok' 是 xAI catalog provider 名，harness 的 UI vendor 是 'grok-build'。
    for (const bogus of ['grok', 'cc', 'Codex', '', undefined, null, 42, {}]) {
      expect(() => requireAgentKind(bogus)).toThrow('[INVALID_PARAMS]');
      expect(isAgentKind(bogus)).toBe(false);
    }
  });

  it('keeps the draft gate on the three vendors that own a New Maker draft slot', () => {
    expect(DRAFT_AGENT_KINDS).toEqual(['claude-code', 'codex', 'pi']);
    for (const kind of DRAFT_AGENT_KINDS) {
      expect(requireDraftAgentKind(kind)).toBe(kind);
    }
    expect(() => requireDraftAgentKind('grok-build')).toThrow('[INVALID_PARAMS]');
    // 草稿 pref 的字段叫 agent，报错要指回调用方的参数名。
    expect(() => requireDraftAgentKind('grok-build', 'agent')).toThrow('invalid agent: grok-build');
  });

  it('routes the session-facing register.ts channels through the full-union gate', () => {
    expect(registerSource).toContain(
      "import { requireAgentKind, requireDraftAgentKind } from './agentKindGate.js';",
    );
    const authSource = readFileSync(resolve(__dirname, '..', 'authHandlers.ts'), 'utf8');
    expect(authSource).toContain("import { requireAgentKind } from './agentKindGate.js';");
    expect(authSource).not.toContain('const AGENT_KINDS');
    // 本地再定义一份就会遮蔽共享 helper，闸门会重新与 AgentKind 漂移。
    expect(registerSource).not.toContain('function requireAgentKind(');
    for (const channel of SESSION_FACING_CHANNELS) {
      const handler = handlerSource(channel);
      expect(handler, `${channel} must use the full agentKind gate`).toContain('requireAgentKind(');
      expect(handler, `${channel} must not use the draft-only gate`).not.toContain(
        'requireDraftAgentKind(',
      );
    }
  });

  it('keeps the New Maker draft channels on the draft-only gate', () => {
    for (const channel of DRAFT_FACING_CHANNELS) {
      const handler = handlerSource(channel);
      expect(handler, `${channel} must use the draft-only gate`).toContain(
        'requireDraftAgentKind(',
      );
      expect(
        handler.replace(/requireDraftAgentKind\(/g, ''),
        `${channel} must not fall back to the full gate`,
      ).not.toContain('requireAgentKind(');
    }
  });
});
