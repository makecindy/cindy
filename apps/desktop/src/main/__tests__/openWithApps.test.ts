import { describe, expect, it, vi } from 'vitest';

import {
  createOpenWithHandlers,
  decodeRegOutput,
  expandWindowsEnv,
  parseChcpCodepage,
  parseCommandLineExe,
  parseRegSubkeys,
  parseRegValues,
  type OpenWithDeps,
} from '../openWithApps';

describe('parseCommandLineExe', () => {
  it('extracts quoted and unquoted executable paths', () => {
    expect(parseCommandLineExe('"C:\\Program Files\\App\\app.exe" "%1"')).toBe(
      'C:\\Program Files\\App\\app.exe',
    );
    expect(parseCommandLineExe('C:\\Tools\\a.exe %1')).toBe('C:\\Tools\\a.exe');
    // 无引号但路径含空格的老注册表项:按 .exe 边界截。
    expect(parseCommandLineExe('C:\\Program Files\\App\\app.exe /open %1')).toBe(
      'C:\\Program Files\\App\\app.exe',
    );
    expect(parseCommandLineExe('')).toBeNull();
    expect(parseCommandLineExe('"unterminated')).toBeNull();
  });
});

describe('expandWindowsEnv', () => {
  it('expands %VAR% references and keeps unknown ones verbatim', () => {
    expect(expandWindowsEnv('%SystemRoot%\\notepad.exe', { SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\notepad.exe',
    );
    expect(expandWindowsEnv('%NOPE%\\a.exe', {})).toBe('%NOPE%\\a.exe');
  });
});

describe('reg.exe output parsing', () => {
  it('parses value rows with names, types and data', () => {
    const stdout = [
      'HKEY_CURRENT_USER\\...\\OpenWithList',
      '    a    REG_SZ    EXCEL.EXE',
      '    b    REG_SZ    notepad.exe',
      '    MRUList    REG_SZ    ab',
      '',
    ].join('\r\n');
    expect(parseRegValues(stdout)).toEqual([
      { name: 'a', data: 'EXCEL.EXE' },
      { name: 'b', data: 'notepad.exe' },
      { name: 'MRUList', data: 'ab' },
    ]);
  });

  it('parses empty-data rows (OpenWithProgids REG_NONE values)', () => {
    const stdout = ['HKEY_CLASSES_ROOT\\.xlsx\\OpenWithProgids', '    Excel.Sheet.12    REG_NONE    ', ''].join(
      '\r\n',
    );
    expect(parseRegValues(stdout)).toEqual([{ name: 'Excel.Sheet.12', data: '' }]);
  });

  it('parses subkey listings relative to the parent key', () => {
    const parent = 'HKCR\\.xlsx\\OpenWithList';
    const stdout = [
      'HKCR\\.xlsx\\OpenWithList\\EXCEL.EXE',
      'HKCR\\.xlsx\\OpenWithList\\wps.exe',
      '',
    ].join('\r\n');
    expect(parseRegSubkeys(stdout, parent)).toEqual(['EXCEL.EXE', 'wps.exe']);
  });
});

describe('reg.exe output decoding', () => {
  it('decodes GBK bytes with codepage 936 (中文系统 reg.exe 实际输出)', () => {
    // 「工作表」的 GBK 编码字节;按 UTF-8 解会全变 U+FFFD。
    const gbk = new Uint8Array([0xb9, 0xa4, 0xd7, 0xf7, 0xb1, 0xed]);
    expect(decodeRegOutput(gbk, 936)).toBe('工作表');
    expect(decodeRegOutput(gbk, null)).toContain('�');
  });

  it('falls back to UTF-8 for unknown or unmapped codepages', () => {
    const utf8 = new TextEncoder().encode('Notepad');
    expect(decodeRegOutput(utf8, null)).toBe('Notepad');
    expect(decodeRegOutput(utf8, 850)).toBe('Notepad');
    expect(decodeRegOutput(new TextEncoder().encode('メモ帳'), 65001)).toBe('メモ帳');
  });

  it('parses chcp output across locales', () => {
    expect(parseChcpCodepage('活动代码页: 936\r\n')).toBe(936);
    expect(parseChcpCodepage('Active code page: 437\r\n')).toBe(437);
    expect(parseChcpCodepage('')).toBeNull();
  });
});

/** 以「.xlsx 有 MRU + ProgId 两个来源」为形状的假注册表。 */
function makeDeps(overrides: Partial<OpenWithDeps> = {}): OpenWithDeps & {
  spawnDetached: ReturnType<typeof vi.fn>;
} {
  const registry: Record<string, string> = {
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.xlsx\\OpenWithList':
      '    a    REG_SZ    EXCEL.EXE\r\n    MRUList    REG_SZ    a\r\n',
    'HKCR\\Applications\\EXCEL.EXE\\shell\\open\\command':
      '    (Default)    REG_SZ    "C:\\Office\\EXCEL.EXE" "%1"\r\n',
    'HKCR\\Applications\\EXCEL.EXE': '    FriendlyAppName    REG_SZ    Microsoft Excel\r\n',
    'HKCR\\.xlsx\\OpenWithProgids': '    Wps.Sheet    REG_NONE    \r\n',
    'HKCR\\Wps.Sheet\\shell\\open\\command':
      '    (Default)    REG_SZ    "C:\\WPS\\wps.exe" "%1"\r\n',
    'HKCR\\Wps.Sheet': '    (Default)    REG_SZ    WPS 表格\r\n',
  };
  const spawnDetached = vi.fn();
  const base: OpenWithDeps = {
    platform: 'win32',
    isPathAllowed: () => true,
    fileExists: () => true,
    regQuery: async (keyPath: string) => registry[keyPath] ?? '',
    getAppIcon: async () => null,
    spawnDetached,
  };
  return { ...base, ...overrides, spawnDetached };
}

const FILE = 'C:\\work\\报表.xlsx';

describe('createOpenWithHandlers.list', () => {
  it('enumerates registry apps, resolves labels and dedupes by exe path', async () => {
    const handlers = createOpenWithHandlers(makeDeps());
    const res = await handlers.list({ filePath: FILE });
    expect(res.success).toBe(true);
    expect(res.apps.map((a) => a.label)).toEqual(['Microsoft Excel', 'WPS 表格']);
  });

  it('skips entries whose executable no longer exists', async () => {
    const deps = makeDeps({ fileExists: (p: string) => p !== 'C:\\WPS\\wps.exe' });
    const handlers = createOpenWithHandlers(deps);
    const res = await handlers.list({ filePath: FILE });
    expect(res.success).toBe(true);
    expect(res.apps.map((a) => a.label)).toEqual(['Microsoft Excel']);
  });

  it('returns an empty list on non-Windows platforms', async () => {
    const handlers = createOpenWithHandlers(makeDeps({ platform: 'darwin' }));
    const res = await handlers.list({ filePath: '/tmp/a.xlsx' });
    expect(res).toEqual({ success: true, apps: [] });
  });

  it('fails soft when the target path is rejected', async () => {
    const handlers = createOpenWithHandlers(makeDeps({ isPathAllowed: () => false }));
    const res = await handlers.list({ filePath: FILE });
    expect(res.success).toBe(false);
    expect(res.apps).toEqual([]);
  });
});

describe('createOpenWithHandlers.open', () => {
  it('opens via the main-side appId mapping only', async () => {
    const deps = makeDeps();
    const handlers = createOpenWithHandlers(deps);
    const res = await handlers.list({ filePath: FILE });
    const excel = res.apps.find((a) => a.label === 'Microsoft Excel');
    expect(excel).toBeDefined();
    await handlers.open({ filePath: FILE, appId: excel!.id });
    expect(deps.spawnDetached).toHaveBeenCalledWith('C:\\Office\\EXCEL.EXE', [FILE]);
  });

  it('rejects appIds that never came from an enumeration', async () => {
    const deps = makeDeps();
    const handlers = createOpenWithHandlers(deps);
    // 未 list 先 open:映射为空,任何 appId(包括看似路径的字符串)都拒绝。
    await expect(
      handlers.open({ filePath: FILE, appId: 'C:\\evil\\payload.exe' }),
    ).rejects.toThrow(/NOT_FOUND/);
    expect(deps.spawnDetached).not.toHaveBeenCalled();
  });

  it('validates the file path before spawning', async () => {
    const deps = makeDeps();
    const handlers = createOpenWithHandlers(deps);
    await expect(handlers.open({ filePath: 'relative.xlsx', appId: 'x' })).rejects.toThrow(
      /INVALID_PARAMS/,
    );
  });
});

describe('createOpenWithHandlers surface', () => {
  it('exposes only list/open — no system OpenAs dialog escape hatch', () => {
    // 「选择其他应用…」已下线(系统 OpenAs 对话框实测起不来,且与 Codex 形态
    // 不符),对应的 choose handler 与 showOpenAppDialog 依赖一并移除。
    const handlers = createOpenWithHandlers(makeDeps());
    expect(Object.keys(handlers).sort()).toEqual(['list', 'open']);
  });
});
