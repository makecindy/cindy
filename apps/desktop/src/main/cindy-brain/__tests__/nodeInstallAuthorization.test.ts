/** nodeInstallAuthorization.test — Node 真授权必须由 Main 原生系统弹窗取得。 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  showMessageBox: vi.fn(),
  getPreferredSystemLanguages: vi.fn(() => ['en-US']),
  getLocale: vi.fn(() => 'en-US'),
}));

vi.mock('electron', () => ({
  app: {
    getPreferredSystemLanguages: electronMocks.getPreferredSystemLanguages,
    getLocale: electronMocks.getLocale,
  },
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  dialog: { showMessageBox: electronMocks.showMessageBox },
}));

import type { GhostManifest } from '../../../shared/ghost';
import {
  buildNodeInstallDialogOptions,
  requestNodeInstallAuthorization,
} from '../nodeInstallAuthorization';

const nodeManifest = {
  schemaVersion: 2,
  id: 'node-ghost',
  name: 'Node Ghost',
  version: '1.0.0',
  kind: 'chip',
  entry: 'main.js',
  slots: ['node'],
  node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' },
} as GhostManifest;

beforeEach(() => {
  vi.clearAllMocks();
  electronMocks.fromWebContents.mockReturnValue({ isDestroyed: () => false });
  electronMocks.showMessageBox.mockResolvedValue({ response: 0 });
});

describe('nodeInstallAuthorization', () => {
  it('原生弹窗用中性层级说明本机权限，并默认选择 Cancel', () => {
    const options = buildNodeInstallDialogOptions(nodeManifest, 'install');
    expect(options.type).toBe('none');
    expect(options.detail).toContain('Node Ghost · v1.0.0');
    expect(options.detail).toContain('access files and the network');
    expect(options.buttons).toEqual(['Continue', 'Cancel']);
    expect(options.defaultId).toBe(1);
    expect(options.cancelId).toBe(1);
    expect(options.noLink).toBe(true);
  });

  it('用户点继续才授权；点取消返回 false', async () => {
    const sender = {} as never;
    await expect(requestNodeInstallAuthorization(sender, nodeManifest, 'install')).resolves.toBe(
      true,
    );
    electronMocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(requestNodeInstallAuthorization(sender, nodeManifest, 'update')).resolves.toBe(
      false,
    );
    expect(electronMocks.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('普通沙箱插件不弹 Node 提示；找不到所属窗口时 Node 授权失败关闭', async () => {
    const sender = {} as never;
    const plain = { ...nodeManifest, slots: ['card'], node: undefined } as GhostManifest;
    await expect(requestNodeInstallAuthorization(sender, plain, 'install')).resolves.toBe(true);
    expect(electronMocks.showMessageBox).not.toHaveBeenCalled();

    electronMocks.fromWebContents.mockReturnValueOnce(null);
    await expect(requestNodeInstallAuthorization(sender, nodeManifest, 'install')).resolves.toBe(
      false,
    );
    expect(electronMocks.showMessageBox).not.toHaveBeenCalled();
  });
});
