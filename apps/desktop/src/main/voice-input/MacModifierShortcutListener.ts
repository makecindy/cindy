import { app } from 'electron';
import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

import {
  isVoiceInputMacNativeKeyboardShortcut,
  isVoiceInputMacNativeKeyboardShortcutPressed,
  isVoiceInputMacNativeKeyboardShortcutTargetDown,
  isVoiceInputModifierShortcut,
  type VoiceInputShortcut,
} from '../../shared/voiceInputData.js';
import { createLogger } from '../logger.js';

const log = createLogger('voice-input:modifier-shortcut');

const MAC_MODIFIER_SHORTCUT_LISTENER_RESOURCE = path.join(
  'tools',
  'voice-input',
  'xdt-macos-modifier-shortcut-listener',
);
const MAC_MODIFIER_SHORTCUT_LISTENER_SOURCE_RELATIVE = path.join(
  'native',
  'voice-input',
  'macos-modifier-shortcut-listener.swift',
);
const MODIFIER_SHORTCUT_HOLD_DELAY_MS = 450;
const LISTENER_START_TIMEOUT_MS = 1_500;
const LISTENER_RESTART_MAX_ATTEMPTS = 3;
const LISTENER_RESTART_BASE_DELAY_MS = 1_000;
const LISTENER_RESTART_MAX_DELAY_MS = 5_000;

type ListenerTriggerPhase = 'tap' | 'start' | 'end';

type ListenerStartResult =
  | { ok: true }
  /**
   * `superseded` = 这次启动被 stop 或更晚的一轮顶掉了（解析 helper 期间、或 spawn 之后
   * 报 ready 之前都算）。
   * 它不是故障：更晚的那轮正在负责这个 listener，所以调用方**不该**据此做清理或报错
   * （录制登记按 sender id 记账，同一个设置页连续两轮用同一个 id，误清会把新一轮的
   * 登记一起删掉，helper 起来了却没人收 keys）。
   */
  | { ok: false; error: string; superseded?: true };

function supersededStart(): ListenerStartResult {
  return { ok: false, error: 'Modifier shortcut listener start was superseded.', superseded: true };
}

export type MacInputMonitoringPermissionSnapshot =
  | { ok: true; status: string }
  | { ok: false; status: string; error: string };

type ListenerPayload = {
  type?: unknown;
  phase?: unknown;
  message?: unknown;
  code?: unknown;
  keys?: unknown;
  permission?: unknown;
  granted?: unknown;
};

type MacModifierShortcutListenerOptions = {
  onTrigger: (phase: ListenerTriggerPhase) => void;
  onKeys?: (keys: string[]) => void;
};

type ListenerProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Runs a tiny macOS keyboard snapshot helper outside Electron's main process.
 *
 * Electron's globalShortcut cannot represent "hold only this bare modifier,
 * then end on release" reliably. The native helper only reports the current
 * pressed-key snapshot; this class owns the product semantics: start on key
 * down, classify short release as tap, and classify release after the hold
 * threshold as end for push-to-talk.
 */
export class MacModifierShortcutListener {
  private child: ListenerProcess | null = null;
  /**
   * child 是否**已经报过 ready**。
   *
   * 与 isRunning() 的区别很关键：后者在 spawn 之后立刻为 true，而这中间那段（编译好、进程起
   * 来了，但还没建立 event tap / 还没报 ready）它其实什么都收不到。exit 之后 scheduleRestart
   * 起的替补也走这一段，而重启不经过 setShortcut，所以调用方那边的「已注册」记录一直是旧的 ——
   * 光看 isRunning + 已注册会把「替补正在起」误判成「一切正常」，替补及其重试全失败时就没人
   * 兜底了。
   */
  private ready = false;
  /**
   * 启动代次。spawn 之前要先 await 解析 helper 路径（dev 下可能现编译几秒），那段时间
   * `child` 还是 null，所以 stop 光看 `child` 拦不住一个正在飞的启动，重叠的启动之间也
   * 会互相覆盖 `child` 引用、把前一个变成没人收的孤儿——而它持有全局 event tap。
   * 每次发起启动都占一个代次，await 回来后代次被顶掉就放弃 spawn。
   */
  private startGeneration = 0;
  /**
   * 正在飞的那次启动的 promise（spawn 完成、但还没报 ready 的那段也算）。
   *
   * 有它才能回答「child 在跑，但它到底能不能用」——见 awaitInFlightChild 的说明。settle 之后
   * 清空：那时 ready / child 已经反映了真实落点，不需要再等。
   */
  private pendingStart: Promise<ListenerStartResult> | null = null;
  private shortcut: VoiceInputShortcut | null = null;
  private pressedKeys = new Set<string>();
  private startTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private triggered = false;
  private holdThresholdReached = false;
  private keyboardShortcutPressed = false;
  private canceledUntilRelease = false;

  constructor(private readonly options: MacModifierShortcutListenerOptions) {}

  isRunning(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  /** child 已经报过 ready（真的在监听了），而不只是「进程起来了」。见 `ready` 的说明。 */
  isReady(): boolean {
    return this.ready && this.isRunning();
  }

  /**
   * 当前在飞的那次启动；没有就返回 null。
   *
   * 给「被顶掉的那一轮」用：helper 是共享的，被顶掉不等于它的诉求落空了 —— 接手的那一轮成功，
   * 它也就有 helper 可用；接手的那一轮失败，它同样需要知道，否则录制框收不到 Fn 却一句解释都
   * 没有。调用方据此等共享启动的真实落点，见 global.ts 的 resolveSupersededRecordingStart。
   */
  pendingStartResult(): Promise<ListenerStartResult> | null {
    return this.pendingStart;
  }

  async setShortcut(shortcut: VoiceInputShortcut): Promise<ListenerStartResult> {
    if (!isVoiceInputModifierShortcut(shortcut) && !isVoiceInputMacNativeKeyboardShortcut(shortcut)) {
      this.stop();
      return { ok: true };
    }
    this.shortcut = shortcut;
    this.clearRestartTimer();
    this.restartAttempts = 0;
    this.endActiveTriggerIfNeeded();
    this.resetState();
    if (this.child) {
      return this.awaitInFlightChild();
    }

    return this.startChildProcess();
  }

  async startKeyCapture(): Promise<ListenerStartResult> {
    this.clearRestartTimer();
    this.restartAttempts = 0;
    this.resetState();
    if (this.child) {
      return this.awaitInFlightChild();
    }
    return this.startChildProcess({ preserveShortcutOnFailure: true });
  }

  /**
   * 复用一个已存在的 child 时，判定它到底能不能用。
   *
   * 光看 `this.child` 非 null 是不够的：spawn 之后到报 ready 之前那段，进程在跑但 event tap
   * 还没建立起来。而 releaseShortcutKeepingCapture 会**故意**保留这种还没就绪的 child（有窗口
   * 正在录制时不能把它们的 keys 来源杀掉）。两件事凑在一起就会说谎：
   *
   * A 窗口的 capture 还在启动 → B 窗口挂起（child 被保留）→ B 提交快捷键，setShortcut 看见
   * child 就报成功 → 快捷键存盘、界面显示已注册 → A 那次启动随后超时或 exit，settle 的失败
   * 路径把 child 置空（且这条路不会 scheduleRestart）→ 快捷键写着「已注册」，其实没人在监听，
   * 要等下一次窗口聚焦触发兜底恢复才被救回来。
   *
   * 所以：已 ready 才算成功，否则等那次启动的**真实落点**再判。等待有上界（启动超时）。
   */
  private async awaitInFlightChild(): Promise<ListenerStartResult> {
    if (this.isReady()) return { ok: true };
    const pending = this.pendingStart;
    // child 在跑却没有启动在飞：settle 过的成功启动会把 ready 置真（上面已返回），失败的会把
    // child 置空。也就是说这里到不了；真到了就维持旧行为，别把状态判死。
    if (!pending) return { ok: true };
    const result = await pending;
    // 被更晚一轮顶掉：那一轮才决定最终结果，这里照约定原样上报，调用方静默丢弃。
    if (!result.ok && result.superseded) return result;
    // 等回来之后重新读状态，而不是直接用 result.ok —— 那次启动报了 ready 但随即被 stop 杀掉
    // 的情况下，此刻真相是「没有在监听」。
    if (this.isReady()) return { ok: true };
    return {
      ok: false,
      error: result.ok ? 'Modifier shortcut listener did not start.' : result.error,
    };
  }

  stopKeyCapture(): void {
    if (this.shortcut) {
      this.resetState();
      return;
    }
    this.stop();
  }

  /**
   * 放弃当前快捷键，但**保留** capture 子进程。
   *
   * 同一个 helper 既服务「常驻快捷键监听」也服务「录制页的 Fn 检测」。有窗口正在录制时直接
   * stop() 会把它们的 keys 来源一起杀掉 —— 那个窗口的录制框还开着，却再也收不到 Fn，只能关掉
   * 重开。所以这里只清快捷键相关的状态，child 交给 stopKeyCapture / stop 去收。
   */
  releaseShortcutKeepingCapture(): void {
    this.shortcut = null;
    this.clearRestartTimer();
    this.restartAttempts = 0;
    this.endActiveTriggerIfNeeded();
    this.resetState();
  }

  stop(): void {
    // 作废正在飞的启动：它可能还停在解析 helper 的 await 上，此刻 child 仍是 null，
    // 下面的 kill 够不着它。不作废的话它随后会 spawn 出一个没人管的 helper。
    this.startGeneration += 1;
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.shortcut = null;
    this.clearRestartTimer();
    this.restartAttempts = 0;
    this.endActiveTriggerIfNeeded();
    this.resetState();
    if (!child || child.killed) return;
    child.kill();
  }

  /**
   * 记账版入口：把这次启动挂到 pendingStart 上，好让并发的复用方等到真实落点
   * （见 awaitInFlightChild）。只有比自己更晚的启动能覆盖它，收尾时也只清自己那一份。
   */
  private startChildProcess(options?: { preserveShortcutOnFailure?: boolean }): Promise<ListenerStartResult> {
    const started = this.runChildProcessStart(options);
    this.pendingStart = started;
    void started.then(
      () => { if (this.pendingStart === started) this.pendingStart = null; },
      () => { if (this.pendingStart === started) this.pendingStart = null; },
    );
    return started;
  }

  private async runChildProcessStart(options?: { preserveShortcutOnFailure?: boolean }): Promise<ListenerStartResult> {
    const generation = ++this.startGeneration;
    let binary: string;
    try {
      binary = await resolveMacModifierShortcutListenerBinary();
    } catch (error) {
      // 解析/编译失败也要看这次启动还算不算数：已被 stop 或被更晚一次顶掉时，这个失败
      // 跟用户当前在做的事无关，报成普通故障会让调用方拿它去清理新一轮的登记。
      if (generation !== this.startGeneration) return supersededStart();
      throw error;
    }
    // 解析期间被 stop 掉、或被更晚的一次启动顶替：绝不能再 spawn，否则这个进程既不会
    // 被记进 this.child（会被后者覆盖），也就再没人 kill 它。
    if (generation !== this.startGeneration) {
      return supersededStart();
    }
    // 兜底：真有存活的 child 时先收掉再 spawn，杜绝覆盖引用造成的泄漏。
    const staleChild = this.child;
    if (staleChild && !staleChild.killed) {
      this.child = null;
      staleChild.kill();
    }
    return new Promise<ListenerStartResult>((resolve) => {
      let settled = false;
      let stdoutBuffer = '';
      const child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      this.ready = false;

      let startTimer: NodeJS.Timeout | null = null;
      const settle = (result: ListenerStartResult): void => {
        if (settled) return;
        settled = true;
        if (startTimer) clearTimeout(startTimer);
        // spawn 之后才被作废的启动同样要标 superseded：stop() 会 kill 掉这个 child，
        // 随后的 exit 走到这里就是一条「启动失败」，而代次只在 spawn 之前查过一次。
        // 不标的话调用方会把它当真故障，去清理更晚一轮刚建立的登记（转发名单按 sender
        // id 记账，同一个设置页连续两轮录制共用一个 id，删掉就等于新一轮收不到 keys）。
        //
        // 成功的 ready 也要一起判：child 被 kill 的同时它可能刚把 ready 写进 stdout，缓冲区里
        // 那行随后才被读到。报成 { ok: true } 的话，recording:start 会留着转发登记、并告诉
        // 界面「capture 一切正常」，而 helper 其实已经没了 —— 用户按 Fn 毫无反应，只能关掉
        // 录制框重开。就绪状态同理：只认当前 child 报的 ready。
        const stale = generation !== this.startGeneration || this.child !== child;
        const outcome = stale ? supersededStart() : result;
        if (result.ok && !stale) this.ready = true;
        if (!result.ok && this.child === child) {
          this.child = null;
          this.ready = false;
          this.endActiveTriggerIfNeeded();
          this.resetState();
          if (!child.killed) child.kill();
          if (!options?.preserveShortcutOnFailure) {
            this.shortcut = null;
            this.clearRestartTimer();
            this.restartAttempts = 0;
          }
        }
        resolve(outcome);
      };

      startTimer = setTimeout(() => {
        settle({ ok: false, error: 'Modifier shortcut listener did not start.' });
      }, LISTENER_START_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line) {
            this.handlePayloadLine(line, child, settle);
          }
          newlineIndex = stdoutBuffer.indexOf('\n');
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        const text = chunk.trim();
        if (text) log.debug('modifier shortcut listener stderr', { text });
      });

      child.on('error', (error) => {
        if (settled) {
          log.warn('modifier shortcut listener process error', { error: error.message });
          return;
        }
        settle({ ok: false, error: error.message });
      });

      child.on('exit', (code, signal) => {
        const wasCurrentChild = this.child === child;
        if (this.child === child) {
          this.child = null;
          this.ready = false;
          this.endActiveTriggerIfNeeded();
          this.resetState();
        }
        if (!settled) {
          settle({
            ok: false,
            error: `Modifier shortcut listener exited before ready (${signal ?? code ?? 'unknown'}).`,
          });
          return;
        }
        log.debug('modifier shortcut listener exited', { code, signal });
        if (wasCurrentChild && this.shortcut) {
          this.scheduleRestart(code, signal);
        }
      });
    });
  }

  private handlePayloadLine(
    line: string,
    child: ListenerProcess,
    settle: (result: ListenerStartResult) => void,
  ): void {
    let payload: ListenerPayload;
    try {
      payload = JSON.parse(line) as ListenerPayload;
    } catch {
      log.debug('modifier shortcut listener emitted non-json line', { line });
      return;
    }

    if (payload.type === 'ready') {
      settle({ ok: true });
      log.info('modifier shortcut listener ready');
      return;
    }

    if (payload.type === 'error') {
      settle({
        ok: false,
        error: typeof payload.message === 'string' ? payload.message : 'Modifier shortcut listener failed.',
      });
      return;
    }

    if (payload.type === 'keys' && this.child === child) {
      const keys = Array.isArray(payload.keys)
        ? payload.keys.filter((key): key is string => typeof key === 'string')
        : [];
      this.options.onKeys?.(keys);
      this.handlePressedKeys(keys);
    }
  }

  private handlePressedKeys(keys: string[]): void {
    this.pressedKeys = new Set(keys);
    const shortcut = this.shortcut;
    if (!shortcut) return;
    if (isVoiceInputMacNativeKeyboardShortcut(shortcut)) {
      this.handleMacNativeKeyboardPressedKeys(keys, shortcut);
      return;
    }
    if (!isVoiceInputModifierShortcut(shortcut)) return;

    const shortcutCode = shortcut.code;
    const targetDown = this.pressedKeys.has(shortcutCode);
    const otherKeyDown = keys.some((key) => key !== shortcutCode);

    if (!targetDown) {
      const shouldTap = this.triggered && !this.holdThresholdReached && !this.canceledUntilRelease;
      const shouldEnd = this.triggered && this.holdThresholdReached;
      this.clearStartTimer();
      this.canceledUntilRelease = false;
      this.triggered = false;
      this.holdThresholdReached = false;
      if (shouldTap) {
        this.options.onTrigger('tap');
        return;
      }
      if (shouldEnd) {
        this.options.onTrigger('end');
      }
      return;
    }

    if (this.triggered) return;
    if (otherKeyDown) {
      this.canceledUntilRelease = true;
      this.clearStartTimer();
      return;
    }
    if (this.canceledUntilRelease || this.startTimer) return;

    this.triggered = true;
    this.holdThresholdReached = false;
    this.options.onTrigger('start');
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      const stillTargetOnly = this.pressedKeys.has(shortcutCode) &&
        Array.from(this.pressedKeys).every((key) => key === shortcutCode);
      if (!stillTargetOnly || this.canceledUntilRelease) return;
      this.holdThresholdReached = true;
    }, MODIFIER_SHORTCUT_HOLD_DELAY_MS);
  }

  private handleMacNativeKeyboardPressedKeys(keys: string[], shortcut: VoiceInputShortcut): void {
    const pressed = isVoiceInputMacNativeKeyboardShortcutPressed(keys, shortcut);
    const targetDown = isVoiceInputMacNativeKeyboardShortcutTargetDown(keys, shortcut);
    if (!pressed) {
      if (!this.keyboardShortcutPressed) {
        if (!targetDown) {
          this.canceledUntilRelease = false;
        }
        return;
      }
      const shouldTap = this.triggered && !this.holdThresholdReached && !this.canceledUntilRelease;
      const shouldEnd = this.triggered && this.holdThresholdReached;
      this.clearStartTimer();
      this.keyboardShortcutPressed = false;
      this.triggered = false;
      this.holdThresholdReached = false;
      if (shouldTap) {
        this.canceledUntilRelease = targetDown;
        this.options.onTrigger('tap');
        return;
      }
      if (shouldEnd) {
        this.canceledUntilRelease = targetDown;
        this.options.onTrigger('end');
        return;
      }
      if (targetDown) {
        this.canceledUntilRelease = true;
      } else {
        this.canceledUntilRelease = false;
      }
      return;
    }
    if (this.canceledUntilRelease) return;
    if (this.keyboardShortcutPressed) return;
    this.keyboardShortcutPressed = true;
    this.canceledUntilRelease = false;
    this.triggered = true;
    this.holdThresholdReached = false;
    this.options.onTrigger('start');
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (
        !this.keyboardShortcutPressed ||
        this.canceledUntilRelease ||
        !isVoiceInputMacNativeKeyboardShortcutPressed(Array.from(this.pressedKeys), shortcut)
      ) {
        return;
      }
      this.holdThresholdReached = true;
    }, MODIFIER_SHORTCUT_HOLD_DELAY_MS);
  }

  private resetState(): void {
    this.clearStartTimer();
    this.pressedKeys = new Set();
    this.triggered = false;
    this.holdThresholdReached = false;
    this.keyboardShortcutPressed = false;
    this.canceledUntilRelease = false;
  }

  private clearStartTimer(): void {
    if (!this.startTimer) return;
    clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private endActiveTriggerIfNeeded(): void {
    if (!this.triggered) return;
    this.triggered = false;
    this.options.onTrigger('end');
  }

  private scheduleRestart(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.shortcut || this.restartTimer) return;
    const shortcutLabel = getShortcutLogLabel(this.shortcut);
    if (this.restartAttempts >= LISTENER_RESTART_MAX_ATTEMPTS) {
      log.warn('modifier shortcut listener restart limit reached', {
        code,
        signal,
        shortcut: shortcutLabel,
      });
      return;
    }
    this.restartAttempts += 1;
    const delayMs = Math.min(
      LISTENER_RESTART_BASE_DELAY_MS * (2 ** (this.restartAttempts - 1)),
      LISTENER_RESTART_MAX_DELAY_MS,
    );
    log.warn('modifier shortcut listener exited unexpectedly; scheduling restart', {
      attempt: this.restartAttempts,
      code,
      signal,
      delayMs,
      shortcut: shortcutLabel,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.shortcut || this.child) return;
      void this.startChildProcess({ preserveShortcutOnFailure: true })
        .then((result) => {
          if (!result.ok) {
            log.warn('modifier shortcut listener restart failed', {
              attempt: this.restartAttempts,
              error: result.error,
              shortcut: this.shortcut ? getShortcutLogLabel(this.shortcut) : null,
            });
            this.scheduleRestart(null, null);
            return;
          }
          this.restartAttempts = 0;
          log.info('modifier shortcut listener restarted', {
            shortcut: this.shortcut ? getShortcutLogLabel(this.shortcut) : null,
          });
        })
        .catch((error: unknown) => {
          log.warn('modifier shortcut listener restart crashed', {
            attempt: this.restartAttempts,
            error: error instanceof Error ? error.message : String(error),
            shortcut: this.shortcut ? getShortcutLogLabel(this.shortcut) : null,
          });
          this.scheduleRestart(null, null);
        });
    }, delayMs);
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }
}

export async function getMacInputMonitoringPermissionSnapshot(): Promise<MacInputMonitoringPermissionSnapshot> {
  if (process.platform !== 'darwin') {
    return { ok: true, status: 'not-required' };
  }
  return runMacInputMonitoringPermissionCommand('--preflight-listen-event-access');
}

export async function requestMacInputMonitoringPermission(): Promise<MacInputMonitoringPermissionSnapshot> {
  if (process.platform !== 'darwin') {
    return { ok: true, status: 'not-required' };
  }
  return runMacInputMonitoringPermissionCommand('--request-listen-event-access');
}

function getShortcutLogLabel(shortcut: VoiceInputShortcut): string {
  const modifiers = [
    shortcut.modifiers.fn ? 'Fn' : '',
    shortcut.modifiers.ctrl ? 'Ctrl' : '',
    shortcut.modifiers.alt ? 'Alt' : '',
    shortcut.modifiers.shift ? 'Shift' : '',
    shortcut.modifiers.meta ? 'Meta' : '',
  ].filter(Boolean);
  return [shortcut.trigger === 'modifier' ? 'modifier' : 'keyboard', ...modifiers, shortcut.code].join('+');
}

async function resolveMacModifierShortcutListenerBinary(): Promise<string> {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, MAC_MODIFIER_SHORTCUT_LISTENER_RESOURCE);
  }
  await buildDevMacModifierShortcutListener();
  return getMacModifierShortcutListenerDevBinary();
}

async function buildDevMacModifierShortcutListener(): Promise<void> {
  const source = resolveDevMacModifierShortcutListenerSource();
  const binary = getMacModifierShortcutListenerDevBinary();
  if (!fs.existsSync(source)) {
    throw new Error(`Modifier shortcut listener source missing at ${source}`);
  }
  if (fs.existsSync(binary)) {
    const sourceMtimeMs = fs.statSync(source).mtimeMs;
    const binaryMtimeMs = fs.statSync(binary).mtimeMs;
    if (binaryMtimeMs >= sourceMtimeMs) return;
  }
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  await execFilePromise('swiftc', [source, '-o', binary], 10_000);
  fs.chmodSync(binary, 0o755);
  log.info('built dev macOS modifier shortcut listener', { path: binary });
}

function resolveDevMacModifierShortcutListenerSource(): string {
  const appPathSource = path.join(app.getAppPath(), MAC_MODIFIER_SHORTCUT_LISTENER_SOURCE_RELATIVE);
  if (fs.existsSync(appPathSource)) return appPathSource;
  return path.join(__dirname, '..', '..', MAC_MODIFIER_SHORTCUT_LISTENER_SOURCE_RELATIVE);
}

function getMacModifierShortcutListenerDevBinary(): string {
  return path.join(app.getPath('userData'), 'voice-input', 'xdt-macos-modifier-shortcut-listener');
}

async function runMacInputMonitoringPermissionCommand(command: string): Promise<MacInputMonitoringPermissionSnapshot> {
  try {
    const binary = await resolveMacModifierShortcutListenerBinary();
    const stdout = await execFileOutput(binary, [command], 3_000);
    const line = stdout
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find(Boolean);
    const payload = line ? JSON.parse(line) as ListenerPayload : null;
    if (payload?.type !== 'permission' || payload.permission !== 'input-monitoring') {
      return {
        ok: false,
        status: 'unknown',
        error: 'Input Monitoring permission status could not be read.',
      };
    }
    if (payload.granted === true) {
      return { ok: true, status: 'granted' };
    }
    return {
      ok: false,
      status: 'denied',
      error: 'Input Monitoring permission is required for Fn and single-modifier voice input shortcuts.',
    };
  } catch (error) {
    return {
      ok: false,
      status: 'unknown',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function execFilePromise(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve();
    });
  });
}

function execFileOutput(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
