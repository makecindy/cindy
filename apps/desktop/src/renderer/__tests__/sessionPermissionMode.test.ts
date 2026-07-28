/**
 * sessionPermissionMode.test.ts
 * ---------------------------------------------------------------------------
 * 会话权限档切换的唯一写入路径。原本内联在 ChatInput 里,权限卡片要用同一套语义
 * 才抽出来,所以这里锁死:Full access 二次确认门、远程/本地分支互斥、远程身份只认
 * 调用方入参(不回查 store)、runtime-first 顺序、持久化失败后的 runtime 回滚。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const makerApiForDevice = vi.fn<(deviceId: string) => unknown>();
const remoteSetPermissionMode = vi.fn<(sessionId: string, mode: string) => Promise<void>>();
const localSetPermissionMode = vi.fn<(sessionId: string, mode: string) => Promise<void>>();
const sessionUpdate = vi.fn<(sessionId: string, patch: unknown) => Promise<void>>();

vi.mock('@/lib/makerTransport', () => ({
  makerApiForDevice: (deviceId: string) => {
    makerApiForDevice(deviceId);
    return { setPermissionMode: remoteSetPermissionMode };
  },
}));

vi.mock('@/lib/sessionService', () => ({
  update: (sessionId: string, patch: unknown) => sessionUpdate(sessionId, patch),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }),
}));

import { applySessionPermissionModeChange } from '@/lib/sessionPermissionMode';

const SESSION_ID = 'perm-mode-session';

/** 默认不该被调用 —— 只有目标档是 bypassPermissions 时才过确认门。 */
const confirmNever = vi.fn(async () => {
  throw new Error('confirmFullAccess should not be called');
});

// 本文件跑在 node 环境(无 jsdom),自己造 window 来喂 electronAPI。globalThis 在同一
// worker 进程内跨文件共享,用后必须还原,否则后跑的用例会捡到这个假 window。
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

/** 失配标记要活过 renderer reload、但不跨 Electron 重启,所以模块落在 sessionStorage。 */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

let storage: Storage;

beforeEach(() => {
  vi.clearAllMocks();
  remoteSetPermissionMode.mockResolvedValue(undefined);
  localSetPermissionMode.mockResolvedValue(undefined);
  sessionUpdate.mockResolvedValue(undefined);
  storage = createMemoryStorage();
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: { maker: { setPermissionMode: localSetPermissionMode } },
    sessionStorage: storage,
  };
});

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as unknown as { window?: unknown }).window;
});

describe('applySessionPermissionModeChange', () => {
  it('本地会话 runtime-first:运行时成功后才落库', async () => {
    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      currentMode: 'ask',
      nextMode: 'acceptEdits',
      confirmFullAccess: confirmNever,
    });

    expect(outcome).toBe('ok');
    expect(localSetPermissionMode).toHaveBeenCalledWith(SESSION_ID, 'acceptEdits');
    expect(sessionUpdate).toHaveBeenCalledWith(SESSION_ID, { permissionMode: 'acceptEdits' });
    expect(localSetPermissionMode.mock.invocationCallOrder[0]!).toBeLessThan(
      sessionUpdate.mock.invocationCallOrder[0]!,
    );
    expect(remoteSetPermissionMode).not.toHaveBeenCalled();
  });

  it('device-link 远程会话纯镜像:按调用方给的 deviceId 直连隧道,不写本机库', async () => {
    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      deviceId: 'device-1',
      currentMode: 'ask',
      nextMode: 'acceptEdits',
      confirmFullAccess: confirmNever,
    });

    expect(outcome).toBe('ok');
    expect(makerApiForDevice).toHaveBeenCalledWith('device-1');
    expect(remoteSetPermissionMode).toHaveBeenCalledWith(SESSION_ID, 'acceptEdits');
    expect(localSetPermissionMode).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  // relay 瞬时重连会 clear() 掉 store 里的 session→device 映射,而视图仍按远程渲染
  // (lastRemoteDeviceIdRef 粘滞)。身份必须由调用方给死:本模块若自己回查 store,
  // 这一刻就会拿到空值、把远程 sessionId 灌进本机 IPC(必失败 + 污染本机记录)。
  it('身份只认入参:重连期间 store 索引为空也不退回本机分支', async () => {
    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      deviceId: 'sticky-device',
      currentMode: 'ask',
      nextMode: 'bypassPermissions',
      confirmFullAccess: vi.fn(async () => true),
    });

    expect(outcome).toBe('ok');
    expect(makerApiForDevice).toHaveBeenCalledWith('sticky-device');
    expect(localSetPermissionMode).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('进 Full access 必过确认门;取消则一处不改', async () => {
    const confirmFullAccess = vi.fn(async () => false);

    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      currentMode: 'ask',
      nextMode: 'bypassPermissions',
      confirmFullAccess,
    });

    expect(outcome).toBe('cancelled');
    expect(confirmFullAccess).toHaveBeenCalledOnce();
    expect(localSetPermissionMode).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('确认后才切进 Full access', async () => {
    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      currentMode: 'ask',
      nextMode: 'bypassPermissions',
      confirmFullAccess: vi.fn(async () => true),
    });

    expect(outcome).toBe('ok');
    expect(localSetPermissionMode).toHaveBeenCalledWith(SESSION_ID, 'bypassPermissions');
  });

  it('落库失败时把运行时回滚到原档', async () => {
    sessionUpdate.mockRejectedValueOnce(new Error('db down'));

    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      currentMode: 'ask',
      nextMode: 'acceptEdits',
      confirmFullAccess: confirmNever,
    });

    expect(outcome).toBe('failed');
    expect(localSetPermissionMode).toHaveBeenNthCalledWith(1, SESSION_ID, 'acceptEdits');
    expect(localSetPermissionMode).toHaveBeenNthCalledWith(2, SESSION_ID, 'ask');
  });

  // 回滚是又一次 setPermissionMode,同样触发 dismissAllPending。有挂起请求时它
  // 撤不回上一次已经结掉的那条(切到放行档时可能已在执行),却会连带结掉这期间
  // 新产生、用户没看过的请求 —— 宁可留下失配也不要再误伤一次。
  it('有挂起请求时落库失败不回滚,只记失配', async () => {
    const PENDING_SESSION = 'perm-mode-pending-no-rollback';
    sessionUpdate.mockRejectedValueOnce(new Error('db down'));

    const outcome = await applySessionPermissionModeChange({
      sessionId: PENDING_SESSION,
      currentMode: 'ask',
      nextMode: 'bypassPermissions',
      confirmFullAccess: vi.fn(async () => true),
      hasPendingInteraction: true,
    });

    expect(outcome).toBe('desynced');
    // 只有切档那一次写入,没有第二次(回滚)。
    expect(localSetPermissionMode).toHaveBeenCalledTimes(1);
    expect(localSetPermissionMode).toHaveBeenCalledWith(PENDING_SESSION, 'bypassPermissions');
  });

  // agent 在 main 侧,renderer 崩溃恢复页会 reload 页面而它照常活着并保持在新档。
  // 失配标记只存内存的话,reload 后重选显示中的档又被同档短路吃掉 —— Full access
  // 就此静默留存且无恢复路径。
  it('失配标记落 sessionStorage,活过 renderer reload', async () => {
    const RELOAD_SESSION = 'perm-mode-survives-reload';
    sessionUpdate.mockRejectedValueOnce(new Error('db down'));

    await applySessionPermissionModeChange({
      sessionId: RELOAD_SESSION,
      currentMode: 'ask',
      nextMode: 'bypassPermissions',
      confirmFullAccess: vi.fn(async () => true),
      hasPendingInteraction: true,
    });

    expect(storage.getItem(`cindy:permission-mode-desync:${RELOAD_SESSION}`)).toBe('1');

    // 模拟 reload:内存态整个丢掉,只剩 storage。
    vi.resetModules();
    const reloaded = await import('@/lib/sessionPermissionMode');
    localSetPermissionMode.mockClear();

    const reconcile = await reloaded.applySessionPermissionModeChange({
      sessionId: RELOAD_SESSION,
      currentMode: 'ask',
      nextMode: 'ask',
      confirmFullAccess: confirmNever,
    });

    expect(reconcile).toBe('ok');
    expect(localSetPermissionMode).toHaveBeenCalledWith(RELOAD_SESSION, 'ask');
    // 对账成功后标记一并清掉。
    expect(storage.getItem(`cindy:permission-mode-desync:${RELOAD_SESSION}`)).toBeNull();
  });

  // Electron 整个重启后 agent runtime 也没了,下一个 runtime 直接按 DB 档位重建 ——
  // 此刻 runtime 与 DB 本就一致,失配不存在。标记若还在(用 localStorage 就会),
  // 后续在权限卡片上点"当前已选中的档"会白调一次 setPermissionMode,把一条无关请求
  // dismiss 掉。sessionStorage 随新窗口清空,正好卡住这条边界。
  it('失配标记不跨窗口存活:新 browsing context 下同档恢复短路', async () => {
    const RESTART_SESSION = 'perm-mode-restart';
    sessionUpdate.mockRejectedValueOnce(new Error('db down'));

    await applySessionPermissionModeChange({
      sessionId: RESTART_SESSION,
      currentMode: 'ask',
      nextMode: 'bypassPermissions',
      confirmFullAccess: vi.fn(async () => true),
      hasPendingInteraction: true,
    });
    expect(storage.getItem(`cindy:permission-mode-desync:${RESTART_SESSION}`)).toBe('1');

    // 模拟 Electron 重启:模块内存态 + 窗口 sessionStorage 一起换新。
    vi.resetModules();
    const freshStorage = createMemoryStorage();
    (globalThis as unknown as { window: unknown }).window = {
      electronAPI: { maker: { setPermissionMode: localSetPermissionMode } },
      sessionStorage: freshStorage,
    };
    const restarted = await import('@/lib/sessionPermissionMode');
    localSetPermissionMode.mockClear();

    const outcome = await restarted.applySessionPermissionModeChange({
      sessionId: RESTART_SESSION,
      currentMode: 'ask',
      nextMode: 'ask',
      confirmFullAccess: confirmNever,
    });

    expect(outcome).toBe('unchanged');
    expect(localSetPermissionMode).not.toHaveBeenCalled();
  });

  it('运行时失败直接告败,不落库', async () => {
    localSetPermissionMode.mockRejectedValueOnce(new Error('runtime down'));

    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      currentMode: 'ask',
      nextMode: 'acceptEdits',
      confirmFullAccess: confirmNever,
    });

    expect(outcome).toBe('failed');
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  // PermissionSelector 的选项 onClick 无条件回调,点当前选中项也会进来;而 maker-core
  // 的 setPermissionMode 不管档位变没变都会 dismissAllPending。不短路的话,在权限卡片上
  // 点开菜单又点回当前档,手里那条 pending 就被顺手结掉了。
  it('点回当前档:零写入、不弹确认框', async () => {
    const confirmFullAccess = vi.fn(async () => true);

    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      currentMode: 'bypassPermissions',
      nextMode: 'bypassPermissions',
      confirmFullAccess,
    });

    expect(outcome).toBe('unchanged');
    expect(confirmFullAccess).not.toHaveBeenCalled();
    expect(localSetPermissionMode).not.toHaveBeenCalled();
    expect(remoteSetPermissionMode).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('点回当前档:远程会话同样零写入', async () => {
    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      deviceId: 'device-1',
      currentMode: 'acceptEdits',
      nextMode: 'acceptEdits',
      confirmFullAccess: confirmNever,
    });

    expect(outcome).toBe('unchanged');
    expect(makerApiForDevice).not.toHaveBeenCalled();
    expect(remoteSetPermissionMode).not.toHaveBeenCalled();
  });

  // runtime 写成功、落库失败、回滚也失败 → UI/DB 停在旧档,活着的 agent 却在新档。
  // 这时"重选界面上显示的那一档"是用户唯一的对账手段,不能被同档短路吃掉。
  it('回滚失败后同档重选能强制对账,成功后恢复短路', async () => {
    const DESYNC_SESSION = 'perm-mode-desync';
    sessionUpdate.mockRejectedValueOnce(new Error('db down'));
    localSetPermissionMode
      .mockResolvedValueOnce(undefined) // 写 nextMode 成功
      .mockRejectedValueOnce(new Error('rollback down')); // 回滚失败

    const first = await applySessionPermissionModeChange({
      sessionId: DESYNC_SESSION,
      currentMode: 'ask',
      nextMode: 'acceptEdits',
      confirmFullAccess: confirmNever,
    });
    expect(first).toBe('desynced');

    // 用户重选界面上显示的 ask:必须真的写一次 runtime,而不是 'unchanged'。
    localSetPermissionMode.mockResolvedValue(undefined);
    const reconcile = await applySessionPermissionModeChange({
      sessionId: DESYNC_SESSION,
      currentMode: 'ask',
      nextMode: 'ask',
      confirmFullAccess: confirmNever,
    });
    expect(reconcile).toBe('ok');
    expect(localSetPermissionMode).toHaveBeenLastCalledWith(DESYNC_SESSION, 'ask');

    // 对账成功后失配解除,同档短路恢复生效。
    localSetPermissionMode.mockClear();
    const afterReconcile = await applySessionPermissionModeChange({
      sessionId: DESYNC_SESSION,
      currentMode: 'ask',
      nextMode: 'ask',
      confirmFullAccess: confirmNever,
    });
    expect(afterReconcile).toBe('unchanged');
    expect(localSetPermissionMode).not.toHaveBeenCalled();
  });

  // 隧道那端也是 runtime-first:被控端 dispatch 先跑 IPC handler 再 await
  // persistRemoteSetting,落库失败时 agent 已切档而 DB / 控制端镜像停在旧档。
  // 控制端无法回滚,只能记账 —— 否则重选显示中的档会被同档短路吃掉,Full access
  // 就此静默留在生效状态。
  it('远程落库失败同样记为失配,重选同档能强制对账', async () => {
    const REMOTE_DESYNC_SESSION = 'perm-mode-remote-desync';
    remoteSetPermissionMode.mockRejectedValueOnce(new Error('host db down'));

    const first = await applySessionPermissionModeChange({
      sessionId: REMOTE_DESYNC_SESSION,
      deviceId: 'device-1',
      currentMode: 'ask',
      nextMode: 'bypassPermissions',
      confirmFullAccess: vi.fn(async () => true),
    });
    expect(first).toBe('desynced');

    // 重选界面上显示的 ask:必须真的再走一次隧道,而不是被短路成 'unchanged'。
    const reconcile = await applySessionPermissionModeChange({
      sessionId: REMOTE_DESYNC_SESSION,
      deviceId: 'device-1',
      currentMode: 'ask',
      nextMode: 'ask',
      confirmFullAccess: confirmNever,
    });
    expect(reconcile).toBe('ok');
    expect(remoteSetPermissionMode).toHaveBeenLastCalledWith(REMOTE_DESYNC_SESSION, 'ask');
  });

  // Full access 确认框可以一直开着,期间原请求可能已被别处(灵动岛 / 另一个控制端)
  // 解决、agent 又产生了新的 pending。照旧写入会让 dismissAllPending 放行用户没看过的
  // 那条新请求。
  it('确认后原请求已失效则放弃写入', async () => {
    const assertStillApplicable = vi.fn(() => false);

    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      currentMode: 'ask',
      nextMode: 'bypassPermissions',
      confirmFullAccess: vi.fn(async () => true),
      assertStillApplicable,
    });

    expect(outcome).toBe('cancelled');
    expect(assertStillApplicable).toHaveBeenCalledOnce();
    expect(localSetPermissionMode).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('原请求仍在则照常写入', async () => {
    const outcome = await applySessionPermissionModeChange({
      sessionId: SESSION_ID,
      currentMode: 'ask',
      nextMode: 'acceptEdits',
      confirmFullAccess: confirmNever,
      assertStillApplicable: () => true,
    });

    expect(outcome).toBe('ok');
    expect(localSetPermissionMode).toHaveBeenCalledWith(SESSION_ID, 'acceptEdits');
  });

  it('无 sessionId(新建草稿)只过确认门,不碰 runtime/DB', async () => {
    const outcome = await applySessionPermissionModeChange({
      currentMode: 'ask',
      nextMode: 'acceptEdits',
      confirmFullAccess: confirmNever,
    });

    expect(outcome).toBe('ok');
    expect(localSetPermissionMode).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });
});
