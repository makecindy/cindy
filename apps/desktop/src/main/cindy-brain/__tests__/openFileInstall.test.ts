/**
 * openFileInstall.test.ts —— 待装转交缓冲的不变量。
 *
 * 钉住的核心不变量:**装入来源(origin)与待装路径同存同取。**
 *
 * 为什么值得一条专门的测试:来源决定确认框是否展示「这次是 Agent 发起的」红色
 * 横幅并加重确认,是一条安全事实。第一版实现把它只挂在 `ghosts:install-requested`
 * 广播 payload 上,而广播是易失通道——macOS 关窗后应用不退出,scheduler 拉起的
 * agent 仍能调 `ghost_forge_pack`,此刻 `getAllWindows()` 为空、广播无人接收,
 * 但路径仍留在缓冲里等 renderer 挂载后自取。那一取就把 origin 丢了,
 * Agent 发起的装入被显示成手动。**丢失方向恰好是最危险的那个**,所以这里用
 * 「零窗口」这个具体场景把两者的绑定钉死。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const windows: { isDestroyed: () => boolean; webContents: { send: (ch: string) => void } }[] = [];
const sent: string[] = [];

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const { handleIncomingCindyFile, takePendingCindyInstall } = await import('../openFileInstall');
const { MANUAL_GHOST_INSTALL_ORIGIN } = await import('../../../shared/ghostInstallOrigin');

const AGENT_ORIGIN = {
  kind: 'agent-forge' as const,
  sessionTitle: '处理外部文档',
  sourceRelPath: 'plugins/evil',
};

/** 用本文件自身当"存在且可读的普通文件",避免造临时目录。 */
const REAL_FILE = fileURLToPath(import.meta.url);

beforeEach(() => {
  windows.length = 0;
  sent.length = 0;
  takePendingCindyInstall(); // 清干净上一条用例可能留下的缓冲
});

function addWindow(): void {
  windows.push({
    isDestroyed: () => false,
    webContents: { send: (ch: string) => sent.push(ch) },
  });
}

describe('openFileInstall · origin 与路径同存同取', () => {
  it('零窗口(macOS 关窗后 agent 转交):广播没人收,但 origin 仍能被取到', async () => {
    await handleIncomingCindyFile(REAL_FILE, 'ghost-forge', AGENT_ORIGIN);
    expect(sent).toEqual([]); // 没有窗口 → 广播确实丢了

    const pending = takePendingCindyInstall();
    expect(pending?.filePath).toBe(REAL_FILE);
    expect(pending?.origin).toEqual(AGENT_ORIGIN); // ← 丢广播不等于丢来源
  });

  it('有窗口:广播只是通知,不携带任何事实', async () => {
    addWindow();
    await handleIncomingCindyFile(REAL_FILE, 'ghost-forge', AGENT_ORIGIN);
    // send 只带 channel,没有第二个参数——事实的唯一来源是缓冲。
    expect(sent).toEqual(['ghosts:install-requested']);
    expect(takePendingCindyInstall()?.origin).toEqual(AGENT_ORIGIN);
  });

  it('手动入口(双击 / open-file)不传 origin 时缺省 manual', async () => {
    await handleIncomingCindyFile(REAL_FILE, 'open-file');
    expect(takePendingCindyInstall()?.origin).toEqual(MANUAL_GHOST_INSTALL_ORIGIN);
  });

  it('取即清空:同一条待装项不会被消费两次', async () => {
    await handleIncomingCindyFile(REAL_FILE, 'ghost-forge', AGENT_ORIGIN);
    expect(takePendingCindyInstall()).not.toBeNull();
    expect(takePendingCindyInstall()).toBeNull();
  });

  it('只保留最新一条,且换条时来源随之更新(不会残留上一条的 agent 来源)', async () => {
    await handleIncomingCindyFile(REAL_FILE, 'ghost-forge', AGENT_ORIGIN);
    await handleIncomingCindyFile(REAL_FILE, 'open-file');
    expect(takePendingCindyInstall()?.origin).toEqual(MANUAL_GHOST_INSTALL_ORIGIN);
  });

  it('路径不存在:不写缓冲、不广播(容错口径与 open-folder 一致)', async () => {
    addWindow();
    await handleIncomingCindyFile(
      path.join(path.dirname(REAL_FILE), 'definitely-not-here.cindy'),
      'open-file',
    );
    expect(sent).toEqual([]);
    expect(takePendingCindyInstall()).toBeNull();
  });
});
