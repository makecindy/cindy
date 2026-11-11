import { Button } from '@/components/ui/button';
/**
 * TerminalTabBody —— terminal tab 的 TabBody。
 *
 * 生命周期：
 *   1. 首次 mount：从 xtermPool 拿 Terminal 实例 → `terminal.open(slot)` → fit
 *      → state.created === false → IPC create PTY → patchState({ created: true })
 *      之后再次 mount 重挂 DOM + fit + focus，并 attach 检查离开期间的退出状态
 *   2. 用户输入 → xterm onData → IPC.terminal.write(id, data)
 *   3. PTY 输出 → main 推 terminal:data event → 自己按 id filter → terminal.write(chunk)
 *   4. PTY 退出 → state.exited 填上 → 渲染 overlay (退出码 + Restart 按钮)
 *      点 Restart → IPC.terminal.restart(id) → 清 state.exited
 *   5. 隐藏 / unmount：运行中的 PTY 继续接收输出；已退出的 xterm 转为快照
 *   6. 真正销毁(关 tab 触发 plugin.onBeforeClose)：disposeXterm + IPC.terminal.dispose
 *
 * resize：ResizeObserver 监听 slot 尺寸 → fitAddon.fit() → 拿 cols/rows → IPC.terminal.resize
 *
 * 错误显示：create / restart 失败 → 在 overlay 上显示 i18n 错误文案;不阻断 UI(用户可重试)
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RotateCw, ServerOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { ErrorNotice } from '@/components/ui/error-notice';
import { extractIpcError } from '@/utils/ipcError';
import { RemoteTerminalSetup } from './RemoteTerminalSetup';
import type { TabKindHostContext } from '../../types';
import { getOrCreateXterm, getXterm, detachXterm, getXtermExit, setXtermExit, onXtermExit, needsXtermAttach, attachXterm, restartXterm, releaseXtermConnection, type XtermEntry } from './lib/xtermPool';
import { createTerminalFontController } from './lib/terminalFont';
import { useTerminalFontSettings } from './lib/useTerminalFontSettings';
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  RemoteTerminalContext,
} from '../../../../../shared/terminal-bridge';
import { TERMINAL_RENDERER_INSTANCE_ID, type TerminalState } from './index';

interface Props {
  state: TerminalState;
  ctx: TabKindHostContext;
  active?: boolean;
  /** Keep the PTY at its last usable dimensions while the sidebar is collapsed. */
  shellVisible?: boolean;
}

interface RuntimeError {
  /** i18n key,渲染时 t() 一下。 */
  i18nKey: string;
  detail: string;
}

export function TerminalTabBody({ state, ctx, active, shellVisible = true }: Props) {
  // Unknown ownership must never pass a remote workdir to a local shell.
  if (ctx.deviceLinkDeviceId === undefined) return <RemoteTerminalUnavailable />;
  if (ctx.remoteHostId !== null || ctx.deviceLinkDeviceId !== null) {
    const contextKey = JSON.stringify([ctx.tabId, ctx.sessionId, ctx.deviceLinkDeviceId, ctx.remoteHostId]);
    return <RemoteTerminalSetup key={contextKey} state={state} ctx={ctx} active={active} shellVisible={shellVisible} />;
  }
  return <TerminalSessionBody state={state} ctx={ctx} active={active} shellVisible={shellVisible} />;
}

function RemoteTerminalUnavailable() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-w-0 select-none items-center justify-center gap-2.5 bg-[var(--panel-bg)] p-6 text-left text-[var(--text-tertiary)]">
      <ServerOff aria-hidden size={18} strokeWidth={1.6} />
      <div className="max-w-[300px]">
        <div className="text-13 font-medium leading-[1.384615] text-[var(--text-primary)]">
          {t('rightSidebar.terminal.remoteUnavailableTitle')}
        </div>
        <div className="mt-[3px] text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('rightSidebar.terminal.remoteUnavailableDescription')}
        </div>
      </div>
    </div>
  );
}

/** Local and SSH shells share the same xterm pool, IPC and tab lifecycle. */
export function TerminalSessionBody({ state, ctx, active, shellVisible = true, remote, onConnectionDisposed, onEditConnection, onPrepare }: Props & {
  remote?: RemoteTerminalContext & { ticket?: string };
  onConnectionDisposed?: () => void;
  onEditConnection?: () => void;
  onPrepare?: () => void;
}) {
  const { tabId, workdir, patchState } = ctx;
  const isRemote = Boolean(remote);
  const { t } = useTranslation();
  const { terminalFamily, terminalSize } = useTerminalFontSettings();

  const slotRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<XtermEntry | null>(null);
  // A pooled attachment outlives this body's exit subscription. Each new body
  // must attach once after subscribing: SSH replays missed exits, while local
  // create rejects an exited session so the error overlay offers restart.
  const attachedEntryRef = useRef<XtermEntry | null>(null);
  const exitRevisionRef = useRef(0);
  const fontControllerRef = useRef<ReturnType<typeof createTerminalFontController> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  /** xterm onData 的 disposer,unmount 时解订阅避免内存泄漏。 */
  const onDataDisposerRef = useRef<{ dispose(): void } | null>(null);
  /** 标记本组件实例是否还活着,异步 callback 里检查。 */
  const aliveRef = useRef(true);
  const shellVisibleRef = useRef(shellVisible);
  shellVisibleRef.current = shellVisible;
  const [exited, setRuntimeExit] = useState(() => getXtermExit(tabId) ?? state.exited);
  const [attachmentPending, setAttachmentPending] = useState(() => needsXtermAttach(tabId));

  const [runtimeError, setRuntimeError] = useState<RuntimeError | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [creating, setCreating] = useState(false);
  // SSH setup owns the entry while mounted; unmount still snapshots exited SSH tabs.
  const suspended = !isRemote && exited !== null && !restarting && !attachmentPending && (active === false || !shellVisible);

  // The initiating view can unmount before restart fails. The pool's rollback
  // must reach whichever view now owns the tab, even if its DOM is suspended.
  useLayoutEffect(() => onXtermExit(tabId, setRuntimeExit), [tabId]);

  // ─── 1. xterm DOM 挂载 + IPC data/exit 订阅 ───
  // 用 useLayoutEffect 确保 paint 前 DOM 已经 attach,避免首帧空白
  useLayoutEffect(() => {
    aliveRef.current = true;
    const slot = slotRef.current;
    if (!slot || suspended) return;

    const entry = getOrCreateXterm(tabId);
    entryRef.current = entry;

    // 首次 open 把 xterm DOM 绑到 slot。之后 mount(同 tab 切走再切回)需要把
    // xterm 内部的 root element 重新 append 到当前 slot —— xterm 自己不维护
    // pool DOM,我们手动处理。
    const rootEl = (entry.terminal.element as HTMLElement | undefined);
    if (rootEl && rootEl.parentElement !== slot) {
      slot.appendChild(rootEl);
    } else if (!rootEl) {
      entry.terminal.open(slot);
    }

    // 订阅 xterm 用户输入 → 推给 main
    onDataDisposerRef.current = entry.terminal.onData((data: string) => {
      void window.electronAPI.terminal.write(tabId, data).catch((err) => {
        console.warn('[terminal] write failed', err);
      });
    });

    // A cleaned-up subscription must stay inactive even if this body's next
    // layout effect makes aliveRef true again.
    let subscribed = true;
    // 订阅 main 推过来的 PTY 输出 / 退出,按 tabId filter
    const offData = window.electronAPI.terminal.onData((evt: unknown) => {
      const data = evt as TerminalDataEvent;
      if (!subscribed || !aliveRef.current || data.id !== tabId) return;
      entry.terminal.write(data.chunk);
    });
    const offExit = window.electronAPI.terminal.onExit((evt: unknown) => {
      const ex = evt as TerminalExitEvent;
      if (!subscribed || !aliveRef.current || ex.id !== tabId) return;
      exitRevisionRef.current += 1;
      setXtermExit(tabId, ex.exit);
      setRuntimeExit(ex.exit);
      patchState({
        rendererInstanceId: TERMINAL_RENDERER_INSTANCE_ID,
        // Persistence rollback does not undo this body's completed attach.
        // An exit during create must not cancel the pending create effect.
        ...(entry.ptyAttached && attachedEntryRef.current === entry ? { created: true } : {}),
        exited: ex.exit,
      });
    });

    fontControllerRef.current = createTerminalFontController(
      entry.terminal,
      () => activeRef.current !== false && shellVisibleRef.current && hasSize(slot),
      () => fitAndPushSize(entry, tabId, slot, isRemote),
    );

    // 折叠侧栏或隐藏页签时保留最后可用尺寸，恢复可见后再测量。
    if (activeRef.current !== false && shellVisibleRef.current) fitNow(entry, slot);
    void entry.restored?.then(() => {
      if (subscribed && aliveRef.current && entryRef.current === entry && activeRef.current !== false && shellVisibleRef.current) {
        fitAndPushSize(entry, tabId, slot, isRemote);
      }
    });

    return () => {
      subscribed = false;
      aliveRef.current = false;
      fontControllerRef.current?.dispose();
      fontControllerRef.current = null;
      onDataDisposerRef.current?.dispose();
      onDataDisposerRef.current = null;
      offData();
      offExit();
      entryRef.current = null;
      detachXterm(tabId);
      // A running PTY retains its view; an exited one keeps a compact ANSI snapshot.
    };
  }, [tabId, patchState, isRemote, suspended]);

  // Font changes are independent from the DOM/PTY lifecycle and never focus the terminal.
  useEffect(() => {
    fontControllerRef.current?.update({ terminalFamily, terminalSize });
  }, [terminalFamily, terminalSize, tabId, patchState, suspended]);

  // ─── 2. PTY 创建 / 跨窗口 re-attach ───
  // 本 body 尚未 attach，或 pool 已失去 attachment 时创建 / re-attach:
  //      state.created 仅用于判断成功后的状态补写，持久化回滚不代表 attachment 失效。
  //      切回任务时补收退出状态；侧边栏宿主在"内嵌 ↔ 独立子窗口"间迁移时,
  //      PTY 在 main 仍活着但输出 sink 绑在旧窗口的 webContents 上。
  //      ptyManager.create 是幂等 attach、可换 owner —— 再调一次把 sink 切到本窗口,
  //      输入输出即恢复(xterm scrollback 是 per-renderer 的,迁移后丢失可接受)。
  useEffect(() => {
    if (restarting || suspended) return;
    const entry = entryRef.current;
    if (!entry) return;
    let cancelled = false;
    let pending = false;
    let needsAttach = true;
    const attach = () => {
      if (cancelled || entry.closing || pending || !needsAttach) return;
      if (entry.ptyAttached && attachedEntryRef.current === entry) {
        setAttachmentPending(false);
        if (isRemote) setCreating(false);
        return;
      }
      const isReattach = state.created;
      pending = true;
      setAttachmentPending(true);
      const previousExit = getXtermExit(tabId);
      // A result skipped during close is not a completed attachment, even when
      // this body attached the same pooled entry before an earlier invalidation.
      attachedEntryRef.current = null;
      const { cols, rows } = entry.lastSize;
      if (isRemote) setCreating(true);
      const fallbackCwd = workdir || (typeof process !== 'undefined' && process.env?.HOME) || '/';
      // For SSH, discard hydrated exit state, then reconcile on completion: a late
      // canonical snapshot can restore it while the IPC is pending. A real exit
      // delivered during this request always wins over that cleanup.
      const exitRevision = exitRevisionRef.current;
      if (isRemote && state.exited != null) patchState({ exited: null });
      // Keep the launch identity in the pool across task/window unmounts. A mirror
      // index may disappear before close; never retain a short-lived ticket here.
      if (remote) entry.remoteContext = { sessionId: remote.sessionId, deviceId: remote.deviceId ?? null };
      // Layout subscriptions above are installed before this ownership handoff.
      const request = attachXterm({
        id: tabId, cwd: fallbackCwd, cols, rows,
        ...(remote ? { remote } : {}),
      });
      void request.then((result) => {
        pending = false;
        if (cancelled || !aliveRef.current || entry.closing) return;
        needsAttach = false;
        if (isRemote) setCreating(false);
        entry.ptyAttached = true;
        attachedEntryRef.current = entry;
        setAttachmentPending(false);
        const clearStaleExit = exitRevisionRef.current === exitRevision;
        if (clearStaleExit) {
          setXtermExit(tabId, null);
          setRuntimeExit(null);
        }
        if (remote && entry.remoteDraft?.submitted && entry.remoteDraft.contextKey === JSON.stringify([ctx.sessionId, ctx.deviceLinkDeviceId, ctx.remoteHostId])) {
          entry.remoteDraft = undefined;
        }
        // A hidden view has no measured size yet. Keep the old PTY dimensions
        // until this view becomes visible, then synchronize its first fit.
        const slot = slotRef.current;
        if (isRemote) {
          if (activeRef.current !== false && shellVisibleRef.current && slot) fitAndPushSize(entry, tabId, slot, true);
        } else if (entry.lastSize.cols !== cols || entry.lastSize.rows !== rows) {
          void window.electronAPI.terminal.resize(tabId, entry.lastSize.cols, entry.lastSize.rows).catch(() => undefined);
        }
        if (!isReattach) {
          patchState({
            rendererInstanceId: TERMINAL_RENDERER_INSTANCE_ID,
            created: true,
            shellId: result.shellId,
            shellDisplayName: result.shellDisplayName,
            ...(clearStaleExit ? { exited: null } : {}),
          });
        } else if (isRemote && clearStaleExit) {
          patchState({ exited: null });
        }
        setRuntimeError(null);
      }).catch((err: unknown) => {
        pending = false;
        if (cancelled || !aliveRef.current || entry.closing) return;
        needsAttach = false;
        setAttachmentPending(false);
        if (isRemote) setCreating(false);
        if (previousExit && /terminal session already exists \(exited\)/.test(String(err))) {
          entry.ptyAttached = true;
          attachedEntryRef.current = entry;
          setRuntimeError(null);
        } else if (isRemote && extractIpcError(err)?.code === 'PRECONDITION_FAILED') {
          entry.ptyAttached = false;
          if (state.created) patchState({ created: false, exited: null });
          onPrepare?.();
        } else {
          setRuntimeError(parseError(err));
        }
      });
    };
    // Subscribe even when mounting during close. Rollback resumes skipped work;
    // an in-flight request finishes normally without a duplicate create/restart.
    entry.closeCancelledListeners.add(attach);
    attach();
    return () => {
      cancelled = true;
      entry.closeCancelledListeners.delete(attach);
    };
  }, [state.created, suspended, tabId, workdir, patchState, remote, isRemote, onPrepare]);

  // ─── 3. ResizeObserver → fit → IPC resize ───
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const ro = new ResizeObserver(() => {
      const entry = entryRef.current;
      if (!entry || !aliveRef.current || !shellVisibleRef.current || activeRef.current === false || !hasSize(slot)) return;
      if (!fontControllerRef.current?.flush()) fitAndPushSize(entry, tabId, slot, isRemote);
    });
    ro.observe(slot);
    return () => ro.disconnect();
  }, [tabId, isRemote]);

  // ─── 4. active 切换时 fit + focus(避免后台 layout 抖动)───
  useEffect(() => {
    if (!active || !shellVisible) return;
    const entry = entryRef.current;
    if (!entry) return;
    // 切到本 tab 时 fit 一下,因为后台 tab 的 layout 可能没跟上侧栏宽度变化
    const frame = requestAnimationFrame(() => {
      const slot = slotRef.current;
      if (!aliveRef.current || entryRef.current !== entry || !shellVisibleRef.current || activeRef.current === false || !slot || !hasSize(slot)) return;
      if (!fontControllerRef.current?.flush()) fitAndPushSize(entry, tabId, slot, isRemote);
      entry.terminal.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, shellVisible, tabId, isRemote]);

  // ─── 5. Restart 按钮 handler ───
  const onRestart = useCallback(async () => {
    if (restarting) return;
    // Persisted created can roll back after both attach and exit writes fail.
    // The pool owns whether there is an existing PTY to restart.
    if (remote && !entryRef.current?.ptyAttached) {
      onPrepare?.();
      return;
    }
    const entry = entryRef.current;
    setRestarting(true);
    setRuntimeError(null);
    try {
      const result = await restartXterm({
        id: tabId,
        cwd: workdir || (typeof process !== 'undefined' && process.env?.HOME) || '/',
        ...entry?.lastSize,
        ...(remote ? { remote } : {}),
      }, () => aliveRef.current && entryRef.current === entry);
      if (!aliveRef.current || !entry || entry.closing || entryRef.current !== entry) return;
      setRuntimeExit(getXtermExit(tabId));
      // The exited PTY ignored font-driven resizes. Restart uses its old grid,
      // so resend the latest usable size even when the renderer has not changed.
      // Do not measure a hidden or collapsed panel just to synchronize restart.
      if (entry && entryRef.current === entry) {
        entry.ptyAttached = true;
        attachedEntryRef.current = entry;
        const { cols, rows } = entry.lastSize;
        if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
          void window.electronAPI.terminal.resize(tabId, cols, rows).catch(() => undefined);
        }
      }
      patchState({
        rendererInstanceId: TERMINAL_RENDERER_INSTANCE_ID,
        created: true,
        shellId: result.shellId,
        shellDisplayName: result.shellDisplayName,
        exited: null,
      });
      // xterm 自身的 scrollback 保留;新 PTY 输出会继续 append
    } catch (err) {
      if (!aliveRef.current) return;
      if (remote && extractIpcError(err)?.code === 'TERMINAL_NOT_FOUND') {
        if (entry) entry.ptyAttached = false;
        patchState({ created: false, exited: null });
        onPrepare?.();
      } else {
        setRuntimeError(parseError(err));
      }
    } finally {
      if (aliveRef.current) setRestarting(false);
    }
  }, [restarting, tabId, workdir, patchState, remote, onPrepare]);

  const editConnection = useCallback(async () => {
    if (!onEditConnection || restarting) return;
    const entry = entryRef.current;
    if (!entry || entry.closing) return;
    setRestarting(true);
    try {
      // Even an exited PTY remains registered in main until explicitly disposed.
      // The pool commits intent on the original nonclosing entry, even if this
      // body unmounts; rejected release retains the old connection and exit.
      await releaseXtermConnection(tabId, () => onConnectionDisposed?.());
      if (!aliveRef.current || getXterm(tabId) !== entry || entry.closing) return;
      onEditConnection();
      patchState({ created: false, exited: null });
    } catch (err) {
      if (aliveRef.current) setRuntimeError(parseError(err));
    } finally {
      if (aliveRef.current) setRestarting(false);
    }
  }, [onConnectionDisposed, onEditConnection, restarting, tabId, patchState]);

  // 渲染:slot 撑满,exited / runtimeError 在上面叠一层 overlay
  return (
    <div className="relative h-full w-full bg-[#1c1c1c]">
      <div ref={slotRef} className="absolute top-2 bottom-0 left-2 right-2" />
      {isRemote && (creating || (restarting && !state.created)) && !runtimeError && (
        <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-13 text-[var(--text-secondary)]">
            <Spinner size={14} aria-hidden />
            {t('settings.remote.status.connecting')}
          </div>
        </div>
      )}
      {exited != null && !runtimeError && (
        <ExitedOverlay
          exit={exited}
          restarting={restarting}
          onRestart={onRestart}
          onEditConnection={onEditConnection ? editConnection : undefined}
          t={t}
        />
      )}
      {runtimeError != null && (
        <ErrorOverlay
          message={t(runtimeError.i18nKey, { detail: runtimeError.detail })}
          restarting={restarting}
          onRetry={onRestart}
          onEditConnection={onEditConnection ? editConnection : undefined}
          t={t}
        />
      )}
    </div>
  );
}

// ───────── helpers ─────────

function hasSize(slot: HTMLElement): boolean {
  return slot.clientWidth > 0 && slot.clientHeight > 0;
}

function fitNow(entry: XtermEntry, slot: HTMLElement): boolean {
  if (entry.restored || !hasSize(slot)) return false;
  try {
    const proposed = entry.fitAddon.proposeDimensions();
    if (!proposed || proposed.cols < 1 || proposed.rows < 1) return false;
    entry.fitAddon.fit();
    const { cols, rows } = entry.terminal;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return false;
    entry.lastSize = { cols, rows };
    return true;
  } catch {
    return false;
  }
}

function fitAndPushSize(entry: XtermEntry, tabId: string, slot: HTMLElement, force = false): void {
  const previous = entry.lastSize;
  if (!fitNow(entry, slot)) return;
  const { cols, rows } = entry.lastSize;
  if (cols === previous.cols && rows === previous.rows && !force) return;

  // create/reattach will reconcile these dimensions once it has an owner.
  if (!entry.ptyAttached) return;
  void window.electronAPI.terminal.resize(tabId, cols, rows).catch(() => {
    /* 已 disposed 的 session 静默忽略 */
  });
}

function parseError(err: unknown): RuntimeError {
  const message = err instanceof Error ? err.message : String(err);
  if (/TERMINAL_SHELL_NOT_FOUND/.test(message)) {
    return { i18nKey: 'rightSidebar.terminal.shellNotFound', detail: message };
  }
  if (/TERMINAL_SPAWN_FAILED/.test(message)) {
    return { i18nKey: 'rightSidebar.terminal.spawnFailed', detail: message };
  }
  return { i18nKey: 'rightSidebar.terminal.spawnFailed', detail: message };
}

function ExitedOverlay({
  exit,
  restarting,
  onRestart,
  onEditConnection,
  t,
}: {
  exit: { code: number | null; signal: string | null };
  restarting: boolean;
  onRestart: () => void;
  onEditConnection?: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const message = exit.signal
    ? t('rightSidebar.terminal.processKilled', { signal: exit.signal })
    : t('rightSidebar.terminal.processExited', { code: exit.code ?? (onEditConnection ? '—' : 0) });
  return (
    <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-6">
      <div role="status" className="pointer-events-auto flex max-h-full max-w-[90%] flex-wrap items-center justify-center gap-3 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm text-[var(--text-primary)] shadow-[shadow:var(--shadow-menu)]">
        <span className="min-w-0 break-words">{message}</span>
        <Button
          variant="secondary"
          size="xs"
          compact
          loading={restarting}
          type="button"
          onClick={onRestart}
          disabled={restarting}
        >
          <Spinner icon={RotateCw} size={12} spinning={restarting} />
          {t('rightSidebar.terminal.restart')}
        </Button>
        {onEditConnection && <Button type="button" variant="secondary" size="xs" compact disabled={restarting} onClick={onEditConnection}>
          {t('rightSidebar.terminal.remote.editConnection')}
        </Button>}
      </div>
    </div>
  );
}

function ErrorOverlay({
  message,
  restarting,
  onRetry,
  onEditConnection,
  t,
}: {
  message: string;
  restarting: boolean;
  onRetry: () => void;
  onEditConnection?: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
      <ErrorNotice
        role="alert"
        className="pointer-events-auto max-h-full min-w-0 max-w-full overflow-y-auto [overflow-wrap:anywhere]"
        message={message}
        actions={<>
          <Button
            variant="secondary"
            size="xs"
            compact
            loading={restarting}
            type="button"
            onClick={onRetry}
            disabled={restarting}
          >
            <Spinner icon={RotateCw} size={12} spinning={restarting} />
            {t('rightSidebar.terminal.restart')}
          </Button>
          {onEditConnection && <Button type="button" variant="secondary" size="xs" compact disabled={restarting} onClick={onEditConnection}>
            {t('rightSidebar.terminal.remote.editConnection')}
          </Button>}
        </>}
      />
    </div>
  );
}
