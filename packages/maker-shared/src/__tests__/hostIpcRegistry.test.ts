/*
 * 测试价值
 * - 生产入口与可观察结果：HOST_IPC_ENTRIES / hostIpcFingerprint / checkHostIpcArgs / checkHostIpcValue；
 *   窗口与 Host 通过指纹判断同一通道的参数与返回形状是否一致，Host 用同一校验器拒绝非法参数。
 * - Bug／规则依据：docs/host/headless-runtime-plan.md 第 1a 批「已登记通道是跨版本合同」；
 *   窗口与 Host 版本可以长期并存，悄悄改签名会让旧窗口拿到它不认识的形状。
 * - 现有覆盖缺口：新模块，没有相邻测试。
 * - 最小失败输入：改动已登记条目的 params/result/contractVersion 而不换通道名；空白会话 id；
 *   新条目追加在末尾而不是按名排序（多个 PR 同时登记会落在同一行冲突）；可选字段缺失或取值越界。
 * - tier：unit（纯数据与纯函数）。
 */
import { describe, expect, it } from 'vitest';

import {
  HOST_IPC_ENTRIES,
  HOST_IPC_FAMILIES,
  checkHostIpcArgs,
  checkHostIpcValue,
  findHostIpcEntry,
  hostIpcFingerprint,
  type HostIpcEntry,
} from '../hostIpcRegistry';

/**
 * Locked contracts. A failure here means a registered channel's arguments,
 * result shape or meaning changed: older windows and Hosts keep talking to each
 * other for as long as a task runs, so register a new channel name instead of
 * editing this table. Keys stay sorted (checked below).
 */
const LOCKED_FINGERPRINTS: Record<string, string> = {
  'maker:session-background-tasks:list': '57eb48ca440d1aa0',
  'maker:side-chat:list:v1': '6190d57f7d39b3a1',
};

const sorted = (values: readonly string[]) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe('host IPC registry', () => {
  it('keeps every registered contract fingerprint (change the channel name to change a signature)', () => {
    const actual = Object.fromEntries(HOST_IPC_ENTRIES.map((entry) => [entry.channel, hostIpcFingerprint(entry)]));
    for (const [channel, fingerprint] of Object.entries(LOCKED_FINGERPRINTS)) {
      expect(actual[channel], `${channel}: registered signature changed; use a new channel name or keep it compatible`)
        .toBe(fingerprint);
    }
    // New entries must be locked here too, so the next edit to them is caught.
    expect(Object.keys(actual).sort()).toEqual(Object.keys(LOCKED_FINGERPRINTS).sort());
    // Batch 1a: local reads only; remote/web audiences and writes need their own design.
    expect(HOST_IPC_ENTRIES.every((entry) => entry.access === 'read' && entry.audience.join() === 'local')).toBe(true);
  });

  it('keeps every registration point sorted and every channel registered once', () => {
    // Sorted lists put parallel additions in different places instead of all at the end.
    expect(Object.keys(HOST_IPC_FAMILIES)).toEqual(sorted(Object.keys(HOST_IPC_FAMILIES)));
    for (const [family, entries] of Object.entries(HOST_IPC_FAMILIES)) {
      const channels = entries.map((entry) => entry.channel);
      expect(channels, family).toEqual(sorted(channels));
    }
    expect(Object.keys(LOCKED_FINGERPRINTS)).toEqual(sorted(Object.keys(LOCKED_FINGERPRINTS)));
    const channels = HOST_IPC_ENTRIES.map((entry) => entry.channel);
    expect(channels).toEqual(sorted(channels));
    expect(new Set(channels).size).toBe(channels.length);
  });

  it('fingerprints the contract (shape and meaning), not key order or local policy', () => {
    const base = findHostIpcEntry('maker:side-chat:list:v1')!;
    const reordered = { ...base, result: base.result, params: base.params, channel: base.channel } as HostIpcEntry;
    const policy = { ...base, timeoutMs: 1, sender: base.sender } as HostIpcEntry;
    expect(hostIpcFingerprint(reordered)).toBe(hostIpcFingerprint(base));
    expect(hostIpcFingerprint(policy)).toBe(hostIpcFingerprint(base));
    for (const changed of [
      { ...base, contractVersion: 2 },
      { ...base, params: [{ type: 'string' }] },
      { ...base, result: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } },
    ] as HostIpcEntry[]) {
      expect(hostIpcFingerprint(changed)).not.toBe(hostIpcFingerprint(base));
    }
  });

  it('checks arguments like the embedded handler and result shapes strictly', () => {
    const entry = findHostIpcEntry('maker:side-chat:list:v1')!;
    // Same acceptance as requireString(): blank ids are rejected, not looked up.
    expect.soft(checkHostIpcArgs(entry, ['parent-1'])).toBeNull();
    for (const args of [[], ['a', 'b'], [''], ['   '], [42], 'parent-1']) {
      expect.soft(checkHostIpcArgs(entry, args), JSON.stringify(args)).toMatch(/argument|args/);
    }
    expect(checkHostIpcValue(entry.result, [{ id: 'child-1' }])).toBeNull();
    // An extra field is a shape change the fingerprint does not know about.
    expect(checkHostIpcValue(entry.result, [{ id: 'child-1', title: 'x' }])).toBe('value[0].title is not part of the contract');
    expect(checkHostIpcValue(entry.result, [{}])).toBe('value[0].id must be a string');
  });

  it('accepts absent optional fields and refuses values outside a closed set', () => {
    const entry = findHostIpcEntry('maker:session-background-tasks:list')!;
    // Same acceptance as the embedded `typeof` check: any string, including empty.
    expect(checkHostIpcArgs(entry, [''])).toBeNull();
    expect(checkHostIpcArgs(entry, [undefined])).toMatch(/argument 1/);
    expect(checkHostIpcValue(entry.result, { tasks: [], pendingContinuations: 0 })).toBeNull();
    expect(checkHostIpcValue(entry.result, { tasks: [{ taskId: 't1' }], pendingContinuations: 1 })).toBeNull();
    expect(checkHostIpcValue(entry.result, {
      tasks: [{ taskId: 't1', taskType: 'local_bash', backgroundCommandKind: 'service', toolUseId: 'u1', title: 'dev',
        provider: 'pi', outputFile: '/tmp/out' }],
      pendingContinuations: 0,
    })).toBeNull();
    expect(checkHostIpcValue(entry.result, { tasks: [{ taskId: 't1', provider: 'codex' }], pendingContinuations: 0 }))
      .toBe('value.tasks[0].provider is not an allowed value');
    expect(checkHostIpcValue(entry.result, { tasks: [] })).toBe('value.pendingContinuations must be a finite number');
    expect(checkHostIpcValue(entry.result, { tasks: [], pendingContinuations: 0.5 }))
      .toBe('value.pendingContinuations must be an integer');
  });
});
