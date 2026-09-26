import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { BackgroundTaskOutputTailResult } from '../../../shared/backgroundTaskOutput';
import { readBackgroundTaskOutputTailFor } from '@/lib/makerTransport';

/** 运行中每秒刷新一次运行时长。 */
const ELAPSED_TICK_MS = 1000;
/** 展开区在任务运行中轮询输出文件的间隔。 */
const OUTPUT_TAIL_POLL_MS = 2000;
/** 展开区最多显示的输出行数。 */
export const OUTPUT_TAIL_MAX_LINES = 12;

/**
 * 运行时长(ms)→ 紧凑展示,始终显示秒:`9s` / `5m 09s` / `2h 05m 09s`。
 * 秒(及小时档的分)补零两位,避免每秒 tick 时宽度抖动。
 */
export function formatTaskElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${ss}s`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${s}s`;
}

export function parseTaskTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** enabled 时每 intervalMs 返回一次新的 Date.now();关闭时停在最后一次的值。 */
export function useNowTicker(enabled: boolean, intervalMs = ELAPSED_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}

/**
 * 运行中任务的实时运行时长。单独成组件,每秒 tick 只重渲染这一小段文字,
 * 不带动整张任务卡。
 */
export function RunningElapsed({ startedAtMs }: { startedAtMs: number }) {
  const { t } = useTranslation();
  const now = useNowTicker(true);
  return (
    <span data-agent-task-elapsed="running" className="tabular-nums">
      {t('chat.agentTask.runningFor', { duration: formatTaskElapsed(now - startedAtMs) })}
    </span>
  );
}

/**
 * 去掉终端控制序列并按回车折叠进度条式覆盖输出,取最后若干行。
 * `\r` 覆盖写(进度条)只保留最后一次写入的内容。
 */
export function tailOutputLines(text: string, maxLines = OUTPUT_TAIL_MAX_LINES): string[] {
  // eslint-disable-next-line no-control-regex
  const withoutAnsi = text.replace(
    /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g,
    '',
  );
  const lines = withoutAnsi.split('\n').map((line) => {
    const segments = line.split('\r').filter((segment) => segment.length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : '';
  });
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-maxLines);
}

/**
 * 读取后台命令输出尾部。enabled 时立即读一次;running 期间按固定间隔轮询,
 * 终态只读一次。关闭(收起 / 卸载)即停止,不在后台空转。
 */
export function useBackgroundTaskOutputTail(
  sessionId: string | undefined,
  outputFile: string | undefined,
  { enabled, running }: { enabled: boolean; running: boolean },
): BackgroundTaskOutputTailResult | undefined {
  const [result, setResult] = useState<BackgroundTaskOutputTailResult | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !sessionId || !outputFile) return;
    let disposed = false;
    let inFlight = false;
    const read = () => {
      if (inFlight) return;
      inFlight = true;
      void readBackgroundTaskOutputTailFor(sessionId, outputFile)
        .then((next) => {
          if (!disposed) setResult(next);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    read();
    if (!running) {
      return () => {
        disposed = true;
      };
    }
    const id = setInterval(read, OUTPUT_TAIL_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, [enabled, running, sessionId, outputFile]);
  return result;
}

interface BackgroundCommandDetailsProps {
  sessionId?: string;
  command?: string;
  startedAtMs?: number;
  outputFile?: string;
  running: boolean;
  /** 展开区可见时才读取输出,收起即停止轮询。 */
  expanded: boolean;
}

/**
 * 后台命令卡展开区:实际命令、开始时间与输出文件末尾。运行中持续刷新最近输出和
 * 「更新于 N 前」,让用户判断命令是否仍在推进,而不是只看一个转圈图标。
 */
export function BackgroundCommandDetails({
  sessionId,
  command,
  startedAtMs,
  outputFile,
  running,
  expanded,
}: BackgroundCommandDetailsProps) {
  const { t } = useTranslation();
  const tail = useBackgroundTaskOutputTail(sessionId, outputFile, {
    enabled: expanded,
    running,
  });
  const now = useNowTicker(expanded && running);
  const lines = tail?.ok ? tailOutputLines(tail.text) : [];
  const startedAtLabel =
    startedAtMs !== undefined
      ? new Date(startedAtMs).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : undefined;

  return (
    <div data-background-command-details="true" className="mb-1 flex flex-col gap-1.5">
      {command && (
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--surface-chip)] px-2 py-1 font-mono text-12 leading-4 text-[var(--text-primary)]">
          {command}
        </pre>
      )}
      {startedAtLabel && (
        <p className="text-12 leading-4 text-[var(--text-tertiary)]">
          {t('chat.agentTask.startedAt', { time: startedAtLabel })}
        </p>
      )}
      {tail?.ok && (
        <div data-background-command-output="true">
          <p className="mb-0.5 text-12 leading-4 text-[var(--text-tertiary)]">
            {lines.length === 0
              ? t('chat.agentTask.noOutputYet')
              : t('chat.agentTask.recentOutput', {
                  time: formatTaskElapsed(Math.max(0, (running ? now : Date.now()) - tail.mtimeMs)),
                })}
          </p>
          {lines.length > 0 && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--surface-chip)] px-2 py-1 font-mono text-12 leading-4 text-[var(--text-secondary)]">
              {lines.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
