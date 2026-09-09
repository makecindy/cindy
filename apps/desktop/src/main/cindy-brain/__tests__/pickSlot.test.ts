/** pickSlot.test — 目录选择槽(pick)的假 deps 单测。 */

import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { GhostPickSlot, type PickSlotDeps } from '../pickSlot';

function pickGhost(options: { pick?: boolean; node?: boolean; enabled?: boolean } = {}): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'pick-ghost',
      name: 'Pick Ghost',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      ...(options.pick === false ? {} : { pick: true }),
      ...(options.node !== false
        ? { node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' } }
        : {}),
    },
    dir: '/fake/pick-ghost',
    enabled: options.enabled ?? true,
  } as InstalledGhost;
}

function makeSlot(overrides: Partial<PickSlotDeps> = {}) {
  let clock = 0;
  const deps: PickSlotDeps = {
    getGhost: () => pickGhost(),
    showDirectoryDialog: vi.fn(async () => '/Users/me/projects'),
    depositDir: vi.fn(() => ({
      ok: true as const,
      receipt: { token: 't', file_count: 1, total_bytes: 10, rel_paths: ['a.txt'] },
    })),
    now: () => (clock += 60_000),
    ...overrides,
  };
  return { slot: new GhostPickSlot(deps), deps };
}

describe('pickSlot · 资格审与载荷校验', () => {
  it('未声明 pick 能力 / 未启用 一律 PERMISSION_DENIED', async () => {
    const noSlot = makeSlot({ getGhost: () => pickGhost({ pick: false }) });
    expect(await noSlot.slot.handleRequest('pick-ghost', { mode: 'directory' })).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    const disabled = makeSlot({ getGhost: () => pickGhost({ enabled: false }) });
    expect(await disabled.slot.handleRequest('pick-ghost', { mode: 'directory' })).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
  });

  it('mode 只认 directory;title/deposit 类型不对整单拒', async () => {
    const { slot } = makeSlot();
    expect(await slot.handleRequest('pick-ghost', { mode: 'file' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(await slot.handleRequest('pick-ghost', { mode: 'directory', title: 1 })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(
      await slot.handleRequest('pick-ghost', { mode: 'directory', deposit: 'yes' }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
  });

  it('未声明 node 能力的插件必须 deposit:true,否则选完什么都拿不到 = 拒单', async () => {
    const { slot } = makeSlot({ getGhost: () => pickGhost({ node: false }) });
    expect(await slot.handleRequest('pick-ghost', { mode: 'directory' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
  });
});

describe('pickSlot · 授权 = 用户亲选', () => {
  it('用户选中:node 槽插件拿到 path;deposit:true 再拿票据', async () => {
    const { slot, deps } = makeSlot();
    const result = await slot.handleRequest('pick-ghost', {
      mode: 'directory',
      title: '选择项目父目录',
      deposit: true,
    });
    expect(result).toMatchObject({
      ok: true,
      name: 'projects',
      path: '/Users/me/projects',
      dir_deposit: { token: 't' },
    });
    expect(deps.showDirectoryDialog).toHaveBeenCalledWith({
      ghostName: 'Pick Ghost',
      purpose: '选择项目父目录',
    });
  });

  it('不带 deposit 时只有 path,没有票据;非 node 插件带 deposit 只有票据没有 path', async () => {
    const { slot } = makeSlot();
    const nodeOnly = await slot.handleRequest('pick-ghost', { mode: 'directory' });
    expect(nodeOnly).toMatchObject({ ok: true, path: '/Users/me/projects' });
    expect((nodeOnly as { dir_deposit?: unknown }).dir_deposit).toBeUndefined();

    const depositOnly = makeSlot({ getGhost: () => pickGhost({ node: false }) });
    const r = await depositOnly.slot.handleRequest('pick-ghost', {
      mode: 'directory',
      deposit: true,
    });
    expect(r).toMatchObject({ ok: true, dir_deposit: { token: 't' } });
    expect((r as { path?: unknown }).path).toBeUndefined();
  });

  it('用户取消 = CANCELLED,插件拿不到任何路径信息', async () => {
    const { slot } = makeSlot({ showDirectoryDialog: vi.fn(async () => null) });
    const result = await slot.handleRequest('pick-ghost', { mode: 'directory' });
    expect(result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    expect(JSON.stringify(result)).not.toContain('/Users');
  });

  it('票据签发失败(如超收集上限)如实报 INTERNAL,不发半成品', async () => {
    const { slot } = makeSlot({
      depositDir: () => ({ ok: false as const, message: '超过收集上限' }),
    });
    expect(
      await slot.handleRequest('pick-ghost', { mode: 'directory', deposit: true }),
    ).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
  });

  it('亲选成功记台账(recordPickedDir);取消不记', async () => {
    const recordPickedDir = vi.fn();
    const { slot } = makeSlot({ recordPickedDir });
    await slot.handleRequest('pick-ghost', { mode: 'directory' });
    expect(recordPickedDir).toHaveBeenCalledWith('pick-ghost', '/Users/me/projects');

    const cancelled = makeSlot({
      showDirectoryDialog: vi.fn(async () => null),
      recordPickedDir,
    });
    recordPickedDir.mockClear();
    await cancelled.slot.handleRequest('pick-ghost', { mode: 'directory' });
    expect(recordPickedDir).not.toHaveBeenCalled();
  });

  it('票据签发失败也已记台账(用户确实亲选过,授权事实不随票据丢)', async () => {
    const recordPickedDir = vi.fn();
    const { slot } = makeSlot({
      depositDir: () => ({ ok: false as const, message: '超过收集上限' }),
      recordPickedDir,
    });
    await slot.handleRequest('pick-ghost', { mode: 'directory', deposit: true });
    expect(recordPickedDir).toHaveBeenCalledWith('pick-ghost', '/Users/me/projects');
  });
});

describe('pickSlot · 骚扰钳制', () => {
  it('同插件两次请求间隔不足 = RATE_LIMITED(按尝试记账)', async () => {
    let clock = 0;
    const { slot } = makeSlot({ now: () => (clock += 1000) });
    expect((await slot.handleRequest('pick-ghost', { mode: 'directory' })).ok).toBe(true);
    expect(await slot.handleRequest('pick-ghost', { mode: 'directory' })).toMatchObject({
      ok: false,
      errorCode: 'RATE_LIMITED',
    });
  });

  it('已有选择框在场 = BUSY,不排队', async () => {
    let release: (value: string | null) => void = () => {};
    const gate = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const { slot } = makeSlot({ showDirectoryDialog: vi.fn(() => gate) });
    const first = slot.handleRequest('pick-ghost', { mode: 'directory' });
    const second = await slot.handleRequest('pick-ghost', { mode: 'directory' });
    expect(second).toMatchObject({ ok: false, errorCode: 'BUSY' });
    release('/tmp/dir');
    expect((await first).ok).toBe(true);
  });

  it('对话框打不开(无宿主窗口)= INTERNAL,失败关闭', async () => {
    const { slot } = makeSlot({
      showDirectoryDialog: vi.fn(async () => {
        throw new Error('no window');
      }),
    });
    expect(await slot.handleRequest('pick-ghost', { mode: 'directory' })).toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
    });
  });
});
