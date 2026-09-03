/**
 * formatToolInput 归一化 —— 权限弹窗正文抽取必须 harness 无关:
 * CC 工具名首字母大写 + file_path;pi 内置工具名小写 + path/command。
 * 两套命名都要抽出清爽正文(命令/路径),而非回退成 JSON blob。
 */
import { describe, expect, it } from 'vitest';

import { formatToolInput } from '../PermissionPrompt';

describe('formatToolInput (harness-agnostic)', () => {
  it('extracts the command for Bash and PowerShell tools', () => {
    expect(formatToolInput('Bash', { command: 'ls -la' })).toBe('ls -la');
    expect(formatToolInput('bash', { command: 'git status' })).toBe('git status');
    expect(formatToolInput('powershell', { command: 'Get-Content .\\README.md' }))
      .toBe('Get-Content .\\README.md');
  });

  it('extracts the file path across file_path / path (CC and pi)', () => {
    expect(formatToolInput('Write', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(formatToolInput('write', { path: '/a/c.ts', content: 'x' })).toBe('/a/c.ts');
    expect(formatToolInput('edit', { path: '/a/d.ts' })).toBe('/a/d.ts');
    expect(formatToolInput('read', { path: '/a/e.ts' })).toBe('/a/e.ts');
  });

  it('extracts pattern/path for search tools including pi grep/find/ls', () => {
    expect(formatToolInput('Grep', { pattern: 'TODO' })).toBe('TODO');
    expect(formatToolInput('grep', { pattern: 'TODO', path: '/src' })).toBe('TODO');
    expect(formatToolInput('find', { path: '/src' })).toBe('/src');
    expect(formatToolInput('ls', { path: '/src' })).toBe('/src');
  });

  it('falls back to truncated JSON for unknown tools / missing fields', () => {
    expect(formatToolInput('mcp__x__y', { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatToolInput('bash', {})).toBe('{}');
    const long = formatToolInput('weird', { s: 'x'.repeat(600) });
    expect(long.endsWith('...')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(503);
  });
});
