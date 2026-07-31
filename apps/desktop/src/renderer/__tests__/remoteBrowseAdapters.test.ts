/**
 * remoteBrowseAdapters.test.ts —— 「添加远程项目」两类来源的目录浏览适配器。
 *
 * 命门:两类来源的路径拼接差异必须封装在适配器里。
 *   - SSH adapter:childPath / parent 用 posixJoin / posixParent(SSH 永远 POSIX)。
 *   - device-link adapter:childPath / parent **直接用被控端 handler 回传的 native 路径**
 *     (被控端可能是 Windows,renderer 不拼接),且经隧道 deviceLink.invoke 调 fs:* channel。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  posixJoin,
  posixParent,
  sshBrowseAdapter,
  deviceLinkBrowseAdapter,
} from '@/components/new-chat/remoteBrowseAdapters';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

const listRemoteDir = vi.fn();
const statRemotePath = vi.fn();
const mkdirPRemote = vi.fn();
const invoke = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', {
    electronAPI: {
      remoteSsh: { listRemoteDir, statRemotePath, mkdirPRemote },
      deviceLink: { invoke },
    },
  });
});

describe('posix helpers', () => {
  it('posixJoin 末尾 / 归一', () => {
    expect(posixJoin('/Users/cindy', 'Code')).toBe('/Users/cindy/Code');
    expect(posixJoin('/Users/cindy/', 'Code')).toBe('/Users/cindy/Code');
    expect(posixJoin('', 'Code')).toBe('/Code');
  });
  it('posixParent 退一段,根保留', () => {
    expect(posixParent('/Users/cindy/Code')).toBe('/Users/cindy');
    expect(posixParent('/Users')).toBe('/');
    expect(posixParent('/')).toBe('/');
  });
});

describe('sshBrowseAdapter', () => {
  it('listDir:childPath 用 posixJoin(resolvedPath,name),parent 用 posixParent', async () => {
    listRemoteDir.mockResolvedValueOnce({
      resolvedPath: '/home/me',
      entries: [
        { name: 'proj', kind: 'dir' },
        { name: 'link', kind: 'symlink' },
      ],
    });
    const res = await sshBrowseAdapter('host-1').listDir('~');
    expect(listRemoteDir).toHaveBeenCalledWith('host-1', '~');
    expect(res.resolvedPath).toBe('/home/me');
    expect(res.entries).toEqual([
      { name: 'proj', kind: 'dir', childPath: '/home/me/proj' },
      { name: 'link', kind: 'symlink', childPath: '/home/me/link' },
    ]);
    expect(res.parent).toBe('/home');
  });
  it('statPath / mkdirP 透传 hostId', async () => {
    statRemotePath.mockResolvedValueOnce({ kind: 'missing', resolvedPath: '/home/me/new' });
    mkdirPRemote.mockResolvedValueOnce({ resolvedPath: '/home/me/new' });
    await sshBrowseAdapter('host-1').statPath('~/new');
    await sshBrowseAdapter('host-1').mkdirP('~/new');
    expect(statRemotePath).toHaveBeenCalledWith('host-1', '~/new');
    expect(mkdirPRemote).toHaveBeenCalledWith('host-1', '~/new');
  });
});

describe('deviceLinkBrowseAdapter', () => {
  it('listDir:经隧道调 fs:list-dir,childPath / parent 直接用 handler 回传的 native 路径', async () => {
    // 模拟 Windows 被控端:native 路径用反斜杠,renderer 不得自行拼接。
    invoke.mockResolvedValueOnce({
      resolvedPath: 'C:\\Users\\cindy',
      entries: [{ name: 'Code', kind: 'dir', path: 'C:\\Users\\cindy\\Code' }],
      parent: 'C:\\Users',
    });
    const res = await deviceLinkBrowseAdapter('dev-A').listDir('~');
    expect(invoke).toHaveBeenCalledWith('dev-A', IPC_CHANNELS.FS.LIST_DIR, [{ path: '~' }]);
    expect(res.resolvedPath).toBe('C:\\Users\\cindy');
    expect(res.entries).toEqual([{ name: 'Code', kind: 'dir', childPath: 'C:\\Users\\cindy\\Code' }]);
    expect(res.parent).toBe('C:\\Users');
  });
  it('statPath / mkdirP 经隧道调对应 channel,参数包成 [{path}]', async () => {
    invoke.mockResolvedValueOnce({ kind: 'dir', resolvedPath: '/x' });
    invoke.mockResolvedValueOnce({ resolvedPath: '/x' });
    await deviceLinkBrowseAdapter('dev-A').statPath('~/x');
    await deviceLinkBrowseAdapter('dev-A').mkdirP('~/x');
    expect(invoke).toHaveBeenNthCalledWith(1, 'dev-A', IPC_CHANNELS.FS.STAT_PATH, [{ path: '~/x' }]);
    expect(invoke).toHaveBeenNthCalledWith(2, 'dev-A', IPC_CHANNELS.FS.MKDIR_P, [{ path: '~/x' }]);
  });
});
