/** workspaceSlot.test — 工作区会话槽(workspace)的假 deps 单测。 */

import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import {
  GhostWorkspaceSlot,
  type WorkspaceSessionService,
  type WorkspaceSlotDeps,
} from '../workspaceSlot';

function workspaceGhost(options: { workspace?: boolean; enabled?: boolean } = {}): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'ws-ghost',
      name: 'Workspace Ghost',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      ...(options.workspace === false ? {} : { workspace: true }),
    },
    dir: '/fake/ws-ghost',
    enabled: options.enabled ?? true,
  } as InstalledGhost;
}

function makeService(overrides: Partial<WorkspaceSessionService> = {}): WorkspaceSessionService {
  return {
    findActiveSessionByWorkdir: vi.fn(async () => null),
    createDraftSession: vi.fn(async () => 'new-session-id'),
    focusSession: vi.fn(),
    ...overrides,
  };
}

function makeSlot(
  overrides: Partial<WorkspaceSlotDeps> = {},
  service: WorkspaceSessionService | null = makeService(),
) {
  let clock = 0;
  const deps: WorkspaceSlotDeps = {
    getGhost: () => workspaceGhost(),
    showDirectoryDialog: vi.fn(async () => '/Users/me/projects/demo'),
    resolveCallContext: vi.fn(() => ({ ghostId: 'ws-ghost', sessionId: 'sess-1' })),
    getSessionDirInfo: vi.fn(async () => ({
      workingDir: '/Users/me/projects/demo',
      remoteHostId: null,
    })),
    statDir: vi.fn(async () => 'ok' as const),
    isInsideWorkdir: vi.fn(() => true),
    confirmDir: vi.fn(async () => ({ ok: true as const })),
    now: () => (clock += 60_000),
    ...overrides,
  };
  const slot = new GhostWorkspaceSlot(deps);
  slot.setSessionService(service);
  return { slot, deps, service };
}

const PICK_REQ = { kind: 'ensure-session', mode: 'pick' } as const;
const DIR_REQ = {
  kind: 'ensure-session',
  mode: 'dir',
  dir: '/Users/me/other/repo',
  callId: 'call-1',
} as const;

describe('workspaceSlot · 资格审与载荷校验', () => {
  it('未声明 workspace 能力 / 未启用 一律 PERMISSION_DENIED', async () => {
    const noSlot = makeSlot({ getGhost: () => workspaceGhost({ workspace: false }) });
    expect(await noSlot.slot.handleRequest('ws-ghost', PICK_REQ)).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    const disabled = makeSlot({ getGhost: () => workspaceGhost({ enabled: false }) });
    expect(await disabled.slot.handleRequest('ws-ghost', PICK_REQ)).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
  });

  it('kind/mode/title/focus 形状不对整单拒', async () => {
    const { slot } = makeSlot();
    expect(await slot.handleRequest('ws-ghost', { kind: 'x', mode: 'pick' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(
      await slot.handleRequest('ws-ghost', { kind: 'ensure-session', mode: 'open' }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(await slot.handleRequest('ws-ghost', { ...PICK_REQ, title: 1 })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(await slot.handleRequest('ws-ghost', { ...PICK_REQ, focus: 'yes' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
  });

  it('会话服务未注入 = HOST_NOT_READY', async () => {
    const { slot } = makeSlot({}, null);
    expect(await slot.handleRequest('ws-ghost', PICK_REQ)).toMatchObject({
      ok: false,
      errorCode: 'HOST_NOT_READY',
    });
  });
});

describe('workspaceSlot · pick 流(亲选即授权)', () => {
  it('用户选中 → 判重未命中 → 创建空会话;绝对路径不回沙箱', async () => {
    const { slot, service } = makeSlot();
    const result = await slot.handleRequest('ws-ghost', { ...PICK_REQ, title: '选择项目' });
    expect(result).toMatchObject({ ok: true, sessionId: 'new-session-id', created: true, name: 'demo' });
    expect(service!.createDraftSession).toHaveBeenCalledWith({
      dirAbs: '/Users/me/projects/demo',
      title: '选择项目',
      ghostId: 'ws-ghost',
    });
    expect(JSON.stringify(result)).not.toContain('/Users');
  });

  it('判重命中 → 复用不新建;focus:true 时跳转聚焦', async () => {
    const service = makeService({ findActiveSessionByWorkdir: vi.fn(async () => 'old-session') });
    const { slot } = makeSlot({}, service);
    const result = await slot.handleRequest('ws-ghost', { ...PICK_REQ, focus: true });
    expect(result).toMatchObject({ ok: true, sessionId: 'old-session', created: false });
    expect(service.createDraftSession).not.toHaveBeenCalled();
    expect(service.focusSession).toHaveBeenCalledWith('old-session');
  });

  it('缺省不聚焦(只落侧边栏)', async () => {
    const { slot, service } = makeSlot();
    await slot.handleRequest('ws-ghost', PICK_REQ);
    expect(service!.focusSession).not.toHaveBeenCalled();
  });

  it('用户取消 = CANCELLED', async () => {
    const { slot } = makeSlot({ showDirectoryDialog: vi.fn(async () => null) });
    expect(await slot.handleRequest('ws-ghost', PICK_REQ)).toMatchObject({
      ok: false,
      errorCode: 'CANCELLED',
    });
  });

  it('对话框打不开(无宿主窗口)= INTERNAL,失败关闭', async () => {
    const { slot } = makeSlot({
      showDirectoryDialog: vi.fn(async () => {
        throw new Error('no window');
      }),
    });
    expect(await slot.handleRequest('ws-ghost', PICK_REQ)).toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
    });
  });
});

describe('workspaceSlot · dir 流(callId 上下文凭证 + 两档钳制)', () => {
  it('缺 dir / 缺 callId / 相对路径 整单拒', async () => {
    const { slot } = makeSlot();
    expect(
      await slot.handleRequest('ws-ghost', { kind: 'ensure-session', mode: 'dir', callId: 'c' }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(
      await slot.handleRequest('ws-ghost', { kind: 'ensure-session', mode: 'dir', dir: '/a' }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(
      await slot.handleRequest('ws-ghost', {
        kind: 'ensure-session',
        mode: 'dir',
        dir: 'relative/path',
        callId: 'c',
      }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
  });

  it('callId 查无 / 不属于本插件 = PERMISSION_DENIED(冒名即拒)', async () => {
    const missing = makeSlot({ resolveCallContext: vi.fn(() => null) });
    expect(await missing.slot.handleRequest('ws-ghost', DIR_REQ)).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    const foreign = makeSlot({
      resolveCallContext: vi.fn(() => ({ ghostId: 'other-ghost', sessionId: 'sess-1' })),
    });
    expect(await foreign.slot.handleRequest('ws-ghost', DIR_REQ)).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
  });

  it('无会话语境无法弹卡 = INVALID_REQUEST(引导改用 pick)', async () => {
    const { slot } = makeSlot({
      resolveCallContext: vi.fn(() => ({ ghostId: 'ws-ghost', sessionId: null })),
    });
    expect(await slot.handleRequest('ws-ghost', DIR_REQ)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
  });

  it('目录不存在 / 不是目录 分别报 DIR_NOT_FOUND / NOT_DIRECTORY', async () => {
    const missing = makeSlot({ statDir: vi.fn(async () => 'not-found' as const) });
    expect(await missing.slot.handleRequest('ws-ghost', DIR_REQ)).toMatchObject({
      ok: false,
      errorCode: 'DIR_NOT_FOUND',
    });
    const file = makeSlot({ statDir: vi.fn(async () => 'not-directory' as const) });
    expect(await file.slot.handleRequest('ws-ghost', DIR_REQ)).toMatchObject({
      ok: false,
      errorCode: 'NOT_DIRECTORY',
    });
  });

  it('目录在会话 workdir 内 → 免确认直通', async () => {
    const { slot, deps } = makeSlot({ isInsideWorkdir: vi.fn(() => true) });
    const result = await slot.handleRequest('ws-ghost', DIR_REQ);
    expect(result).toMatchObject({ ok: true, created: true, name: 'repo' });
    expect(deps.confirmDir).not.toHaveBeenCalled();
  });

  it('目录在 workdir 外 → 弹确认卡;拒绝/超时 = CANCELLED', async () => {
    const allowed = makeSlot({ isInsideWorkdir: vi.fn(() => false) });
    expect(await allowed.slot.handleRequest('ws-ghost', DIR_REQ)).toMatchObject({
      ok: true,
      created: true,
    });
    expect(allowed.deps.confirmDir).toHaveBeenCalledWith({
      ghostId: 'ws-ghost',
      sessionId: 'sess-1',
      dirAbs: '/Users/me/other/repo',
    });

    const denied = makeSlot({
      isInsideWorkdir: vi.fn(() => false),
      confirmDir: vi.fn(async () => ({ ok: false as const, message: '用户拒绝' })),
    });
    expect(await denied.slot.handleRequest('ws-ghost', DIR_REQ)).toMatchObject({
      ok: false,
      errorCode: 'CANCELLED',
    });
  });

  it('会话快照读不到(查无/读失败)→ 同样硬拒,不落确认卡路径(fail closed)', async () => {
    const service = makeService();
    const { slot, deps } = makeSlot(
      { getSessionDirInfo: vi.fn(async () => null), isInsideWorkdir: vi.fn(() => true) },
      service,
    );
    expect(await slot.handleRequest('ws-ghost', DIR_REQ)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(deps.confirmDir).not.toHaveBeenCalled();
    expect(service.createDraftSession).not.toHaveBeenCalled();
  });

  it('发起会话是远程工作区(remoteHostId 非空)→ 硬拒(fail closed),不弹卡不创建', async () => {
    const service = makeService();
    const { slot, deps } = makeSlot(
      {
        getSessionDirInfo: vi.fn(async () => ({
          workingDir: '/remote/proj',
          remoteHostId: 'ssh-host',
        })),
        isInsideWorkdir: vi.fn(() => true),
      },
      service,
    );
    expect(await slot.handleRequest('ws-ghost', DIR_REQ)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(deps.confirmDir).not.toHaveBeenCalled();
    expect(deps.isInsideWorkdir).not.toHaveBeenCalled();
    expect(service.createDraftSession).not.toHaveBeenCalled();
  });

  it('并发 ensure 串行化:第二单等第一单建完,命中复用不双建', async () => {
    let created: string | null = null;
    let releaseCreate: (v: string) => void = () => {};
    const createGate = new Promise<string>((resolve) => {
      releaseCreate = resolve;
    });
    const service = makeService({
      findActiveSessionByWorkdir: vi.fn(async () => created),
      createDraftSession: vi.fn(async () => {
        const id = await createGate;
        created = id;
        return id;
      }),
    });
    // 两个不同插件(各自频控互不影响),同目录、workdir 内免确认路径。
    const { slot } = makeSlot(
      {
        getGhost: (id) =>
          ({ ...workspaceGhost(), manifest: { ...workspaceGhost().manifest, id } }) as never,
        isInsideWorkdir: vi.fn(() => true),
        resolveCallContext: vi.fn((callId: string) =>
          callId === 'call-a'
            ? { ghostId: 'ghost-a', sessionId: 'sess-1' }
            : { ghostId: 'ghost-b', sessionId: 'sess-1' },
        ),
      },
      service,
    );
    const first = slot.handleRequest('ghost-a', {
      kind: 'ensure-session',
      mode: 'dir',
      dir: '/Users/me/other/repo',
      callId: 'call-a',
    });
    const second = slot.handleRequest('ghost-b', {
      kind: 'ensure-session',
      mode: 'dir',
      dir: '/Users/me/other/repo',
      callId: 'call-b',
    });
    releaseCreate('sess-new');
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toMatchObject({ ok: true, sessionId: 'sess-new', created: true });
    expect(r2).toMatchObject({ ok: true, sessionId: 'sess-new', created: false });
    expect(service.createDraftSession).toHaveBeenCalledTimes(1);
  });
});

describe('workspaceSlot · 骚扰钳制与失败面', () => {
  it('同插件两次请求间隔不足 = RATE_LIMITED(按尝试记账)', async () => {
    let clock = 0;
    const { slot } = makeSlot({ now: () => (clock += 1000) });
    expect((await slot.handleRequest('ws-ghost', PICK_REQ)).ok).toBe(true);
    expect(await slot.handleRequest('ws-ghost', PICK_REQ)).toMatchObject({
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
    const first = slot.handleRequest('ws-ghost', PICK_REQ);
    const second = await slot.handleRequest('ws-ghost', PICK_REQ);
    expect(second).toMatchObject({ ok: false, errorCode: 'BUSY' });
    release('/tmp/dir');
    expect((await first).ok).toBe(true);
  });

  it('确认通道 reject(桥未就绪/通道异常)折叠成 INTERNAL,并释放在场标记', async () => {
    const { slot } = makeSlot({
      isInsideWorkdir: vi.fn(() => false),
      confirmDir: vi.fn(async () => {
        throw new Error('bridge down');
      }),
    });
    expect(await slot.handleRequest('ws-ghost', DIR_REQ)).toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
    });
    // 在场标记已释放:下一单(过频控后)不会被误判 BUSY。
    let clock = 10 * 60_000;
    const next = makeSlot({ now: () => (clock += 60_000) });
    expect((await next.slot.handleRequest('ws-ghost', PICK_REQ)).ok).toBe(true);
  });

  it('创建失败折叠成 INTERNAL,不泄漏内部错误细节', async () => {
    const service = makeService({
      createDraftSession: vi.fn(async () => {
        throw new Error('db exploded at C:\\secret\\path');
      }),
    });
    const { slot } = makeSlot({}, service);
    const result = await slot.handleRequest('ws-ghost', PICK_REQ);
    expect(result).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
