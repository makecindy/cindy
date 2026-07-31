import { IPC_CHANNELS } from '@cindy/cindy-ipc';
/**
 * remoteBrowseAdapters —— 「添加远程项目」弹窗的统一目录浏览适配器。
 *
 * 把两类远端的目录浏览收口成同一接口,让弹窗 UI 与「数据从哪来」解耦:
 *   - SSH 远程主机:走 `remoteSsh.listRemoteDir / statRemotePath / mkdirPRemote`(POSIX
 *     远端,childPath / parent 用 posixJoin / posixParent 在 renderer 侧拼)。
 *   - device-link 同账号被控设备:走隧道 `deviceLink.invoke(deviceId, 'fs:list-dir'|..., [{path}])`
 *     在**被控端**执行;被控端可能是 Windows,故 childPath / parent **直接用 handler 回传的
 *     host-native 绝对路径**,renderer 不做任何路径拼接(天然跨平台)。
 *
 * 弹窗只认下面的 `RemoteBrowseAdapter`,导航一律用 entry.childPath / ListResult.parent,
 * 两类来源的路径差异完全封装在适配器里。
 */

/** 把 ls 返回的 resolvedPath + child name 拼成下一级 posix 路径(SSH 专用,末尾 / 归一)。 */
export function posixJoin(base: string, child: string): string {
  const b = base.replace(/\/+$/, '');
  return b === '' ? `/${child}` : `${b}/${child}`;
}

/** posix 上级目录(basename 去掉,根 / 保留;~ 等无法机械上跳的留原值)。 */
export function posixParent(p: string): string {
  if (p === '/' || p === '~' || p === '~/') return p;
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

export interface BrowseEntry {
  name: string;
  kind: 'dir' | 'symlink';
  /** 进入 / 选中该项要用的绝对路径(SSH=posixJoin 拼;device-link=被控端回传的 native 路径)。 */
  childPath: string;
}

export interface BrowseListResult {
  resolvedPath: string;
  entries: BrowseEntry[];
  /** 上级目录;已在根则 null(弹窗据此 disable「返回上级」)。 */
  parent: string | null;
}

export interface RemoteBrowseAdapter {
  listDir(path: string): Promise<BrowseListResult>;
  statPath(path: string): Promise<{ kind: 'dir' | 'file' | 'missing'; resolvedPath: string }>;
  mkdirP(path: string): Promise<{ resolvedPath: string }>;
}

/** SSH 远程主机适配器。SSH 远端永远是 Linux/Mac → POSIX 拼接。 */
export function sshBrowseAdapter(hostId: string): RemoteBrowseAdapter {
  return {
    async listDir(path) {
      const res = await window.electronAPI.remoteSsh.listRemoteDir(hostId, path);
      return {
        resolvedPath: res.resolvedPath,
        entries: res.entries.map((e) => ({
          name: e.name,
          kind: e.kind,
          childPath: posixJoin(res.resolvedPath, e.name),
        })),
        // SSH handler 不回 parent;POSIX 上级在前端算(SSH 永远 POSIX,安全)。
        parent: posixParent(res.resolvedPath),
      };
    },
    statPath: (path) => window.electronAPI.remoteSsh.statRemotePath(hostId, path),
    mkdirP: (path) => window.electronAPI.remoteSsh.mkdirPRemote(hostId, path),
  };
}

/** device-link 被控设备适配器。childPath / parent 直接用被控端 handler 回传的 native 路径。 */
export function deviceLinkBrowseAdapter(deviceId: string): RemoteBrowseAdapter {
  const invoke = <T>(channel: string, path: string): Promise<T> =>
    window.electronAPI.deviceLink.invoke(deviceId, channel, [{ path }]) as Promise<T>;
  return {
    async listDir(path) {
      const res = await invoke<{
        resolvedPath: string;
        entries: { name: string; kind: 'dir' | 'symlink'; path: string }[];
        parent: string | null;
      }>(IPC_CHANNELS.FS.LIST_DIR, path);
      return {
        resolvedPath: res.resolvedPath,
        entries: res.entries.map((e) => ({ name: e.name, kind: e.kind, childPath: e.path })),
        parent: res.parent,
      };
    },
    statPath: (path) =>
      invoke<{ kind: 'dir' | 'file' | 'missing'; resolvedPath: string }>(IPC_CHANNELS.FS.STAT_PATH, path),
    mkdirP: (path) => invoke<{ resolvedPath: string }>(IPC_CHANNELS.FS.MKDIR_P, path),
  };
}
