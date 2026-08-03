import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => {
  const execFile = () => undefined;
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: execFileAsyncMock,
  });
  return { execFile };
});

import { syncSystemContactGroup } from '../system-contacts.js';

describe('syncSystemContactGroup', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    execFileAsyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('trim 名称、去重锚点，并解析幂等建组结果', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        groupName: 'Cindy 管理',
        created: true,
        requested: 2,
        added: 1,
        alreadyPresent: 1,
        missingAppleIds: [],
      }),
      stderr: '',
    });

    const result = await syncSystemContactGroup('  Cindy 管理  ', [
      'apple-1',
      'apple-1',
      ' apple-2 ',
      '',
    ]);

    expect(result).toMatchObject({
      groupName: 'Cindy 管理',
      created: true,
      requested: 2,
      added: 1,
      alreadyPresent: 1,
    });
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    const [command, argv] = execFileAsyncMock.mock.calls[0] as [string, string[]];
    expect(command).toBe('osascript');
    expect(argv.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    const script = argv[3] ?? '';
    expect(script).toContain('const groupName = "Cindy 管理";');
    expect(script).toContain('const appleIds = ["apple-1","apple-2"];');
    expect(script).toContain('const allPersonIds = new Set');
    expect(script).toContain('if (!allPersonIds.has(appleId))');
    expect(script).toContain('Contacts.add(person, { to: group })');
    expect(script).not.toContain('Contacts.delete(group)');
    expect(script).not.toContain('catch (err) {\n      missingAppleIds.push(appleId)');
  });

  it('仅 ensure 分组时在扫描系统联系人前直接返回', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        groupName: 'Cindy 管理',
        created: false,
        requested: 0,
        added: 0,
        alreadyPresent: 0,
        missingAppleIds: [],
      }),
      stderr: '',
    });

    await expect(syncSystemContactGroup('Cindy 管理', [])).resolves.toMatchObject({
      requested: 0,
      added: 0,
    });
    const script = (execFileAsyncMock.mock.calls[0]?.[1] as string[])[3] ?? '';
    expect(script.indexOf('if (appleIds.length === 0)')).toBeGreaterThan(-1);
    expect(script.indexOf('if (appleIds.length === 0)')).toBeLessThan(
      script.indexOf('group.people.id()'),
    );
  });

  it('空名称和超过单批上限在启动 osascript 前拒绝', async () => {
    await expect(syncSystemContactGroup('   ', [])).rejects.toThrow('[INVALID_PARAMS]');
    await expect(
      syncSystemContactGroup(
        'Cindy',
        Array.from({ length: 201 }, (_, index) => `apple-${index}`),
      ),
    ).rejects.toThrow('[INVALID_PARAMS]');
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('把 macOS 自动化授权拒绝映射为统一错误码', async () => {
    execFileAsyncMock.mockRejectedValue(new Error('execution error: Not authorized. (-1743)'));

    await expect(syncSystemContactGroup('Cindy', [])).rejects.toThrow('[PERMISSION_DENIED]');
  });

  it('分组写入执行错误不会伪装成 missing 成功', async () => {
    execFileAsyncMock.mockRejectedValue(
      new Error('execution error: Contacts.add failed because the group is not writable'),
    );

    await expect(syncSystemContactGroup('Cindy', ['apple-1'])).rejects.toThrow('[INTERNAL]');
  });

  it('非 macOS 平台 fail closed', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    await expect(syncSystemContactGroup('Cindy', [])).rejects.toThrow('[UNSUPPORTED_CAPABILITY]');
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });
});
