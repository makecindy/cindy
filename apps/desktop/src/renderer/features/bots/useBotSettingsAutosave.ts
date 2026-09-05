/**
 * useBotSettingsAutosave — 把 botSettingsAutosave 的调度语义接到 React 设置页上。
 *
 * 职责边界:纯逻辑(防抖 / 合并 / 脏检查 / 串行化)全在 botSettingsAutosave.ts;
 * 这里只做三件 React 侧的事:
 *  1. 用 ref 把「当前草稿」与「上次成功保存的基线」暴露给调度器(调度器在 timer
 *     回调里跑,拿不到渲染闭包里的最新值)。
 *  2. 把提交结果翻译成可观测状态(saving / saved / error),`saved` 短暂显示后淡出。
 *  3. 卸载时冲刷未落的保存 —— 这是本次改动的关键:保存条删了,离开页面不能丢改动。
 *
 * 保存载荷与 IPC 与手动保存时**完全一致**,主进程零改动。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createBotSettingsAutosave,
  normalizeBotSettingsPayload,
  type BotAutosaveStatus,
  type BotAutosaveTrigger,
  type BotSettingsAutosaveHandle,
  type BotSettingsDraft,
  type BotSettingsPayload,
} from './botSettingsAutosave';

/** `saved` 勾在多久后淡出。常驻的「已保存」是噪音,不是信息。 */
const SAVED_HOLD_MS = 1800;

export interface UseBotSettingsAutosaveOptions {
  /** 当前草稿(每次渲染传最新值即可,内部走 ref)。 */
  draft: BotSettingsDraft;
  /** 名字被清空时的兜底名(沿用手动保存时的 `bot.name`)。 */
  fallbackName: string;
  /** 是否允许写入。归档 bot 等只读场景传 false,连脏检查都不做。 */
  enabled: boolean;
  /** 真正提交。成功 resolve;失败 reject。基线由本 hook 在成功后推进。 */
  commit: (payload: BotSettingsPayload) => Promise<void>;
  textDelayMs?: number;
  instantDelayMs?: number;
}

export interface BotSettingsAutosaveController {
  status: BotAutosaveStatus;
  /** 字段变化:文本走防抖,离散选择走即时合并窗口。 */
  onEdit: (trigger: BotAutosaveTrigger) => void;
  /** blur / 返回聊天等显式边界的冲刷。 */
  flush: () => Promise<void>;
  /** 失败后重发。 */
  retry: () => Promise<void>;
  /** 是否有已改但未落库的内容。 */
  isDirty: () => boolean;
}

export function useBotSettingsAutosave(
  options: UseBotSettingsAutosaveOptions,
): BotSettingsAutosaveController {
  const { draft, fallbackName, enabled, commit, textDelayMs, instantDelayMs } = options;

  // 每次渲染重算(纯字段拷贝,代价可忽略),再写进 ref —— 调度器在 timer 回调里
  // 读的是 ref,拿不到渲染闭包。
  const payload = normalizeBotSettingsPayload(draft, fallbackName);
  const payloadRef = useRef(payload);
  payloadRef.current = payload;

  // 基线 = 上次成功落库的快照。用与当前值同一个归一化函数产生,否则挂载瞬间就会
  // 因为 trim 差异被判成脏。
  const baselineRef = useRef(payload);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const [status, setStatus] = useState<BotAutosaveStatus>('idle');
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const handleStatus = useCallback((next: BotAutosaveStatus) => {
    if (!mountedRef.current) return;
    if (savedTimerRef.current !== null) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    setStatus(next);
    if (next !== 'saved') return;
    savedTimerRef.current = setTimeout(() => {
      savedTimerRef.current = null;
      if (mountedRef.current) setStatus('idle');
    }, SAVED_HOLD_MS);
  }, []);

  const autosaveRef = useRef<BotSettingsAutosaveHandle | null>(null);
  if (autosaveRef.current === null) {
    autosaveRef.current = createBotSettingsAutosave({
      textDelayMs,
      instantDelayMs,
      readPayload: () => payloadRef.current,
      readBaseline: () => baselineRef.current,
      commit: async (next) => {
        if (!enabledRef.current) return;
        await commitRef.current(next);
        // 只有落库成功才推进基线;失败后基线不动,脏仍然是脏,重试才有意义。
        baselineRef.current = next;
      },
      onStatusChange: handleStatus,
    });
  }
  const autosave = autosaveRef.current;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (savedTimerRef.current !== null) {
        clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
      // 卸载(含切走 settings、切 bot、关窗)时把未落的改动发出去。
      autosave.flushDetached();
    };
  }, [autosave]);

  const onEdit = useCallback(
    (trigger: BotAutosaveTrigger) => {
      if (!enabledRef.current) return;
      autosave.schedule(trigger);
    },
    [autosave],
  );

  const flush = useCallback(() => {
    if (!enabledRef.current) return Promise.resolve();
    return autosave.flush();
  }, [autosave]);

  const retry = useCallback(() => {
    if (!enabledRef.current) return Promise.resolve();
    return autosave.retry();
  }, [autosave]);

  const isDirty = useCallback(() => enabledRef.current && autosave.isDirty(), [autosave]);

  return { status, onEdit, flush, retry, isDirty };
}
