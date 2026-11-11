/**
 * shellResolver 单测 —— mock process.platform / env / fs.existsSync 覆盖：
 *   1. macOS：$SHELL 有效 / $SHELL 缺失走 /bin/zsh / 全部缺只剩 /bin/sh
 *   2. Linux：$SHELL = /bin/bash 命中
 *   3. Windows：pwsh > powershell > COMSPEC > cmd.exe 优先级
 *   4. resolveShellById：当前平台不可用回 null（卸了 pwsh、Windows 上选 zsh 等）
 *   5. resolveShellForCreate：pref 不可用回退 auto
 *   6. probeAvailableShells：进程级 memo 命中
 *   7. Git Bash：从 Program Files\Git\bin\bash.exe 探测
 *
 * 没有用真 fs / 真 PATH，全部依赖 vi.mock，避免开发机本地装了什么 shell 干扰结果。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

// Mock fs 必须在 shellResolver 被加载之前；用 vi.hoisted 拿一个共享的 fixture handle。
const fixture = vi.hoisted(() => ({
  existing: new Set<string>(),
  files: new Set<string>(),
  statErrors: new Map<string, string>(),
  links: new Map<string, string>(),
}));

vi.mock('node:fs', () => {
  return {
    existsSync: (p: string) => fixture.existing.has(p),
    statSync: (p: string) => {
      const code = fixture.statErrors.get(p);
      if (code) throw Object.assign(new Error(code), { code });
      if (fixture.files.has(p)) return { isFile: () => true } as { isFile: () => boolean };
      return { isFile: () => false } as { isFile: () => boolean };
    },
    lstatSync: (p: string) => ({ isSymbolicLink: () => fixture.links.has(p) }),
    readlinkSync: (p: string) => {
      const target = fixture.links.get(p);
      if (!target) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      return target;
    },
  };
});

// 导入必须在 vi.mock 之后。
import {
  __resetShellProbeCacheForTesting,
  probeAvailableShells,
  resolveAutoDetectShell,
  resolveShellById,
  resolveShellForCreate,
} from '../shellResolver';

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function setExistingFiles(paths: string[]): void {
  fixture.existing.clear();
  fixture.files.clear();
  for (const p of paths) {
    fixture.existing.add(p);
    fixture.files.add(p);
  }
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  __resetShellProbeCacheForTesting();
  // 清干净，每个 case 自己组装需要的 env
  for (const k of Object.keys(process.env)) delete process.env[k];
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
  setExistingFiles([]);
  fixture.statErrors.clear();
  fixture.links.clear();
});

describe('resolveAutoDetectShell — macOS', () => {
  beforeEach(() => setPlatform('darwin'));

  it('$SHELL = /bin/zsh 时 auto 命中 zsh', () => {
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh', '/bin/bash', '/bin/sh']);
    expect(resolveAutoDetectShell()).toEqual({
      id: 'zsh',
      command: '/bin/zsh',
      args: [],
      displayName: 'zsh',
    });
  });

  it('$SHELL 缺失但 /bin/zsh 存在 → fallback 到 /bin/zsh', () => {
    setExistingFiles(['/bin/zsh', '/bin/bash', '/bin/sh']);
    expect(resolveAutoDetectShell()).toMatchObject({ id: 'zsh', command: '/bin/zsh' });
  });

  it('$SHELL 指向不存在的二进制 → fallback 链', () => {
    process.env.SHELL = '/opt/homebrew/bin/zsh'; // 用户改过但二进制被删了
    setExistingFiles(['/bin/bash', '/bin/sh']); // 只剩 bash 和 sh
    expect(resolveAutoDetectShell()).toMatchObject({ id: 'bash', command: '/bin/bash' });
  });

  it('全都没有只剩 /bin/sh', () => {
    setExistingFiles(['/bin/sh']);
    expect(resolveAutoDetectShell()).toMatchObject({ id: 'sh', command: '/bin/sh' });
  });

  it('$SHELL 是 /opt/homebrew/bin/fish 且存在', () => {
    process.env.SHELL = '/opt/homebrew/bin/fish';
    setExistingFiles(['/opt/homebrew/bin/fish']);
    expect(resolveAutoDetectShell()).toMatchObject({
      id: 'fish',
      command: '/opt/homebrew/bin/fish',
      displayName: 'fish',
    });
  });
});

describe('resolveAutoDetectShell — Linux', () => {
  beforeEach(() => setPlatform('linux'));

  it('$SHELL = /bin/bash', () => {
    process.env.SHELL = '/bin/bash';
    setExistingFiles(['/bin/bash', '/bin/sh']);
    expect(resolveAutoDetectShell()).toMatchObject({ id: 'bash', command: '/bin/bash' });
  });
});

describe('resolveAutoDetectShell — Windows', () => {
  beforeEach(() => setPlatform('win32'));

  it('PATH 里有 pwsh.exe 优先', () => {
    process.env.PATH = 'C:\\Program Files\\PowerShell\\7';
    process.env.PATHEXT = '.EXE;.CMD';
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    setExistingFiles(['C:\\Program Files\\PowerShell\\7\\pwsh.exe']);
    expect(resolveAutoDetectShell()).toMatchObject({
      id: 'pwsh',
      displayName: 'PowerShell',
    });
  });

  it('没 pwsh 但有 powershell.exe', () => {
    process.env.PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
    process.env.PATHEXT = '.EXE';
    setExistingFiles(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
    expect(resolveAutoDetectShell()).toMatchObject({
      id: 'powershell',
      displayName: 'Windows PowerShell',
    });
  });

  it('两者都没 fallback COMSPEC', () => {
    process.env.PATH = 'C:\\Windows';
    process.env.PATHEXT = '.EXE';
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    setExistingFiles([]); // 啥都不在
    expect(resolveAutoDetectShell()).toMatchObject({
      id: 'cmd',
      command: 'C:\\Windows\\System32\\cmd.exe',
    });
  });

  it('COMSPEC 也没 → 兜底裸 cmd.exe', () => {
    process.env.PATH = '';
    setExistingFiles([]);
    expect(resolveAutoDetectShell()).toMatchObject({ id: 'cmd', command: 'cmd.exe' });
  });
});

// #9902: unit coverage through the settings probe and terminal creation entry points.
// The old fs fixture only represented ordinary files. AppExecLink aliases can fail
// exists/stat while lstat/readlink and the executable target remain accessible.
describe('Windows Store PowerShell execution aliases', () => {
  const localAppData = path.win32.join('C:\\Users', 'test', 'AppData', 'Local');
  const windowsApps = path.win32.join(localAppData, 'Microsoft', 'WindowsApps');
  const target = path.win32.join(
    'C:\\Program Files',
    'WindowsApps',
    'Microsoft.PowerShell_7.6.7.0_x64__8wekyb3d8bbwe',
    'pwsh.exe',
  );
  const msi = path.win32.join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');

  beforeEach(() => {
    setPlatform('win32');
    process.env.LOCALAPPDATA = localAppData;
    process.env.PATH = windowsApps;
    process.env.COMSPEC = path.win32.join('C:\\Windows', 'System32', 'cmd.exe');
  });

  it.each([
    { directory: windowsApps, code: 'EACCES', exists: false },
    {
      directory: path.win32.join(windowsApps, 'Microsoft.PowerShell_8wekyb3d8bbwe'),
      code: 'EPERM',
      exists: true,
    },
  ])(
    'lists a valid alias for explicit selection when stat fails with $code (exists=$exists)',
    ({ directory, code, exists }) => {
      const alias = path.win32.join(directory, 'pwsh.exe');
      process.env.PATH = directory;
      setExistingFiles([target]);
      if (exists) fixture.existing.add(alias);
      fixture.statErrors.set(alias, code);
      fixture.links.set(alias, target);

      expect(probeAvailableShells()).toContainEqual({
        id: 'pwsh',
        command: alias,
        displayName: 'PowerShell',
        isAutoDetectTarget: false,
      });
      expect(resolveShellById('pwsh')).toMatchObject({ id: 'pwsh', command: alias });
      expect(resolveShellForCreate('pwsh')).toMatchObject({ id: 'pwsh', command: alias });
      expect(resolveShellForCreate('auto')).toMatchObject({
        id: 'cmd',
        command: process.env.COMSPEC,
      });
    },
  );

  it('keeps Windows PowerShell as the auto target when Store PowerShell is available', () => {
    const alias = path.win32.join(windowsApps, 'pwsh.exe');
    const powershell = path.win32.join(
      'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    process.env.PATH = `${windowsApps};${path.win32.dirname(powershell)}`;
    setExistingFiles([target, powershell]);
    fixture.statErrors.set(alias, 'EACCES');
    fixture.links.set(alias, target);

    expect(probeAvailableShells().find((shell) => shell.isAutoDetectTarget)?.id).toBe('powershell');
    expect(resolveShellForCreate('pwsh').command).toBe(alias);
    expect(resolveShellForCreate('auto')).toMatchObject({ id: 'powershell', command: powershell });
  });

  it.each([
    'missing alias',
    'missing target',
    'directory target',
    'denied target',
    'ordinary denied file',
    'outside WindowsApps',
  ])('rejects %s and keeps the terminal fallback', (scenario) => {
    const directory = scenario === 'outside WindowsApps' ? localAppData : windowsApps;
    const alias = path.win32.join(directory, 'pwsh.exe');
    process.env.PATH = directory;
    setExistingFiles([target]);
    fixture.statErrors.set(alias, scenario === 'missing alias' ? 'ENOENT' : 'EACCES');
    if (scenario !== 'missing alias' && scenario !== 'ordinary denied file')
      fixture.links.set(alias, target);
    if (scenario === 'missing target') {
      fixture.files.delete(target);
      fixture.statErrors.set(target, 'ENOENT');
    }
    if (scenario === 'directory target') fixture.files.delete(target);
    if (scenario === 'denied target') fixture.statErrors.set(target, 'EACCES');

    expect(probeAvailableShells().map((shell) => shell.id)).toEqual(['cmd']);
    expect(resolveShellById('pwsh')).toBeNull();
    expect(resolveShellForCreate('pwsh')).toMatchObject({
      id: 'cmd',
      command: process.env.COMSPEC,
    });
  });

  it('prefers an ordinary MSI executable over an alias regardless of PATH order', () => {
    const alias = path.win32.join(windowsApps, 'pwsh.exe');
    setExistingFiles([msi, target]);
    fixture.statErrors.set(alias, 'EACCES');
    fixture.links.set(alias, target);
    process.env.PATH = `${path.win32.dirname(msi)};${windowsApps}`;
    expect(resolveShellForCreate('pwsh').command).toBe(msi);

    process.env.PATH = `${windowsApps};${path.win32.dirname(msi)}`;
    expect(resolveShellForCreate('pwsh').command).toBe(msi);
    expect(probeAvailableShells().find((shell) => shell.id === 'pwsh')?.command).toBe(msi);
    expect(resolveShellForCreate('auto').command).toBe(msi);
    fixture.statErrors.set(target, 'ENOENT');
    expect(resolveShellForCreate('pwsh').command).toBe(msi);
  });

  it('uses the first valid alias in PATH when no ordinary executable is available', () => {
    const alias = path.win32.join(windowsApps, 'pwsh.exe');
    const packageDir = path.win32.join(windowsApps, 'Microsoft.PowerShell_8wekyb3d8bbwe');
    const packageAlias = path.win32.join(packageDir, 'pwsh.exe');
    process.env.PATH = `${windowsApps};${packageDir}`;
    setExistingFiles([target]);
    fixture.statErrors.set(alias, 'EACCES');
    fixture.statErrors.set(packageAlias, 'EACCES');
    fixture.links.set(alias, target);
    fixture.links.set(packageAlias, target);

    expect(resolveShellForCreate('pwsh').command).toBe(alias);
    fixture.links.delete(alias);
    expect(resolveShellForCreate('pwsh').command).toBe(packageAlias);
  });
});

describe('resolveShellById', () => {
  it('macOS 选 pwsh → null（跨平台 id 不允许）', () => {
    setPlatform('darwin');
    setExistingFiles(['/bin/zsh']);
    expect(resolveShellById('pwsh')).toBeNull();
  });

  it('Windows 选 zsh → null', () => {
    setPlatform('win32');
    process.env.PATH = '';
    expect(resolveShellById('zsh')).toBeNull();
  });

  it('macOS 选 fish 但没装 → null', () => {
    setPlatform('darwin');
    process.env.PATH = '/usr/bin:/usr/local/bin';
    setExistingFiles([]);
    expect(resolveShellById('fish')).toBeNull();
  });

  it('Windows Git Bash 探测命中 Program Files\\Git\\bin\\bash.exe', () => {
    setPlatform('win32');
    process.env.PATH = '';
    process.env.PATHEXT = '.EXE';
    process.env.ProgramFiles = 'C:\\Program Files';
    setExistingFiles(['C:\\Program Files\\Git\\bin\\bash.exe']);
    expect(resolveShellById('gitbash')).toMatchObject({
      id: 'gitbash',
      command: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['--login', '-i'],
      displayName: 'Git Bash',
    });
  });
});

describe('resolveShellForCreate', () => {
  it('pref 为 auto 走 auto-detect', () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh']);
    expect(resolveShellForCreate('auto')).toMatchObject({ id: 'zsh' });
  });

  it('pref 为 null 也走 auto-detect', () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh']);
    expect(resolveShellForCreate(null)).toMatchObject({ id: 'zsh' });
  });

  it('pref 是具体 id 但当前机器没装 → 回退 auto-detect', () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh']); // 没 fish
    // 用户偏好 fish，但卸了 —— 不应该让终端开不起来
    expect(resolveShellForCreate('fish')).toMatchObject({ id: 'zsh' });
  });

  it('pref 是具体可用 id → 走它', () => {
    setPlatform('darwin');
    process.env.PATH = '/usr/bin:/bin';
    setExistingFiles(['/bin/bash']);
    expect(resolveShellForCreate('bash')).toMatchObject({ id: 'bash', command: '/bin/bash' });
  });
});

describe('probeAvailableShells', () => {
  it('macOS：列出装了的 shell + 标注 auto target', () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh', '/bin/bash', '/bin/sh']); // 没 fish
    const list = probeAvailableShells();
    expect(list.map((s) => s.id)).toEqual(['zsh', 'bash', 'sh']);
    expect(list.find((s) => s.id === 'zsh')?.isAutoDetectTarget).toBe(true);
    expect(list.find((s) => s.id === 'bash')?.isAutoDetectTarget).toBe(false);
  });

  it('memo：第二次调用不重新走 fs（改文件集合也不变结果）', () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh']);
    const first = probeAvailableShells();
    setExistingFiles(['/bin/zsh', '/bin/bash']); // 模拟用户后装了 bash
    const second = probeAvailableShells();
    expect(second).toBe(first); // 同引用
  });

  it('__resetShellProbeCacheForTesting 后重新探测', () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    setExistingFiles(['/bin/zsh']);
    probeAvailableShells();
    setExistingFiles(['/bin/zsh', '/bin/bash']);
    __resetShellProbeCacheForTesting();
    const list = probeAvailableShells();
    expect(list.map((s) => s.id)).toEqual(['zsh', 'bash']);
  });

  it('Windows：只列当前装了的子集', () => {
    setPlatform('win32');
    process.env.PATH = 'C:\\Windows\\System32';
    process.env.PATHEXT = '.EXE';
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.ProgramFiles = 'C:\\Program Files';
    setExistingFiles([
      'C:\\Windows\\System32\\powershell.exe', // 有
      'C:\\Program Files\\Git\\bin\\bash.exe', // 有
      // 没 pwsh，没 wsl
    ]);
    const list = probeAvailableShells();
    expect(list.map((s) => s.id).sort()).toEqual(['cmd', 'gitbash', 'powershell'].sort());
  });
});
