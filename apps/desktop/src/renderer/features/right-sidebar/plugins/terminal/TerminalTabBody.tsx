import { Button } from '@/components/ui/button';
/**
 * TerminalTabBody —— terminal tab 的 TabBody。
 *
 * 生命周期：
 *   1. 首次 mount：从 xtermPool 拿 Terminal 实例 → `terminal.open(slot)` → fit
 *      → state.created === false → IPC create PTY → patchState({ created: true })
 *      之后再次 mount(用户切回此 tab)只重挂 DOM + 重新 fit + focus，不重建 PTY
 *   2. 用户输入 → xterm onData → IPC.terminal.write(id, data)
 *   3. PTY 输出 → main 推 terminal:data event → 自己按 id filter → terminal.write(chunk)
 *   4. PTY 退出 → state.exited 填上 → 渲染 overlay (退出码 + Restart 按钮)
 *      点 Restart → IPC.terminal.restart(id) → 清 state.exited
 *   5. unmount(切走 / 整个 RSB 关）：仅离开 DOM，xterm 实例和 PTY 都保活
 *   6. 真正销毁(关 tab 触发 plugin.onBeforeClose)：disposeXterm + IPC.terminal.dispose
 *
 * resize：ResizeObserver 监听 slot 尺寸 → fitAddon.fit() → 拿 cols/rows → IPC.terminal.resize
 *
 * 错误显示：create / restart 失败 → 在 overlay 上显示 i18n 错误文案;不阻断 UI(用户可重试)
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RotateCw, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import type { TabKindHostContext } from '../../types';
import { getOrCreateXterm, type XtermEntry } from './lib/xtermPool';
import type {
  TerminalDataEvent,
  TerminalExitEvent,
} from '../../../../../shared/terminal-bridge';
import type { TerminalState } from './index';

interface Props {
  state: TerminalState;
  ctx: TabKindHostContext;
  active?: boolean;
}

interface RuntimeError {
  /** i18n key,渲染时 t() 一下。 */
  i18nKey: string;
  detail: string;
}

export function TerminalTabBody({ state, ctx, active }: Props) {
  const { tabId, workdir, patchState } = ctx;
  const { t } = useTranslation();

  const slotRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<XtermEntry | null>(null);
  /** xterm onData 的 disposer,unmount 时解订阅避免内存泄漏。 */
  const onDataDisposerRef = useRef<{ dispose(): void } | null>(null);
  /** 标记本组件实例是否还活着,异步 callback 里检查。 */
  const aliveRef = useRef(true);

  const [runtimeError, setRuntimeError] = useState<RuntimeError | null>(null);
  const [restarting, setRestarting] = useState(false);

  // ─── 1. xterm DOM 挂载 + IPC data/exit 订阅 ───
  // 用 useLayoutEffect 确保 paint 前 DOM 已经 attach,避免首帧空白
  useLayoutEffect(() => {
    aliveRef.current = true;
    const slot = slotRef.current;
    if (!slot) return;

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

    // 订阅 main 推过来的 PTY 输出 / 退出,按 tabId filter
    const offData = window.electronAPI.terminal.onData((evt: unknown) => {
      const data = evt as TerminalDataEvent;
      if (!aliveRef.current || data.id !== tabId) return;
      entry.terminal.write(data.chunk);
    });
    const offExit = window.electronAPI.terminal.onExit((evt: unknown) => {
      const ex = evt as TerminalExitEvent;
      if (!aliveRef.current || ex.id !== tabId) return;
      patchState({ exited: ex.exit });
    });

    // 首次 fit + 拿到尺寸
    fitNow(entry);

    return () => {
      aliveRef.current = false;
      onDataDisposerRef.current?.dispose();
      onDataDisposerRef.current = null;
      offData();
      offExit();
      // xterm 实例和 PTY 都保活,这里仅 detach DOM 不 dispose
    };
  }, [tabId, patchState]);

  // ─── 2. PTY 创建 / 跨窗口 re-attach ───
  // 两种进入条件:
  //   a) state.created === false:首次创建 PTY
  //   b) state.created === true 但本 renderer 的 xterm entry 从未 attach 过
  //      (entry.ptyAttached === false):侧边栏宿主在"内嵌 ↔ 独立子窗口"间迁移,
  //      PTY 在 main 仍活着但输出 sink 绑在旧窗口的 webContents 上。
  //      ptyManager.create 是幂等 attach、可换 owner —— 再调一次把 sink 切到本窗口,
  //      输入输出即恢复(xterm scrollback 是 per-renderer 的,迁移后丢失可接受)。
  useEffect(() => {
    if (restarting) return;
    const entry = entryRef.current;
    if (!entry) return;
    if (state.created && entry.ptyAttached) return;
    const isReattach = state.created;
    let cancelled = false;
    const { cols, rows } = entry.lastSize;
    const fallbackCwd = workdir || (typeof process !== 'undefined' && process.env?.HOME) || '/';
    void window.electronAPI.terminal
      .create({
        id: tabId,
        cwd: fallbackCwd,
        cols,
        rows,
        // 不传 shellPref → main 端读取 Settings 中持久化的默认 shell。
      })
      .then((result) => {
        if (cancelled || !aliveRef.current) return;
        entry.ptyAttached = true;
        // re-attach 路径不重复 patchState —— 持久化字段没变,写一遍只是无谓 IPC。
        if (!isReattach) {
          patchState({
            created: true,
            shellId: result.shellId,
            shellDisplayName: result.shellDisplayName,
            exited: null,
          });
        }
        setRuntimeError(null);
      })
      .catch((err: unknown) => {
        if (cancelled || !aliveRef.current) return;
        setRuntimeError(parseError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [state.created, restarting, tabId, workdir, patchState]);

  // ─── 3. ResizeObserver → fit → IPC resize ───
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const ro = new ResizeObserver(() => {
      const entry = entryRef.current;
      if (!entry || !aliveRef.current) return;
      fitAndPushSize(entry, tabId);
    });
    ro.observe(slot);
    return () => ro.disconnect();
  }, [tabId]);

  // ─── 4. active 切换时 fit + focus(避免后台 layout 抖动)───
  useEffect(() => {
    if (!active) return;
    const entry = entryRef.current;
    if (!entry) return;
    // 切到本 tab 时 fit 一下,因为后台 tab 的 layout 可能没跟上侧栏宽度变化
    requestAnimationFrame(() => {
      if (!aliveRef.current || !entryRef.current) return;
      fitAndPushSize(entryRef.current, tabId);
      entryRef.current.terminal.focus();
    });
  }, [active, tabId]);

  // ─── 5. Restart 按钮 handler ───
  const onRestart = useCallback(async () => {
    if (restarting) return;
    setRestarting(true);
    setRuntimeError(null);
    try {
      const result = await window.electronAPI.terminal.restart(tabId);
      if (!aliveRef.current) return;
      patchState({
        created: true,
        shellId: result.shellId,
        shellDisplayName: result.shellDisplayName,
        exited: null,
      });
      // xterm 自身的 scrollback 保留;新 PTY 输出会继续 append
    } catch (err) {
      if (!aliveRef.current) return;
      setRuntimeError(parseError(err));
    } finally {
      if (aliveRef.current) setRestarting(false);
    }
  }, [restarting, tabId, patchState]);

  // 渲染:slot 撑满,exited / runtimeError 在上面叠一层 overlay
  return (
    <div className="relative h-full w-full bg-[#1c1c1c]">
      <div ref={slotRef} className="absolute top-2 bottom-0 left-2 right-2" />
      {state.exited != null && !runtimeError && (
        <ExitedOverlay
          exit={state.exited}
          restarting={restarting}
          onRestart={onRestart}
          t={t}
        />
      )}
      {runtimeError != null && (
        <ErrorOverlay
          message={t(runtimeError.i18nKey, { detail: runtimeError.detail })}
          restarting={restarting}
          onRetry={onRestart}
          t={t}
        />
      )}
    </div>
  );
}

// ───────── helpers ─────────

function fitNow(entry: XtermEntry): void {
  try {
    entry.fitAddon.fit();
    entry.lastSize = { cols: entry.terminal.cols, rows: entry.terminal.rows };
  } catch {
    /* slot 可能还没尺寸,忽略 */
  }
}

function fitAndPushSize(entry: XtermEntry, tabId: string): void {
  try {
    entry.fitAddon.fit();
  } catch {
    return;
  }
  const cols = entry.terminal.cols;
  const rows = entry.terminal.rows;
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
  if (cols === entry.lastSize.cols && rows === entry.lastSize.rows) return;
  entry.lastSize = { cols, rows };
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
  t,
}: {
  exit: { code: number | null; signal: string | null };
  restarting: boolean;
  onRestart: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const message = exit.signal
    ? t('rightSidebar.terminal.processKilled', { signal: exit.signal })
    : t('rightSidebar.terminal.processExited', { code: exit.code ?? 0 });
  return (
    <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-6">
      <div className="pointer-events-auto flex items-center gap-3 rounded-md border border-white/15 bg-black/80 px-4 py-2 text-sm text-white shadow-lg backdrop-blur">
        <span>{message}</span>
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
      </div>
    </div>
  );
}

function ErrorOverlay({
  message,
  restarting,
  onRetry,
  t,
}: {
  message: string;
  restarting: boolean;
  onRetry: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="pointer-events-auto flex max-w-[90%] flex-col items-center gap-2 rounded-md border border-white/15 bg-black/80 px-4 py-3 text-sm text-white shadow-lg backdrop-blur">
        <div className="flex items-center gap-2 text-red-300">
          <AlertTriangle size={14} />
          <span>{message}</span>
        </div>
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
      </div>
    </div>
  );
}
