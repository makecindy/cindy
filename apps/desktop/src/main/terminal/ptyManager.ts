/**
 * PtyManager —— 管理一组 PTY session（一个 tab 一个 session）。
 *
 * 设计要点（对照 Codex Desktop `main-cC-d0ezP.js:60513-60647` 的 s1 + h1 class）:
 *
 *   - **session 生命周期 = tab 生命周期 = main 进程生命周期**：
 *     PTY 在 `create(id, opts)` 时 spawn，在 `dispose(id)` 时 kill；中间用户 `exit`
 *     或程序 crash 触发 onExit，session 保留在 Map 里（`exitState` 填上退出码），
 *     渲染端 overlay 显示 "Process exited with code N" + Restart 按钮。用户点 Restart
 *     就调 `restart(id)`，原地换一个新 PTY，id 不变。
 *
 *   - **input write 微任务级批处理**：xterm.js 的 onData 每个按键都 fire 一次（粘贴
 *     文本时会 fire 一长串），如果直接 IPC → pty.write 会产生 N 次系统调用 + N 次 IPC。
 *     收到的 input 先累积到 `pendingWrites[id]`，schedule 一个 microtask 一次性 flush。
 *     这是 codex L60589-60607 同款模式。
 *
 *   - **owner WebContents 绑定**：每个 session 记录它的 owner（PTY 输出 sink 的目标窗口）。
 *     webContents destroyed 时优先通过 `resolveFallbackOwner` 把 session 转移给接管者
 *     （RSB 独立子窗口销毁 → 主窗接管，PTY 保活）；解析不到活的接管者才 dispose
 *     该 owner 的所有 session（防止用户关窗后 PTY 还在跑、IPC send 又报错）。
 *     注册一次监听（per webContents）即可，复用 `trackedOwners` 去重。
 *
 *   - **OSC stripping 暂不做**：codex 的 u1 函数过滤 cursor 查询响应等。xterm.js
 *     在 renderer 端已能正确处理标准序列，先不加这一层；后续真有需要再补。
 *
 *   - **encoding**：node-pty 默认 utf8，onData 直接给 string，无需 StringDecoder。
 *     codex s1 class 同样没显式包 decoder。
 */

import { StringDecoder } from 'node:string_decoder';
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import type { WebContents } from 'electron';

import { createLogger } from '../logger.js';
import {
  resolveShellForCreate,
  type ShellId,
  type ResolvedShell,
} from './shellResolver.js';
import { defaultPtySpawn, type PtySpawnFn } from './ptyFactory.js';

const log = createLogger('terminal/pty-manager');

const TERMINAL_NAME = 'xterm-256color';
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * 必须从父 env 删掉的变量集合。对照 Codex Desktop `buildTerminalEnv` 的做法
 * (`main-cC-d0ezP.js:61156-61172`) + 经验黑名单。
 *
 * 为什么要删:
 *   - **TERMINFO / TERMINFO_DIRS**: 父进程(dev terminal / Finder)可能指向某个
 *     非标准 termcap 目录,zsh / ncurses 应用会按它解析序列,跟 xterm.js 的处理
 *     能力不对齐,输出乱码。Codex 显式删这两个。
 *   - **TERM_PROGRAM / TERM_PROGRAM_VERSION / TERM_SESSION_ID**: macOS / Apple
 *     Terminal / iTerm / VSCode 注入的"我是什么 terminal app"标记。oh-my-zsh /
 *     P10k 看到这些会激活该 app 特有的 OSC 序列输出(iTerm shell integration、
 *     VSCode terminal integration 等),xterm.js 不解析这些 → 显示成文本残留。
 *   - **LC_TERMINAL / LC_TERMINAL_VERSION**: iTerm 二级标记(`LC_*` 走 SSH 透
 *     传也能被 detect),同理。
 *   - **ITERM_PROFILE / ITERM_SESSION_ID**: iTerm 特定。
 *   - **VSCODE_***: VSCode injected shell integration script 的入口标记,会让
 *     bashrc/zshrc 的 vscode hook 跑起来,产出 OSC 633 序列。
 *   - **COLORTERM**: 保留(`truecolor` 让 prompt 用 24-bit 色,我们 xterm.js 也支持)。
 *
 * dev 模式下父 shell 把这些都塞进了 Electron `process.env`,packaged Finder 启动
 * 时一般干净,但保险起见两种场景都剥。
 */
const ENV_KEYS_TO_STRIP: readonly string[] = [
  'TERMINFO',
  'TERMINFO_DIRS',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION',
  'ITERM_PROFILE',
  'ITERM_SESSION_ID',
  'ITERM_SHELL_INTEGRATION_INSTALLED',
  'VSCODE_INJECTION',
  'VSCODE_PID',
  'VSCODE_GIT_IPC_HANDLE',
  'VSCODE_GIT_ASKPASS_NODE',
  'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
  'VSCODE_GIT_ASKPASS_MAIN',
  'VSCODE_IPC_HOOK_CLI',
  'VSCODE_NLS_CONFIG',
  'VSCODE_CWD',
  'GIT_ASKPASS', // VSCode 注入的 askpass shim,装了会导致 git 走 VSCode 弹窗
];

export interface CreateOptions {
  /** PTY session id，对应 RSB tab id（1:1 关系）。 */
  id: string;
  /** 工作目录；不存在或为空时主调方应自己 fallback 到 home。 */
  cwd: string;
  cols?: number;
  rows?: number;
  /** Settings 中的用户偏好（'auto' / 具体 id / null）。 */
  shellPref?: ShellId | null;
  /** 创建者 webContents，session destroyed 时自动 dispose 该 owner 所有 session。 */
  owner: WebContents;
  /** 额外 env 覆盖（不强制）。会跟 process.env 浅合并。 */
  env?: Record<string, string | undefined>;
}

export interface CreateResult {
  shellId: Exclude<ShellId, 'auto'>;
  shellDisplayName: string;
  pid: number;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export interface DataPayload {
  id: string;
  chunk: string;
}

export interface ExitPayload {
  id: string;
  exit: ExitInfo;
}

/** 主进程对外暴露的事件接收器。生产代码 → 走 webContents.send；测试 → 自定义收集。 */
export interface PtyEventSink {
  emitData: (target: WebContents, payload: DataPayload) => void;
  emitExit: (target: WebContents, payload: ExitPayload) => void;
}

interface PtySession {
  id: string;
  pty: IPty;
  resolved: ResolvedShell;
  cwd: string;
  cols: number;
  rows: number;
  shellPref: ShellId | null;
  exit: ExitInfo | null;
  owner: WebContents;
  /** 累积待发的 input；flush 完清空。 */
  pendingInput: string;
  /** flush 用的 microtask 是否已经 schedule。 */
  flushScheduled: boolean;
  /** node-pty IDisposable for data subscription；dispose 时手动解订阅。 */
  dataDisposer: { dispose(): void };
  exitDisposer: { dispose(): void };
  /** UTF-8 分块兜底：理论上 node-pty utf8 模式已经处理边界，但保留一份本地 decoder
   *  在收到不合法 surrogate 时仍能给出合理输出。 */
  decoder: StringDecoder;
}

export interface PtyManagerDeps {
  spawn?: PtySpawnFn;
  sink: PtyEventSink;
  /** 仅供测试注入平台；生产代码默认使用当前 Node 平台。 */
  platform?: NodeJS.Platform;
  /**
   * owner webContents destroyed 时的接管者解析(典型:主窗 webContents)。
   * 返回一个活着的、不同于 dead owner 的 webContents 时,该 owner 的 session
   * 整体转移过去(PTY 保活,输出 sink 改推新 owner);返回 null / undefined /
   * 已销毁 / 同一个 webContents 时,回落旧行为 —— dispose 该 owner 全部 session。
   *
   * 动机:RSB 独立子窗口里的终端 re-attach 会把 owner 切到子窗口,用户收起 /
   * 合并回主窗时子窗口销毁 —— 不能因此杀掉运行中的进程(内嵌形态收起侧栏
   * 不杀,两种形态语义必须一致)。主窗销毁(app 退出)时 fallback 解析不到
   * 活 webContents,仍走 dispose,不会泄漏 PTY。
   */
  resolveFallbackOwner?: (deadOwner: WebContents) => WebContents | null;
}

export class PtyManager {
  private readonly sessions = new Map<string, PtySession>();
  private readonly trackedOwners = new WeakSet<WebContents>();
  private readonly spawnFn: PtySpawnFn;
  private readonly sink: PtyEventSink;
  private readonly platform: NodeJS.Platform;
  private readonly resolveFallbackOwner?: (deadOwner: WebContents) => WebContents | null;

  constructor(deps: PtyManagerDeps) {
    this.spawnFn = deps.spawn ?? defaultPtySpawn;
    this.sink = deps.sink;
    this.platform = deps.platform ?? process.platform;
    this.resolveFallbackOwner = deps.resolveFallbackOwner;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * 创建 PTY,或在同 id 已存在时返回现有 session 的元数据(幂等 / createOrAttach 语义)。
   *
   * 为什么幂等:
   *   RSB 切换 session 时,TabBody 卸载,但 main 端 PTY 是按 plugin.onBeforeClose 时
   *   才 dispose 的(切 session != 关 tab)。再切回同 session,TabBody 重新挂载,
   *   plugin.hydrateState 把 state.created 强制设回 false(防 app 重启后空指针),
   *   renderer 又会调 terminal.create(id) —— 同 id 已存在,这里若抛错就破坏体验。
   *
   *   codex `main-cC-d0ezP.js:60738` 的 createOrAttach 同款思路。
   *
   * 行为:
   *   - 同 id 已存在 + 仍在运行 → 返回现有 metadata, **更新 owner 到新 webContents**
   *     (renderer 重新 mount 后用新 webContents,旧 owner 可能已 destroyed);
   *     新传入的 cwd/cols/rows 忽略 —— PTY 内部状态已经走过了,xterm 之后会 resize 同步。
   *   - 同 id 已存在但已 exit → 跟 codex 一致, restart() 是显式动作, 这里也拒绝(抛错让
   *     renderer 知道要走 restart 路径); 但目前 plugin 在 exited 状态会渲染 overlay,
   *     用户点 Restart 后才会调 restart() IPC,不会再调 create。
   */
  create(opts: CreateOptions): CreateResult {
    const existing = this.sessions.get(opts.id);
    if (existing) {
      if (existing.exit) {
        throw new Error(`terminal session already exists (exited): ${opts.id}`);
      }
      // 幂等 attach:把 owner 切到当前 webContents,后续 sink.emitData 才能正确推过去。
      // 单窗口架构下基本是同一个 owner,这步主要给 dev reload (Cmd+R) 重建 webContents
      // 时兜底。
      existing.owner = opts.owner;
      this.trackOwner(opts.owner);
      log.info('pty attached (already exists)', {
        safe: {
          id: opts.id,
          shellId: existing.resolved.id,
          shellDisplayName: existing.resolved.displayName,
          pid: existing.pty.pid,
        },
      });
      return {
        shellId: existing.resolved.id,
        shellDisplayName: existing.resolved.displayName,
        pid: existing.pty.pid,
      };
    }
    const session = this.spawnSession(opts);
    this.sessions.set(opts.id, session);
    this.trackOwner(opts.owner);
    log.info('pty created', {
      safe: {
        id: opts.id,
        shellId: session.resolved.id,
        shellDisplayName: session.resolved.displayName,
        cols: session.cols,
        rows: session.rows,
        pid: session.pty.pid,
      },
    });
    return {
      shellId: session.resolved.id,
      shellDisplayName: session.resolved.displayName,
      pid: session.pty.pid,
    };
  }

  /** xterm.js 的 onData 透传过来的用户输入。微任务级批处理。 */
  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.exit) return;
    session.pendingInput += data;
    if (session.flushScheduled) return;
    session.flushScheduled = true;
    queueMicrotask(() => this.flushPendingInput(id));
  }

  private flushPendingInput(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.flushScheduled = false;
    if (session.exit || session.pendingInput.length === 0) return;
    const chunk = session.pendingInput;
    session.pendingInput = '';
    try {
      session.pty.write(chunk);
    } catch (err) {
      log.warn('pty write failed', {
        safe: { id, length: chunk.length },
        sensitive: { error: err },
      });
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || session.exit) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    if (session.cols === cols && session.rows === rows) return;
    try {
      session.pty.resize(cols, rows);
      session.cols = cols;
      session.rows = rows;
    } catch (err) {
      log.warn('pty resize failed', {
        safe: { id, cols, rows },
        sensitive: { error: err },
      });
    }
  }

  /** 真正关闭 PTY + 移出 Map。已经 exit 的也走一遍清理（idempotent）。 */
  dispose(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    try {
      session.dataDisposer.dispose();
      session.exitDisposer.dispose();
    } catch {
      /* swallow */
    }
    if (!session.exit) {
      try {
        session.pty.kill();
      } catch (err) {
        log.warn('pty kill failed on dispose', {
          safe: { id },
          sensitive: { error: err },
        });
      }
    }
    log.info('pty disposed', { safe: { id, alreadyExited: session.exit != null } });
  }

  /** 在已 exit 的 session 上重启；id 保留，PTY 实例替换。 */
  restart(id: string, owner: WebContents): CreateResult {
    const old = this.sessions.get(id);
    if (!old) throw new Error(`terminal session not found: ${id}`);
    if (!old.exit) throw new Error(`terminal session still running: ${id}`);
    // 先 dispose 旧的（exit 后 kill 是 no-op，主要是解订阅 + 移出 Map）
    this.dispose(id);
    return this.create({
      id,
      cwd: old.cwd,
      cols: old.cols,
      rows: old.rows,
      shellPref: old.shellPref,
      owner,
    });
  }

  /** 触发某 owner 的全部 session 关闭，用于 webContents destroyed。 */
  disposeOwner(owner: WebContents): void {
    for (const [id, session] of this.sessions) {
      if (session.owner === owner) this.dispose(id);
    }
  }

  /** 测试用：枚举当前 session（包含 exit 状态）。 */
  __debugListSessions(): Array<{
    id: string;
    exit: ExitInfo | null;
    shellId: string;
    shellPref: ShellId | null;
    cols: number;
    rows: number;
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      exit: s.exit,
      shellId: s.resolved.id,
      shellPref: s.shellPref,
      cols: s.cols,
      rows: s.rows,
    }));
  }

  private spawnSession(opts: CreateOptions): PtySession {
    const cols = opts.cols && opts.cols > 0 ? opts.cols : DEFAULT_COLS;
    const rows = opts.rows && opts.rows > 0 ? opts.rows : DEFAULT_ROWS;
    const resolved = resolveShellForCreate(opts.shellPref ?? null);

    // 合并 env:先复制父进程环境,做平台兜底,再应用调用方显式覆盖。
    // ENV_KEYS_TO_STRIP 与 TERM 仍在下方强制执行,不允许 opts.env 改写。
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    ensureMacTerminalUtf8Locale(env, this.platform);
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (typeof v === 'string') env[k] = v;
        else if (v === undefined) delete env[k];
      }
    }
    // 剥掉父进程 inherit 来的 terminal app 标记 —— 让 shell 启动脚本以为自己跑
    // 在一个普通的 xterm-256color 终端里(对照 Codex `buildTerminalEnv`)。
    // 必须在 opts.env 之后做,这样调用方仍能显式塞回某个变量。
    for (const k of ENV_KEYS_TO_STRIP) delete env[k];
    env.TERM = TERMINAL_NAME;

    const spawnOpts: IPtyForkOptions | IWindowsPtyForkOptions = {
      name: TERMINAL_NAME,
      cols,
      rows,
      cwd: opts.cwd,
      env,
      // node-pty 默认 utf8，显式写出来更清楚
      encoding: 'utf8',
    };

    const pty = this.spawnFn(resolved.command, resolved.args, spawnOpts);
    const session: PtySession = {
      id: opts.id,
      pty,
      resolved,
      cwd: opts.cwd,
      cols,
      rows,
      shellPref: opts.shellPref ?? null,
      exit: null,
      owner: opts.owner,
      pendingInput: '',
      flushScheduled: false,
      decoder: new StringDecoder('utf8'),
      // 占位，注册下面就替换。
      dataDisposer: { dispose() {} },
      exitDisposer: { dispose() {} },
    };

    session.dataDisposer = pty.onData((chunk: string) => {
      // node-pty 在 utf8 模式下已经按 UTF-8 边界切，再走 decoder 主要是对 Buffer
      // 兜底（极端情况下出现 surrogate pair 跨 chunk）。这里 chunk 是 string，
      // 直接转发即可，decoder.write 仅在某些异常路径上有意义。
      if (!session.owner.isDestroyed()) {
        this.sink.emitData(session.owner, { id: session.id, chunk });
      }
    });

    session.exitDisposer = pty.onExit(({ exitCode, signal }) => {
      const exitInfo: ExitInfo = {
        code: typeof exitCode === 'number' ? exitCode : null,
        signal: signal != null ? String(signal) : null,
      };
      session.exit = exitInfo;
      // flush 一下残留输入（exit 后写无意义，但保持状态干净）
      session.pendingInput = '';
      log.info('pty exit', {
        safe: { id: session.id, code: exitInfo.code, signal: exitInfo.signal },
      });
      if (!session.owner.isDestroyed()) {
        this.sink.emitExit(session.owner, { id: session.id, exit: exitInfo });
      }
    });

    return session;
  }

  private trackOwner(owner: WebContents): void {
    if (this.trackedOwners.has(owner)) return;
    this.trackedOwners.add(owner);
    owner.once('destroyed', () => {
      this.handleOwnerDestroyed(owner);
    });
  }

  /**
   * owner destroyed 的处理:能解析到活的 fallback owner(主窗)就整体转移
   * session(PTY 保活,sink 改推 fallback),否则 dispose(app 退出 / 主窗没了)。
   */
  private handleOwnerDestroyed(owner: WebContents): void {
    const fallback = this.resolveFallbackOwner?.(owner) ?? null;
    if (!fallback || fallback === owner || fallback.isDestroyed()) {
      this.disposeOwner(owner);
      return;
    }
    let transferred = 0;
    for (const session of this.sessions.values()) {
      if (session.owner !== owner) continue;
      session.owner = fallback;
      transferred += 1;
    }
    if (transferred > 0) {
      this.trackOwner(fallback);
      log.info('pty sessions transferred to fallback owner on webContents destroy', {
        safe: { count: transferred },
      });
    }
  }
}

/**
 * macOS Finder/Dock 启动的 GUI 进程可能继承到空/C locale。zsh 的行编辑器
 * 需要 UTF-8 的 LC_CTYPE 才能正确识别中文等多字节输入；只设置 LANG 不够，
 * 因为非空 LC_CTYPE 会覆盖 LANG。非空 LC_ALL 通常表示用户主动指定，保留其
 * 语义；调用方通过 opts.env 传入的显式覆盖也在本函数之后生效。
 */
function ensureMacTerminalUtf8Locale(
  env: Record<string, string>,
  platform: NodeJS.Platform,
): void {
  if (platform !== 'darwin' || env.LC_ALL?.trim()) return;

  const charLocale = env.LC_CTYPE?.trim() || env.LANG?.trim() || 'C';
  const normalized = charLocale.toUpperCase();
  if (normalized !== 'C' && normalized !== 'POSIX') return;

  env.LC_CTYPE = 'UTF-8';
}
