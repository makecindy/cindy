/**
 * cindy-docs/soffice.ts —— LibreOffice(soffice)可执行文件的运行时探测。
 *
 * office_to_pdf 是**增强层**:装了 LibreOffice 才有,没装就诚实报「没有」并给出
 * 安装指引。绝不静默失败,也绝不假装转换成功后交一个 0 字节文件 —— 用户拿着
 * 坏文件去开会,比当场被告知「这台机器还不支持」糟糕得多。
 *
 * 探测顺序:显式常见安装位置 → PATH。不缓存否定结果(用户可能刚装完就重试),
 * 只缓存找到的路径(可执行文件不会自己跑掉,进程生命周期内复用即可)。
 */

import { constants as fsConstants, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 各平台的常见安装位置。命中即用,免去一次 PATH 查询。 */
const WELL_KNOWN_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
  ],
  win32: [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ],
  linux: ['/usr/bin/soffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice'],
};

/** 各平台的人话安装指引。写给用户看,不是给模型看的内部提示。 */
export const SOFFICE_INSTALL_HINT: Record<string, string> = {
  darwin:
    '这台 Mac 上没找到 LibreOffice。可以用 `brew install --cask libreoffice` 安装,或从 https://www.libreoffice.org/download/ 下载安装包。装完不用重启 Cindy,直接重试即可。',
  win32:
    '这台电脑上没找到 LibreOffice。请从 https://www.libreoffice.org/download/ 下载安装(默认安装路径即可)。装完不用重启 Cindy,直接重试即可。',
  linux:
    '没找到 LibreOffice。用发行版的包管理器安装即可(如 `sudo apt install libreoffice`),或从 https://www.libreoffice.org/download/ 下载。装完直接重试即可。',
};

export function installHintForPlatform(platform: string = process.platform): string {
  return (
    SOFFICE_INSTALL_HINT[platform] ??
    '没找到 LibreOffice。请从 https://www.libreoffice.org/download/ 安装后重试。'
  );
}

let cachedPath: string | null = null;

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 走 PATH 找 soffice。Windows 用 where,其余用 command -v。 */
async function findOnPath(): Promise<string | null> {
  const binary = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('where', [binary], { timeout: 5_000 });
      const first = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
      return first ?? null;
    }
    const { stdout } = await execFileAsync('/usr/bin/env', ['sh', '-c', `command -v ${binary}`], {
      timeout: 5_000,
    });
    const found = stdout.trim();
    return found.length > 0 ? found : null;
  } catch {
    return null;
  }
}

export interface SofficeLookupOptions {
  /** 测试注入:覆盖候选位置表,避免测试依赖本机是否真的装了 LibreOffice。 */
  wellKnownPaths?: string[];
  /** 测试注入:覆盖 PATH 查询。 */
  lookupOnPath?: () => Promise<string | null>;
  /** 跳过进程级缓存(测试用)。 */
  noCache?: boolean;
}

/** 找到 soffice 可执行文件的绝对路径;没装返回 null。 */
export async function findSoffice(opts: SofficeLookupOptions = {}): Promise<string | null> {
  if (!opts.noCache && cachedPath && (await isExecutable(cachedPath))) return cachedPath;

  const candidates = opts.wellKnownPaths ?? WELL_KNOWN_PATHS[process.platform] ?? [];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      if (!opts.noCache) cachedPath = candidate;
      return candidate;
    }
  }
  const onPath = await (opts.lookupOnPath ?? findOnPath)();
  if (onPath && (await isExecutable(onPath))) {
    if (!opts.noCache) cachedPath = onPath;
    return onPath;
  }
  return null;
}

/** 仅供测试:清掉进程级缓存。 */
export function __resetSofficeCache(): void {
  cachedPath = null;
}

/** 转换支持的输入扩展名。超出这个集合的直接拒,不让 soffice 去猜。 */
export const OFFICE_INPUT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.doc',
  '.docx',
  '.odt',
  '.rtf',
  '.ppt',
  '.pptx',
  '.odp',
  '.xls',
  '.xlsx',
  '.ods',
  '.csv',
]);

export interface SofficeConvertOptions {
  sofficePath: string;
  inputPath: string;
  /** soffice 只能指定输出目录,文件名由它按输入名 + .pdf 生成。 */
  outDir: string;
  timeoutMs: number;
  /** 测试注入:替换真实进程调用。 */
  run?: (bin: string, args: string[], timeoutMs: number) => Promise<void>;
}

/**
 * 调 soffice 无头转换。`-env:UserInstallation` 指向任务专属临时 profile:
 * 不带它时,若用户正好开着 LibreOffice GUI,后台这次调用会因 profile 被占用
 * 直接退出(而且是 exit 0 + 不产出文件的那种假成功)。
 */
export async function runSofficeConvert(opts: SofficeConvertOptions): Promise<void> {
  const args = [
    '--headless',
    '--norestore',
    '--invisible',
    `-env:UserInstallation=file://${path.join(opts.outDir, '.soffice-profile')}`,
    '--convert-to',
    'pdf',
    '--outdir',
    opts.outDir,
    opts.inputPath,
  ];
  const run =
    opts.run ??
    (async (bin, argv, timeoutMs) => {
      await execFileAsync(bin, argv, { timeout: timeoutMs, windowsHide: true });
    });
  await run(opts.sofficePath, args, opts.timeoutMs);
}
