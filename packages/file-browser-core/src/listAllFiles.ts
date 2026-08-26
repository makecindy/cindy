/**
 * listAllFiles — 项目级文件名列表(用 ripgrep `--files` honor .gitignore)。
 *
 * 用途:RSB 文件浏览器的"快速文件筛选"(Codex / VSCode Cmd+P 风格 fuzzy filter)
 * 需要一份完整的项目文件清单做内存索引,文件树自身是 lazy 单层扫描,撑不出这份
 * 清单。直接复用 ripgrep 子进程的 `--files` 模式,它本身就 honor .gitignore +
 * .ignore + .rgignore,扫描超快(大型 monorepo < 500ms),不会读 stat,只列路径。
 *
 * 上限:30000 文件。超过 cap 立刻 kill rg,返回 `truncated=true`,renderer 给用户
 * 提示"项目太大,只索引了前 30000 个文件"。这个上限对绝大多数项目够用,Unity /
 * monorepo 等超大型工作目录会触发截断,但 RSB 嵌入式版的场景本来就不该是"找
 * Unity Assets 里的某个 prefab",用户应该在 doc / full IDE 模式下用全功能搜索。
 *
 * 安全:rg 自己只能扫描 cwd 内的文件,这里 cwd 锁定 workdir,无法被 query 串构造
 * 出 ../../ 跳出。spawn 用 windowsHide 避 Windows 弹黑框。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { loadIgnoreMatcher } from './ignore.js';
import { scopedLogger } from './logging.js';

const log = scopedLogger('file-browser/listAllFiles');

/** 上限:项目文件超出后立即截断 + kill rg。30000 对绝大多数 monorepo 足够。 */
export const LIST_ALL_FILES_CAP = 30000;

/** SIGTERM 后 fallback SIGKILL 间隔(ms)。 */
const KILL_GRACE_MS = 200;

export interface ListAllFilesArgs {
  workdir: string;
  /** ripgrep 二进制绝对路径(由 caller 从 host runtime config 拿)。 */
  rgPath: string;
  /** 自定义上限(默认 LIST_ALL_FILES_CAP);超出后 kill rg + 标记 truncated。 */
  cap?: number;
}

export interface ListAllFilesResult {
  /** workdir 相对 POSIX 路径(rg 输出已经是相对于 cwd,Windows 反斜杠会被归一化)。 */
  files: string[];
  /** true = 命中 cap 触发截断,renderer 应提示"项目太大"。 */
  truncated: boolean;
  /** rg 子进程实际跑了多久(ms),debug / telemetry 用。 */
  elapsedMs: number;
}

/**
 * 跑一次 ripgrep `--files` 收集 workdir 内全部 non-ignored 文件路径。
 *
 * Promise 完成条件:
 *  - rg 自然结束 → `truncated=false`
 *  - 命中 cap → kill rg → `truncated=true`
 *  - rg spawn 失败 / 进程错误 → reject
 *
 * 一次性收集,**不流式吐**——renderer 拿到完整 list 后才能做内存索引,流式吐
 * 反而让前端要管中间状态,得不偿失。
 */
export function listAllFiles(args: ListAllFilesArgs): Promise<ListAllFilesResult> {
  const cap = args.cap ?? LIST_ALL_FILES_CAP;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    // rg flags:
    //   --files            只列文件,不搜内容
    //   --hidden           遍历 .开头文件,但 .gitignore 仍生效
    //   --no-messages      抑制 "No such file" 之类的 stderr 噪音
    //   --                 终止 flag 解析(防止 workdir 以 - 开头)
    const rgArgs = ['--files', '--hidden', '--no-messages', '--', '.'];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(args.rgPath, rgArgs, {
        cwd: args.workdir,
        windowsHide: true,
      });
    } catch (err) {
      log.error('rg spawn failed', { workdir: args.workdir, error: String(err) });
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const files: string[] = [];
    let truncated = false;
    let killed = false;
    const reader = createInterface({ input: child.stdout });

    function killRg(reason: string) {
      if (killed) return;
      killed = true;
      log.debug('rg kill', { reason, collected: files.length });
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, KILL_GRACE_MS).unref();
    }

    reader.on('line', (raw) => {
      if (truncated) return;
      // rg --files 在 macOS / Linux 输出 POSIX 相对路径;Windows 用反斜杠,归一化
      // 成 POSIX 让 renderer 不用关心平台差异(规则 15)。
      const normalized = raw.replace(/\\/g, '/');
      // rg 偶尔有 `./` 前缀(取决于 cwd 形式),剥掉。
      const clean = normalized.startsWith('./') ? normalized.slice(2) : normalized;
      if (!clean) return;
      files.push(clean);
      if (files.length >= cap) {
        truncated = true;
        killRg('cap reached');
      }
    });

    child.on('error', (err) => {
      log.error('rg process error', { error: String(err) });
      reader.close();
      reject(err);
    });

    child.on('close', (code, signal) => {
      reader.close();
      const elapsedMs = Date.now() - start;
      // truncated 时 rg 因被我们 SIGTERM 退出,code/signal 不一定 0 — 仍当 success。
      // signal 非空 = 被 OOM killer / SIGKILL 等意外终止(code 为 null)。
      if (!truncated && signal !== null) {
        log.warn('rg killed by signal', { signal, elapsedMs, files: files.length });
        reject(new Error(`ripgrep killed by signal ${signal}`));
        return;
      }
      // exit code 1 = no matches (--files 模式下空目录/全部被忽略);>= 2 = 致命错误。
      if (!truncated && code !== null && code >= 2) {
        log.warn('rg exited with fatal error', { code, signal, elapsedMs, files: files.length });
        reject(new Error(`ripgrep exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`));
        return;
      }
      if (!truncated && code === 1) {
        // exit 1 = 空目录或全部被 .gitignore 排除;合法的空清单。
        log.debug('rg exited 1 (no files)', { elapsedMs });
      }
      log.debug('rg done', { workdir: args.workdir, files: files.length, truncated, elapsedMs });
      resolve({ files, truncated, elapsedMs });
    });
  });
}

export interface ListAllFilesWalkArgs {
  workdir: string;
  /** 自定义上限(默认 LIST_ALL_FILES_CAP);超出后停止遍历 + 标记 truncated。 */
  cap?: number;
}

/**
 * 无 ripgrep 的纯 JS fallback:递归 readdir + 与文件树同一个 ignore matcher。
 *
 * 与 rg 版的语义差异(有意为之、确定可解释):过滤走 loadIgnoreMatcher(根
 * .gitignore / .p4ignore + BUILTIN_IGNORE),即**清单 = 用户在文件树里能看到的
 * 文件全集**;rg 版额外理解嵌套 .gitignore / .rgignore,并且不吃 BUILTIN_IGNORE。
 * 用途场景(远端裸机器没有 rg 时的文件名筛选)里"和树一致"比"和 rg 一致"更符合
 * 直觉。性能:纯 JS 串行遍历比 rg 慢一个量级,但被 cap 上限兜底,中型项目 <1s。
 *
 * symlink:目录/文件符号链接一律跳过(rg --files 默认同样不 follow symlink,
 * 也避免链接环)。不可读目录(权限/竞态删除)静默跳过,不 fail 整个清单。
 */
export async function listAllFilesWalk(args: ListAllFilesWalkArgs): Promise<ListAllFilesResult> {
  const cap = args.cap ?? LIST_ALL_FILES_CAP;
  const start = Date.now();
  // hideMetaFiles=false 对齐 rg 版:.meta 是否可见由消费端决定,清单不预过滤。
  const matcher = await loadIgnoreMatcher(args.workdir, { hideMetaFiles: false });
  const files: string[] = [];
  let truncated = false;

  const walk = async (rel: string): Promise<void> => {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(rel ? path.join(args.workdir, rel) : args.workdir, {
        withFileTypes: true,
      });
    } catch {
      // 权限不足 / 遍历途中被删:跳过该目录,清单尽力而为。
      return;
    }
    for (const ent of entries) {
      if (truncated) return;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue;
      const isDir = ent.isDirectory();
      if (matcher.ignores(childRel, isDir)) continue;
      if (isDir) {
        await walk(childRel);
      } else if (ent.isFile()) {
        files.push(childRel);
        if (files.length >= cap) truncated = true;
      }
    }
  };

  await walk('');
  const elapsedMs = Date.now() - start;
  log.debug('walk done', { workdir: args.workdir, files: files.length, truncated, elapsedMs });
  return { files, truncated, elapsedMs };
}
