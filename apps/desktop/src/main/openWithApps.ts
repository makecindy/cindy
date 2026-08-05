/**
 * openWithApps — 聊天文件 chip 右键「打开方式」的 main 侧能力。
 * ---------------------------------------------------------------------------
 * 三个动作:
 *   - list:枚举系统里能打开某扩展名的应用(Windows 注册表;macOS 无免原生
 *     依赖的枚举 API,返回空列表,菜单只剩「默认应用 / 选择其他应用…」)。
 *   - open:用枚举结果中的指定应用打开文件。
 *   - choose:唤起系统「打开方式」选择(Windows OpenAs 对话框;macOS 选 .app
 *     后 `open -a`)。
 *
 * 安全设计(electron-security §5「IPC 是授权边界」):
 *   - renderer 只能回传 **appId**,不能传可执行路径。appId → exe 的映射只存在
 *     main 侧 per-扩展名缓存里,由本模块自己的枚举写入;open 时反查不到即拒绝。
 *     「renderer 递来一个绝对路径就执行」在结构上不可表达。
 *   - 待打开的文件路径每次都重新过绝对路径 + isPathAllowed + 存在性校验。
 *   - 枚举里剔除宿主进程(rundll32 等)——它们不是"应用",且可被用作参数注入
 *     的跳板。
 *
 * Windows 枚举口径(reg.exe query,零原生依赖):
 *   HKCU FileExts\<ext>\OpenWithList(MRU)∪ HKCR/HKCU <ext>\OpenWithProgids
 *   → exe 引用经 HKCR\Applications\<exe> / HKLM App Paths 解析,ProgId 经
 *   HKCR\<ProgId>\shell\open\command 解析 → 去重、验存在。UWP/MSIX 应用不在
 *   这些键下,属已知盲区,由「选择其他应用…」兜底(计划内取舍)。
 *
 * 错误协议(engineering-conventions §2):list 是查询型,失败仍要渲染菜单其余
 * 项 → `{ success, apps }` 模式;open / choose 是动作型 → throwIpcError。
 */

import path from 'node:path';

import { throwIpcError } from './utils/ipcValidate.js';

export interface OpenWithApp {
  /** 会话内一次性 id;renderer 原样回传,main 反查 exe。 */
  id: string;
  label: string;
  /** app.getFileIcon 提取的 dataURL;提取失败缺省,renderer 显示通用图标。 */
  iconDataUrl?: string;
}

export interface ListOpenWithAppsResult {
  success: boolean;
  apps: OpenWithApp[];
  error?: string;
}

export interface OpenWithDeps {
  platform: NodeJS.Platform;
  isPathAllowed(absPath: string): boolean;
  fileExists(absPath: string): boolean;
  /**
   * `reg.exe query` 包装(仅 Windows 用)。返回 stdout;键不存在等查询失败按
   * 空 stdout 处理(reg.exe 对 not-found 返回非 0,包装层不抛)。
   */
  regQuery(keyPath: string, args?: string[]): Promise<string>;
  /** 应用图标 dataURL;实现方必须自带超时防护(app.getFileIcon 会挂死,见 fileThumbnail.ts)。 */
  getAppIcon(exePath: string): Promise<string | null>;
  /** detached + unref 起进程;不回传输出。 */
  spawnDetached(command: string, args: string[]): void;
}

export interface OpenWithHandlers {
  list(params: { filePath: string }): Promise<ListOpenWithAppsResult>;
  open(params: { filePath: string; appId: string }): Promise<void>;
}

/** 单次枚举的应用数上限:图标提取按个计价,列表长尾对用户也没有意义。 */
const MAX_APPS = 12;

/** 宿主/中转进程不作为「应用」列出(也避免被当作参数注入跳板)。 */
const HOST_EXE_DENYLIST = new Set([
  'rundll32.exe',
  'dllhost.exe',
  'openwith.exe',
  'explorer.exe',
  'cmd.exe',
  'powershell.exe',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
]);

/** REG_EXPAND_SZ 的 `%SystemRoot%` 等环境变量引用展开;未定义的原样保留。 */
export function expandWindowsEnv(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/%([^%]+)%/g, (raw, name: string) => env[name] ?? env[name.toUpperCase()] ?? raw);
}

/** `"C:\x\a.exe" %1` / `C:\x\a.exe %1` → exe 路径;解析不出回 null。 */
export function parseCommandLineExe(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 1 ? trimmed.slice(1, end) : null;
  }
  // 无引号形态:exe 路径可能含空格(老注册表项),按 `.exe` 边界截。
  const m = trimmed.match(/^(.*?\.exe)(?=\s|$)/i);
  return m ? m[1] : trimmed.split(/\s+/)[0] ?? null;
}

/**
 * Windows 控制台代码页 → WHATWG TextDecoder label。reg.exe 重定向输出用的是
 * 控制台代码页(中文系统 936/GBK)而非 UTF-8,直接按 UTF-8 解码会把中文应用名
 * 变成 U+FFFD。只映射 TextDecoder 支持的常见页;OEM 437/850 等西文页不在
 * TextDecoder 支持面内,回落 UTF-8(ASCII 部分不受影响)。
 */
const CODEPAGE_DECODER_LABELS: Record<number, string> = {
  932: 'shift_jis',
  936: 'gb18030',
  949: 'euc-kr',
  950: 'big5',
  866: 'ibm866',
  874: 'windows-874',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  65001: 'utf-8',
};

/** `chcp` 输出(如 `活动代码页: 936` / `Active code page: 437`)→ 代码页号。 */
export function parseChcpCodepage(stdout: string): number | null {
  const digits = stdout.match(/\d+/g)?.pop();
  return digits ? Number(digits) : null;
}

/** reg.exe 原始 stdout 字节 → 字符串;代码页未知或不支持时回落 UTF-8。 */
export function decodeRegOutput(data: Uint8Array, codepage: number | null): string {
  const label = (codepage != null && CODEPAGE_DECODER_LABELS[codepage]) || 'utf-8';
  try {
    return new TextDecoder(label).decode(data);
  } catch {
    return new TextDecoder('utf-8').decode(data);
  }
}

/** reg.exe query 输出 → 该键下的值列表(name + REG_SZ data)。 */
export function parseRegValues(stdout: string): Array<{ name: string; data: string }> {
  const out: Array<{ name: string; data: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    // 形如 `    a    REG_SZ    Excel.exe`(data 可含空格)。
    const m = line.match(/^\s{2,}(\S(?:.*?\S)?)\s+(REG_[A-Z_]+)\s+(.*)$/);
    if (m) out.push({ name: m[1], data: m[3].trim() });
  }
  return out;
}

/** reg.exe query 输出 → 子键名列表(完整行是键路径,取末段)。 */
export function parseRegSubkeys(stdout: string, parentKey: string): string[] {
  const prefix = parentKey.replace(/\\+$/, '').toLowerCase() + '\\';
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (t.toLowerCase().startsWith(prefix)) out.push(t.slice(prefix.length));
  }
  return out;
}

interface ResolvedApp {
  exePath: string;
  label: string;
}

function dedupeKey(exePath: string): string {
  return exePath.toLowerCase();
}

export function createOpenWithHandlers(deps: OpenWithDeps): OpenWithHandlers {
  // 该模块是可注入 platform 的纯函数,单测会在 Linux runner 模拟 win32。
  // 路径语义必须跟 deps.platform 走,不能跟测试宿主的 process.platform 走。
  const platformPath = deps.platform === 'win32' ? path.win32 : path.posix;
  // ext → (appId → exePath)。每次 list 整体重建该 ext 的映射;open 只认最近
  // 一次枚举写入的 id。进程内存态即可——菜单打开到点击是同进程短会话。
  const appCacheByExt = new Map<string, Map<string, string>>();

  function assertOpenableFile(filePath: string): void {
    if (typeof filePath !== 'string' || !platformPath.isAbsolute(filePath)) {
      throwIpcError('INVALID_PARAMS', 'filePath must be absolute');
    }
    if (!deps.isPathAllowed(filePath)) {
      throwIpcError('PERMISSION_DENIED', '不允许访问该路径');
    }
    if (!deps.fileExists(filePath)) {
      throwIpcError('NOT_FOUND', '文件不存在');
    }
  }

  /** exe 名引用(`Excel.exe`)→ 完整路径 + 友好名。 */
  async function resolveExeReference(exeName: string): Promise<ResolvedApp | null> {
    const appKey = `HKCR\\Applications\\${exeName}`;
    const cmdOut = await deps.regQuery(`${appKey}\\shell\\open\\command`, ['/ve']);
    let exePath = parseCommandLineExe(parseRegValues(cmdOut)[0]?.data ?? '');
    if (!exePath) {
      const appPathsOut = await deps.regQuery(
        `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
        ['/ve'],
      );
      exePath = parseRegValues(appPathsOut)[0]?.data?.trim() || null;
    }
    if (exePath) exePath = expandWindowsEnv(exePath, process.env);
    if (!exePath || !deps.fileExists(exePath)) return null;

    const friendlyOut = await deps.regQuery(appKey, ['/v', 'FriendlyAppName']);
    const friendly = parseRegValues(friendlyOut)[0]?.data;
    // `@resource.dll,-123` 形态的本地化引用没有免原生的解法,回落 exe 名。
    const label =
      friendly && !friendly.startsWith('@') ? friendly : platformPath.basename(exePath, platformPath.extname(exePath));
    return { exePath, label };
  }

  /** ProgId 引用 → 完整路径 + 友好名。 */
  async function resolveProgIdReference(progId: string): Promise<ResolvedApp | null> {
    const cmdOut = await deps.regQuery(`HKCR\\${progId}\\shell\\open\\command`, ['/ve']);
    const parsed = parseCommandLineExe(parseRegValues(cmdOut)[0]?.data ?? '');
    const exePath = parsed ? expandWindowsEnv(parsed, process.env) : null;
    if (!exePath || !deps.fileExists(exePath)) return null;

    const nameOut = await deps.regQuery(`HKCR\\${progId}`, ['/ve']);
    const friendly = parseRegValues(nameOut)[0]?.data;
    const label =
      friendly && !friendly.startsWith('@') ? friendly : platformPath.basename(exePath, platformPath.extname(exePath));
    return { exePath, label };
  }

  async function listWindowsApps(ext: string): Promise<ResolvedApp[]> {
    const fileExtsKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}`;

    const exeNames = new Set<string>();
    const progIds = new Set<string>();

    const mruOut = await deps.regQuery(`${fileExtsKey}\\OpenWithList`);
    for (const v of parseRegValues(mruOut)) {
      if (v.name.toLowerCase() !== 'mrulist' && /\.exe$/i.test(v.data)) exeNames.add(v.data);
    }
    const hkcrListKey = `HKCR\\${ext}\\OpenWithList`;
    for (const sub of parseRegSubkeys(await deps.regQuery(hkcrListKey), hkcrListKey)) {
      if (/\.exe$/i.test(sub)) exeNames.add(sub);
    }
    for (const src of [`${fileExtsKey}\\OpenWithProgids`, `HKCR\\${ext}\\OpenWithProgids`]) {
      for (const v of parseRegValues(await deps.regQuery(src))) {
        if (v.name && v.name !== '(Default)') progIds.add(v.name);
      }
    }
    // 扩展名默认 ProgId 也入列(它对应的应用不一定出现在 OpenWith* 里)。
    const defaultProgId = parseRegValues(await deps.regQuery(`HKCR\\${ext}`, ['/ve']))[0]?.data;
    if (defaultProgId) progIds.add(defaultProgId);

    const seen = new Set<string>();
    const apps: ResolvedApp[] = [];
    const push = (r: ResolvedApp | null): void => {
      if (!r) return;
      if (HOST_EXE_DENYLIST.has(platformPath.basename(r.exePath).toLowerCase())) return;
      const key = dedupeKey(r.exePath);
      if (seen.has(key)) return;
      seen.add(key);
      apps.push(r);
    };
    for (const exe of exeNames) {
      if (apps.length >= MAX_APPS) break;
      push(await resolveExeReference(exe));
    }
    for (const progId of progIds) {
      if (apps.length >= MAX_APPS) break;
      push(await resolveProgIdReference(progId));
    }
    return apps;
  }

  return {
    async list({ filePath }) {
      try {
        assertOpenableFile(filePath);
      } catch (err) {
        return { success: false, apps: [], error: err instanceof Error ? err.message : String(err) };
      }
      if (deps.platform !== 'win32') {
        // macOS/Linux:无免原生依赖的枚举 API,空列表 = 菜单只显示
        // 「默认应用 / 选择其他应用…」两个平台无关项。
        return { success: true, apps: [] };
      }
      const ext = platformPath.extname(filePath).toLowerCase();
      if (!ext) return { success: true, apps: [] };
      try {
        const resolved = await listWindowsApps(ext);
        const idMap = new Map<string, string>();
        // 图标提取彼此独立且每个自带 4s 超时:串行会把子菜单懒加载放大到
        // MAX_APPS * 4s(最坏 48s)。并行(至多 MAX_APPS=12 并发)取,顺序仍按
        // resolved 保持稳定(PR #1835 review)。
        const apps: OpenWithApp[] = await Promise.all(
          resolved.map(async (r, i) => {
            const id = `owa-${i}-${platformPath.basename(r.exePath).toLowerCase()}`;
            idMap.set(id, r.exePath);
            const iconDataUrl = (await deps.getAppIcon(r.exePath)) ?? undefined;
            return { id, label: r.label, ...(iconDataUrl ? { iconDataUrl } : {}) };
          }),
        );
        appCacheByExt.set(ext, idMap);
        return { success: true, apps };
      } catch (err) {
        return { success: false, apps: [], error: err instanceof Error ? err.message : String(err) };
      }
    },

    async open({ filePath, appId }) {
      assertOpenableFile(filePath);
      if (typeof appId !== 'string' || !appId) throwIpcError('INVALID_PARAMS', 'appId required');
      const ext = platformPath.extname(filePath).toLowerCase();
      // 只认 main 侧最近一次枚举写入的映射——查不到一律拒绝,绝不把 renderer
      // 提供的任何字符串当路径执行。
      const exePath = appCacheByExt.get(ext)?.get(appId);
      if (!exePath) throwIpcError('NOT_FOUND', '应用引用已失效,请重新打开菜单');
      if (!deps.fileExists(exePath)) throwIpcError('NOT_FOUND', '应用不存在');
      deps.spawnDetached(exePath, [filePath]);
    },
  };
}
