/**
 * 远程 Agent 执行器的工作区(控制端)。
 *
 * Agent 跑在另一台电脑上，它对本机文件和命令的每个请求都在这里落地。路径一律按本机路径
 * 解析：相对路径以任务工作目录为基准。Agent 所在电脑上的影子目录(只放项目说明类小文件，
 * 让 Agent 照常加载项目说明与 Skill)在这里映射回本机真实目录，模型即使用了影子路径也落在
 * 本机项目里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isSensitiveCredentialPath } from '@cindy/maker-core';

export interface ExecutorPathAlias {
  /** Agent 所在电脑上的影子目录(绝对路径，按该电脑的路径写法)。 */
  from: string;
  /** 对应的本机真实目录。 */
  to: string;
}

export interface ExecutorWorkspaceRoots {
  /** 任务工作目录(本机绝对路径)。 */
  workingDir: string;
  /** 额外允许的目录(任务的附加目录)。 */
  extraDirs?: readonly string[];
  /** 影子目录映射。 */
  aliases?: readonly ExecutorPathAlias[];
}

export class ExecutorPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorPathError';
  }
}

/** 取一个路径的真实路径；不存在时按最近的已存在祖先解析，再拼回剩余部分。 */
export function realPathOrAncestor(target: string): string {
  let current = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 影子目录前缀匹配：只认完整路径段(`/a/b` 不匹配 `/a/bc`)，不区分分隔符写法。 */
function stripAliasPrefix(input: string, from: string): string | null {
  const normalizedInput = input.replace(/\\/g, '/');
  const normalizedFrom = from.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedFrom) return null;
  const windows = /^[A-Za-z]:|^\/\//.test(normalizedFrom);
  const comparedInput = windows ? normalizedInput.toLowerCase() : normalizedInput;
  const comparedFrom = windows ? normalizedFrom.toLowerCase() : normalizedFrom;
  if (comparedInput === comparedFrom) return '';
  if (comparedInput.startsWith(`${comparedFrom}/`)) return normalizedInput.slice(normalizedFrom.length + 1);
  return null;
}

/** 对已知目录做单次双向投影，最长前缀先匹配，防止替换结果再次被短祖先别名改写。 */
export function projectPathText(text: string, aliases: readonly ExecutorPathAlias[]): string {
  const entries = aliases.filter((alias) => alias.from.replace(/[\\/]+$/, '').length > 2)
    .sort((a, b) => b.from.length - a.from.length);
  if (!entries.length) return text;
  const patterns = entries.map((alias) => alias.from.replace(/[\\/]+$/, '').split(/[\\/]/)
    .map((part) => part.replace(/[.*+?^$()|[\]{}]/g, '\\$&')).join('[/\\\\]'));
  // 左右都要求路径段边界，避免修改 longer/project2 或文本里的同前缀标识符。
  // 这里的边界覆盖 shell 的 ;、反引号、?、& 等分隔符。
  const pattern = new RegExp('(^|[^A-Za-z0-9_])(' + patterns.join('|') + ')(?=$|[^A-Za-z0-9_])([/\\\\][^\\s\\x60;:|&)<>}\\]]*|)', 'gi');
  return text.replace(pattern, (match: string, left: string, prefix: string, suffix: string) => {
    const alias = entries.find((entry) => stripAliasPrefix(prefix, entry.from) === '');
    if (!alias) return match;
    const separator = alias.to.includes('\\') ? '\\' : '/';
    return left + alias.to.replace(/[\\/]+$/, '') + suffix.replace(/[\\/]/g, separator);
  });
}

export class ExecutorWorkspace {
  readonly workingDir: string;
  private roots: string[];
  private extraDirs: string[];
  private aliases: ExecutorPathAlias[];
  private virtualRoot?: string;

  constructor(roots: ExecutorWorkspaceRoots) {
    if (!path.isAbsolute(roots.workingDir)) throw new ExecutorPathError('working directory must be absolute');
    this.workingDir = path.resolve(roots.workingDir);
    this.extraDirs = [];
    this.roots = [];
    this.aliases = [];
    this.setAliases(roots.aliases ?? []);
    this.setExtraDirs(roots.extraDirs ?? []);
  }

  /** Agent 启动后才知道它那边的影子目录，届时设置。 */
  setAliases(aliases: readonly ExecutorPathAlias[]): void {
    const expanded: ExecutorPathAlias[] = [];
    for (const alias of aliases) {
      if (!alias.from || !path.isAbsolute(alias.to)) continue;
      expanded.push(alias);
      const canonical = realPathOrAncestor(alias.to);
      if (path.resolve(canonical) !== path.resolve(alias.to)) expanded.push({ from: alias.from, to: canonical });
    }
    const seen = new Set<string>();
    this.aliases = expanded
      .filter((alias) => {
        const key = alias.from + '\\0' + path.resolve(alias.to);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.from.length - a.from.length);
  }

  /**
   * 命令沿用 Desktop 的完整环境(与本机 Agent 一致)，虚拟化只作用于 Agent 看到的路径文本。
   * 用户目录与临时目录已有别名；PATH 里其余目录在这里登记，env / which 之类的输出也只露虚拟路径。
   */
  setVirtualRoot(root?: string): void {
    this.virtualRoot = root;
    if (root) this.virtualizeDirs(this.unaliasedSearchDirs());
  }

  private unaliasedSearchDirs(): string[] {
    const dirs: string[] = [];
    for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!entry || !path.isAbsolute(entry) || this.toAgentPath(entry) !== entry) continue;
      try {
        if (fs.statSync(entry).isDirectory()) dirs.push(entry);
      } catch {
        // PATH 里不存在的目录不会出现在输出里，无需登记。
      }
    }
    return dirs;
  }

  /** 运行中新增的目录分配新的 opaque 别名，撤销授权不撤销路径身份。 */
  virtualizeDirs(dirs: readonly string[]): string[] {
    if (!this.virtualRoot) return [...dirs];
    const native = /^[A-Za-z]:|^\\\\/.test(this.virtualRoot) ? path.win32 : path.posix;
    return dirs.map((dir) => {
      const real = this.resolve(dir);
      const exact = this.aliases.find((alias) => path.resolve(alias.to) === real);
      if (exact) return exact.from;
      const virtual = native.join(this.virtualRoot!, 'additional', 'runtime-' + this.aliases.length);
      this.setAliases([...this.aliases, { from: virtual, to: real }]);
      return virtual;
    });
  }

  /** 任务运行中附加目录变化时更新。 */
  setExtraDirs(extraDirs: readonly string[]): void {
    this.extraDirs = extraDirs.filter((dir) => path.isAbsolute(dir)).map((dir) => path.resolve(dir));
    this.roots = [this.workingDir, ...this.extraDirs].map((dir) => realPathOrAncestor(dir));
  }

  /** 工作目录与附加目录(本机路径，未解析符号链接)。 */
  allRoots(): string[] {
    return [this.workingDir, ...this.extraDirs];
  }

  /** 影子路径映射回本机路径；不是影子路径时原样返回。 */
  mapAlias(input: string): string {
    for (const alias of this.aliases) {
      const rest = stripAliasPrefix(input, alias.from);
      if (rest !== null) return rest ? path.join(alias.to, ...rest.split('/')) : alias.to;
    }
    return input;
  }

  /** 本机真实路径投影到 Agent 主机上的路径；仅匹配完整路径段。 */
  toAgentPath(input: string): string {
    if (!this.virtualRoot) return input;
    const aliases = [...this.aliases].sort((a, b) => b.to.length - a.to.length);
    for (const alias of aliases) {
      const rest = stripAliasPrefix(input, alias.to);
      if (rest === null) continue;
      const native = /^[A-Za-z]:|^\\\\/.test(alias.from) ? path.win32 : path.posix;
      return rest ? native.join(alias.from, ...rest.split('/')) : alias.from;
    }
    return input;
  }

  /** 工具输出、诊断和可逆的 UTF-8 文本内容使用虚拟路径；二进制字节保持原样。 */
  mapTextForAgent(text: string): string {
    if (!this.virtualRoot) return text;
    const aliases = this.aliases.flatMap((alias) => {
      const real = alias.to.replace(/\\/g, '/');
      const entries = [{ from: real, to: alias.from }];
      // Git Bash / MSYS 的 pwd 和诊断使用 /c/...，而 Node 返回 C:\...。
      if (/^[A-Za-z]:\//.test(real)) entries.push({ from: '/' + real[0].toLowerCase() + real.slice(2), to: alias.from });
      if (process.platform === 'win32') {
        const temporary = os.tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
        const relative = stripAliasPrefix(real, temporary);
        if (relative !== null) entries.push({ from: '/tmp' + (relative ? '/' + relative : ''), to: alias.from });
      }
      return entries;
    });
    return projectPathText(text, aliases);
  }

  /** 把 Agent 虚拟路径还原成本机路径，用于文本文件写回。 */
  mapTextFromAgent(text: string): string {
    if (!this.virtualRoot) return text;
    return projectPathText(text, this.aliases.map((alias) => ({
      from: alias.from.replace(/\\/g, '/'),
      to: alias.to,
    })));
  }

  mapOutputForAgent(data: Buffer): Buffer {
    const text = data.toString('utf8');
    // 二进制 stdout 不做 UTF-8 往返，避免 exec.run / process/output 改变原始字节。
    if (data.includes(0) || !Buffer.from(text, 'utf8').equals(data)) return data;
    const projected = this.mapTextForAgent(text);
    return projected === text ? data : Buffer.from(projected, 'utf8');
  }

  mapInputFromAgent(data: Buffer): Buffer {
    const text = data.toString('utf8');
    if (data.includes(0) || !Buffer.from(text, 'utf8').equals(data)) return data;
    const projected = this.mapTextFromAgent(text);
    return projected === text ? data : Buffer.from(projected, 'utf8');
  }

  /** 命令文本里出现的影子目录前缀替换成本机目录(按 shell 语法安全引用)。 */
  mapCommand(command: string, dialect: 'bash' | 'cmd' = 'bash'): string {
    const aliases = this.aliases.map((alias) => ({
      from: alias.from,
      to: process.platform === 'win32' ? alias.to.replace(/\\/g, '/') : alias.to,
    })).filter((alias) => alias.from.replace(/[\\/]+$/, '').length > 2)
      .sort((a, b) => b.from.length - a.from.length);
    if (!aliases.length) return command;
    const patterns = aliases.map((alias) => alias.from.replace(/[\\/]+$/, '').split(/[\\/]/)
      .map((part) => part.replace(/[.*+?^$()|[\\]{}]/g, '\\$&')).join('[/\\\\]'));
    // 路径尾部遇到引号即止：闭合引号属于外层 shell 语法，吞进路径会被按引号上下文转义
    // ('…mjs' → '…mjs'\'')，留下未闭合的引号。
    const pattern = new RegExp('(^|[^A-Za-z0-9_])(' + patterns.join('|') + ')(?=$|[^A-Za-z0-9_])([/\\\\][^\\s\\x60\\x27\\x22;:|&)<>}\\]]*|)', 'gi');
    const quoteContext = (input: string, end: number): 'none' | 'single' | 'double' => {
      let quote: 'none' | 'single' | 'double' = 'none';
      let escaped = false;
      for (let i = 0; i < end; i += 1) {
        const char = input[i];
        if (escaped) { escaped = false; continue; }
        if (char === '\\' && quote !== 'single') { escaped = true; continue; }
        if (quote === 'none' && char === "'") quote = 'single';
        else if (quote === 'none' && char === '"') quote = 'double';
        else if (quote === 'single' && char === "'") quote = 'none';
        else if (quote === 'double' && char === '"') quote = 'none';
      }
      return quote;
    };
    const quote = (value: string, context: 'none' | 'single' | 'double'): string => {
      if (dialect === 'cmd') {
        const safe = value.replace(/%/g, '%%');
        return context === 'double' ? safe : /[\s"&|<>^]/.test(safe) ? '"' + safe.replace(/"/g, '\\"') + '"' : safe;
      }
      if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
      if (context === 'single') return value.replace(/'/g, "'\\''");
      if (context === 'double') return value.replace(/[\\$\x60"]/g, '\\$&');
      return /[\s'"\x60$;&|<>()[\\]{}!*?]/.test(value)
        ? "'" + value.replace(/'/g, "'\\''") + "'"
        : value;
    };
    return command.replace(pattern, (match: string, left: string, prefix: string, suffix: string, offset: number, input: string) => {
      const alias = aliases.find((entry) => stripAliasPrefix(prefix, entry.from) === '');
      if (!alias) return match;
      const separator = alias.to.includes('\\') ? '\\' : '/';
      const target = alias.to.replace(/[\\/]+$/, '') + suffix.replace(/[\\/]/g, separator);
      return left + quote(target, quoteContext(input, offset + left.length));
    });
  }

  /** 把 Agent 给的路径解析成本机绝对路径(相对路径以 baseDir / 工作目录为基准)。 */
  resolve(input: string, baseDir = this.workingDir): string {
    if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
      throw new ExecutorPathError('path is empty or invalid');
    }
    const trimmed = input.startsWith('@') ? input.slice(1) : input;
    const expanded = trimmed === '~' || trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(1))
      : trimmed;
    return path.resolve(this.mapAlias(baseDir), this.mapAlias(expanded));
  }

  /** 真实路径是否落在工作目录或附加目录内(防符号链接与 `..` 借道)。 */
  contains(absolutePath: string): boolean {
    const real = realPathOrAncestor(absolutePath);
    return this.roots.some((root) => isInside(real, root));
  }

  /**
   * 凭证类路径(与本机 harness 权限适配器同一份规则)。本机任务对这类路径是「每次都问」，
   * 执行器同样要求本机确认过才放行。
   */
  isSensitive(absolutePath: string): boolean {
    return isSensitiveCredentialPath(absolutePath) || isSensitiveCredentialPath(realPathOrAncestor(absolutePath));
  }
}
