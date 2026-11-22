/**
 * 测试价值
 * - 生产入口与可观察结果：buildDeliveryReceipt。收据里看得到改动文件和失败命令的退出码；只有对话时三段清单都不出现；PR/CI 读不到是 unknown 不是 passed；preview/tmp 不进产出。
 * - Bug／规则依据：交付收据最小验收（不把未知写成通过，不把预览和临时文件当成品）。
 * - 现有覆盖缺口：botDeliverable 只判断单个文件，不管命令退出码、空清单和 CI 读失败。
 * - 最小失败输入：一条失败命令加一个改动文件；零文件消息；checks 缺失；preview 与 tmp 路径。
 * - tier：unit。纯函数，无 IO。
 */
import { describe, expect, it } from 'vitest';
import { buildDeliveryReceipt, judgeCommandOutcome } from '../deliveryReceipt.js';

describe('buildDeliveryReceipt', () => {
  it('keeps the changed file and the failed command exit code', () => {
    const receipt = buildDeliveryReceipt({
      title: 'Fix the list',
      phase: 'finished',
      workingDir: '/repo',
      branch: 'fix/list',
      changedFiles: [{ path: 'src/list.ts', status: 'modified' }],
      messages: [
        {
          role: 'tool_use',
          toolUseId: 't1',
          content: { toolName: 'Bash', toolUseId: 't1', input: { command: 'pnpm test:unit' } },
        },
        { role: 'tool_result', toolUseId: 't1', content: 'FAIL src/list.test.ts\nexit code 1' },
      ],
    });
    expect(receipt.changes.items.map((file) => file.path)).toEqual(['src/list.ts']);
    expect(receipt.verification.items).toEqual([
      { command: 'pnpm test:unit', outcome: 'exit 1', failed: true },
    ]);
    expect(receipt.conversationOnly).toBe(false);
    expect(judgeCommandOutcome({ text: 'exit code 1' })).toBe('exit 1');
  });

  it('does not render empty tables when the task only talked', () => {
    const receipt = buildDeliveryReceipt({
      title: 'Just a question',
      phase: 'idle',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: { text: 'hi' } },
      ],
    });
    expect(receipt.conversationOnly).toBe(true);
    expect(receipt.changes.shown).toBe(false);
    expect(receipt.verification.shown).toBe(false);
    expect(receipt.outputs.shown).toBe(false);
    expect(receipt.changes.items).toEqual([]);
    expect(receipt.ci).toBe('none');
    expect(receipt.phase).not.toBe('passed');
  });

  it('says CI is unknown when the pull request status was not read', () => {
    const receipt = buildDeliveryReceipt({
      title: 'Open a PR',
      phase: 'finished',
      pullRequests: [{ url: 'https://github.com/acme/app/pull/12', status: 'unknown', checks: null }],
    });
    expect(receipt.prUrl).toBe('https://github.com/acme/app/pull/12');
    expect(receipt.ci).toBe('unknown');
    expect(receipt.ci).not.toBe('passed');
  });

  it('does not treat preview or temp files as outputs', () => {
    const receipt = buildDeliveryReceipt({
      title: 'Write a report',
      phase: 'finished',
      workingDir: '/repo',
      changedFiles: [
        { path: '/repo/preview/shot.png', status: 'added' },
        { path: '/repo/tmp/notes.pdf', status: 'added' },
        { path: '/repo/.preview/page.html', status: 'added' },
        { path: '/repo/out/report.pdf', status: 'added' },
      ],
    });
    expect(receipt.outputs.items).toEqual([{ path: '/repo/out/report.pdf', name: 'report.pdf' }]);
    expect(receipt.changes.items).toHaveLength(4);
  });

  it('keeps Codex exec and Pi bash commands, including a failed exit code', () => {
    const receipt = buildDeliveryReceipt({
      title: 'Run checks',
      messages: [
        {
          role: 'tool_use',
          toolUseId: 'pi',
          content: { toolName: 'bash', toolUseId: 'pi', input: { command: 'pnpm test' } },
        },
        { role: 'tool_result', toolUseId: 'pi', content: 'exit code 1' },
        {
          role: 'tool_use',
          toolUseId: 'codex',
          content: { toolName: 'exec', toolUseId: 'codex', input: { command: 'git status' } },
        },
        { role: 'tool_result', toolUseId: 'codex', content: { exitCode: 0 } },
      ],
    });
    expect(receipt.verification.items).toEqual([
      { command: 'pnpm test', outcome: 'exit 1', failed: true },
      { command: 'git status', outcome: 'exit 0', failed: false },
    ]);
  });

  it('keeps a created file in outputs after a later edit, and drops it after deletion', () => {
    const kept = buildDeliveryReceipt({
      title: 'Report',
      workingDir: '/repo',
      changedFiles: [
        { path: '/repo/out/report.pdf', status: 'added' },
        { path: '/repo/out/report.pdf', status: 'modified' },
      ],
    });
    expect(kept.outputs.items).toEqual([{ path: '/repo/out/report.pdf', name: 'report.pdf' }]);
    const removed = buildDeliveryReceipt({
      title: 'Report',
      workingDir: '/repo',
      changedFiles: [
        { path: '/repo/out/report.pdf', status: 'added' },
        { path: '/repo/out/report.pdf', status: 'deleted' },
      ],
    });
    expect(removed.outputs.shown).toBe(false);
  });

  it('drops an undone file and follows a later rename of a created file', () => {
    const undone = buildDeliveryReceipt({
      title: 'Report',
      workingDir: '/repo',
      changedFiles: [{ path: '/repo/out/report.csv', status: 'added', applied: false }],
    });
    expect(undone.outputs.shown).toBe(false);
    expect(undone.changes.shown).toBe(false);
    const renamed = buildDeliveryReceipt({
      title: 'Report',
      workingDir: '/repo',
      changedFiles: [
        { path: '/repo/out/report.csv', status: 'added' },
        { path: '/repo/out/final.csv', oldPath: '/repo/out/report.csv', status: 'renamed' },
      ],
    });
    expect(renamed.outputs.items).toEqual([{ path: '/repo/out/final.csv', name: 'final.csv' }]);
    expect(renamed.changes.items).toEqual([
      { path: '/repo/out/report.csv', openable: false },
      { path: '/repo/out/final.csv', openable: true },
    ]);
  });

  it('treats a persisted tool-error wrapper as a failed command', () => {
    const receipt = buildDeliveryReceipt({
      title: 'Run checks',
      messages: [
        {
          role: 'tool_use',
          toolUseId: 't1',
          content: { toolName: 'exec', toolUseId: 't1', input: { command: 'pnpm test' } },
        },
        {
          role: 'tool_result',
          toolUseId: 't1',
          content: '<tool_use_error>rejected</tool_use_error>',
        },
      ],
    });
    expect(receipt.verification.items).toEqual([
      { command: 'pnpm test', outcome: 'failed', failed: true },
    ]);
  });

  it('does not describe an unread pull-request list as none or passed', () => {
    const receipt = buildDeliveryReceipt({
      title: 'PR',
      pullRequestsUnavailable: true,
    });
    expect(receipt.ci).toBe('unknown');
    expect(receipt.prUrl).toBeNull();
  });
});
