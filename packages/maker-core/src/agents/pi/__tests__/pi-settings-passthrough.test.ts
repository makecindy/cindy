/**
 * #3643:Cindy 每次 startSession 覆写隔离 agentHome 的 settings.json。pi 官方文档
 * 的用户自配置键(shellPath / shellCommandPrefix / npmCommand)是 Windows bash
 * spawn 故障的第一顺位自救手段,覆写时必须按白名单保留;Cindy 自有键始终以新
 * 生成内容为准。
 */
import { describe, expect, it } from 'vitest';

import { buildPiSettingsJsonContent, mergePiUserSettingsPassthrough } from '../index.js';

describe('mergePiUserSettingsPassthrough (#3643)', () => {
  const built = buildPiSettingsJsonContent(128_000, 75);

  it('preserves user shellPath and shellCommandPrefix across the rewrite', () => {
    const existing = JSON.stringify({
      shellPath: 'C:/Program Files/Git/bin/bash.exe',
      shellCommandPrefix: 'shopt -s expand_aliases',
      transport: 'websocket',
    });
    const merged = JSON.parse(mergePiUserSettingsPassthrough(built, existing));
    expect(merged.shellPath).toBe('C:/Program Files/Git/bin/bash.exe');
    expect(merged.shellCommandPrefix).toBe('shopt -s expand_aliases');
    // Cindy 自有键不被旧文件覆盖:transport 恒为新生成的 sse。
    expect(merged.transport).toBe('sse');
    expect(merged.retry).toEqual(JSON.parse(built).retry);
  });

  it('preserves npmCommand only when it is a non-empty string array', () => {
    const good = JSON.stringify({ npmCommand: ['mise', 'exec', 'node@20', '--', 'npm'] });
    expect(JSON.parse(mergePiUserSettingsPassthrough(built, good)).npmCommand).toEqual([
      'mise',
      'exec',
      'node@20',
      '--',
      'npm',
    ]);
    const badType = JSON.stringify({ npmCommand: 'npm' });
    expect(JSON.parse(mergePiUserSettingsPassthrough(built, badType)).npmCommand).toBeUndefined();
    const badItems = JSON.stringify({ npmCommand: ['npm', 42] });
    expect(JSON.parse(mergePiUserSettingsPassthrough(built, badItems)).npmCommand).toBeUndefined();
  });

  it('rejects blank or non-string shellPath and non-whitelisted keys', () => {
    const existing = JSON.stringify({
      shellPath: '   ',
      defaultTools: ['read', 'powershell'],
      compaction: { reserveTokens: 1 },
    });
    const merged = JSON.parse(mergePiUserSettingsPassthrough(built, existing));
    expect(merged.shellPath).toBeUndefined();
    // 白名单之外的键(defaultTools 会与 bridge 工具面冲突)不透传。
    expect(merged.defaultTools).toBeUndefined();
    // Cindy 自有 compaction 以新生成内容为准。
    expect(merged.compaction).toEqual(JSON.parse(built).compaction);
  });

  it('later sources win: the stable-root user file overrides the per-session file', () => {
    const session = JSON.stringify({ shellPath: 'C:/old/session/bash.exe', npmCommand: ['npm'] });
    const stable = JSON.stringify({ shellPath: 'C:/cygwin64/bin/bash.exe' });
    const merged = JSON.parse(mergePiUserSettingsPassthrough(built, session, stable));
    expect(merged.shellPath).toBe('C:/cygwin64/bin/bash.exe');
    // 稳定根没写的键仍从会话文件保留。
    expect(merged.npmCommand).toEqual(['npm']);
  });

  it('falls back to the built content when the existing file is missing or corrupt', () => {
    expect(mergePiUserSettingsPassthrough(built, null)).toBe(built);
    expect(mergePiUserSettingsPassthrough(built, '')).toBe(built);
    expect(mergePiUserSettingsPassthrough(built, '{not json')).toBe(built);
    expect(mergePiUserSettingsPassthrough(built, '[1,2]')).toBe(built);
  });
});
