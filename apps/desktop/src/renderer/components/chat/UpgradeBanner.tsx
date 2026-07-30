/**
 * UpgradeBanner — 远端 cc-manager 升级提示横幅 (cc remote 专用)
 * ---------------------------------------------------------------------------
 * 触发条件: main 端 silent install pipeline 探到 daemon 版本 != desktop 手里
 * 的 bundle hash, 推 push 到 ccMgrUpgradeStore, 该 host 上每个 cc remote
 * ChatView 顶部都会显示这条 banner (该 host 共享同一状态)。
 *
 * 不强升的原因: 强升 = pkill daemon + re-upload + restart daemon, 会中断该
 * host 上**所有 alive cc session** 的 in-flight turn。让用户主动选择时机 (点
 * 「升级」) 比静默中断体验好。详见 plan 讨论。
 *
 * 设计与 ErrorBanner 对照:
 *   - 视觉相近 (同 inline banner pattern), 但用 amber 替代 red (warning vs error)
 *   - amber/red 都在规则 18 的语义豁免范围 (跨主题保持一致), 通过主题 token
 *     暴露给非默认主题 override 体系
 *   - action 行为不同: ErrorBanner = retry + dismiss; UpgradeBanner = upgrade + dismiss
 *
 * 升级状态 (uiState):
 *   - idle:     默认, 显示「立即升级」按钮 + 关闭 X
 *   - upgrading: 用户点了升级, 按钮 disable + 文案切「正在升级 cc-manager...」
 *               (期间 silent install toast 也独立显示进度)
 *   - 升级成功: main 推 available=null → useCcMgrUpgrade(hostId) 返 null → banner 自身消失
 *   - 升级失败: catch error → toast.error 弹错误, banner 回到 idle 让用户重试
 */

import { useSyncExternalStore, useCallback, useState } from 'react';
import { ArrowUpCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import {
  subscribeCcMgrUpgradeStore,
  getCcMgrUpgradeSnapshot,
  forceUpgradeCcMgr,
  dismissCcMgrUpgrade,
} from '@/state/ccMgrUpgradeStore';
import { makerChatStore } from '@/lib/makerChatStore';
import * as sessionService from '@/lib/sessionService';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/lib/makerChatStore';
import type { AttachedFile, MentionedResource } from '@/lib/fileTypes';

interface UpgradeBannerProps {
  hostId: string;
  /**
   * Session that owns this banner instance (one banner per ChatView). If set
   * and the session has a last user message, U3 will auto-resend it after the
   * upgrade completes — so the user's "test" message that got interrupted by
   * the daemon kill comes back as a fresh turn on the new daemon, no manual
   * re-typing.
   */
  sessionId?: string;
  className?: string;
  style?: React.CSSProperties;
}

interface RetryCandidate {
  sessionId: string;
  text: string;
  model: string;
  effort: string;
  permissionMode: string;
  workingDir: string;
  files?: AttachedFile[];
  mentions?: MentionedResource[];
}

function extFromName(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function fallbackFilesFromMessage(message: ChatMessage): AttachedFile[] | undefined {
  const files: AttachedFile[] = [];
  for (const img of message.images ?? []) {
    if ('url' in img) {
      const name = img.originalName;
      files.push({
        id: crypto.randomUUID(),
        name,
        path: img.url,
        ext: extFromName(name),
        size: 0,
        category: 'image',
        mimeType: img.mimeType,
        url: img.url,
        originalName: name,
      });
    }
  }
  for (const f of message.files ?? []) {
    const ext = extFromName(f.name);
    files.push({
      id: crypto.randomUUID(),
      name: f.name,
      path: f.path,
      ext,
      size: 0,
      category: 'text',
      mimeType: 'application/octet-stream',
    });
  }
  return files.length > 0 ? files : undefined;
}

/** Snapshot the session's last user message + its original send-time prefs.
 *  Async because model/effort/permissionMode/workingDir come from the DB
 *  session row (权威源 — sendUiTrigger 用同一 pattern), not from ChatMessage
 *  (ChatMessage 只有 role/content/clientId/persistedContent, 不带 agent prefs).
 *  Returns null if no user message present or DB session row missing critical
 *  fields. */
async function snapshotRetryCandidate(sessionId: string): Promise<RetryCandidate | null> {
  const snap = makerChatStore.getSnapshot(sessionId);
  // Critical gate: 只有该 session **正在 streaming / agent 正在 running** 时, 才
  // 把 last user message 当成"被升级中断的 in-flight turn"来 retry。空闲会话点
  // 升级时, last user message 是上一次已经完整跑完的 turn (assistant 已经回复
  // 过), 自动 retry 会重发历史消息 — 带文件改动 / 命令 / 外部 API 的消息可能
  // 重复产生副作用。这就是 codex 审视报告里 #问题1 的根因, 在 client 侧通过
  // streaming 门禁卡住, 避免引入 server-side reason 透传的跨层改动。
  if (!snap.isStreaming && !snap.agentStatus.isRunning) {
    return null;
  }
  // Find most recent user-role message — its content is the text we dispatched.
  // ChatMessage 上的 `content` 是简短 text (sendMessage 传进来的 text 参数);
  // persistedContent (stringifyUserContent 后的 JSON 形态 `{"text":...,"images":[],"files":[]}`)
  // 是 main 落库后回填的, 直接当 text 用会发出 JSON blob 而非用户原文 (review #1)。
  // 优先级: lastUser.content (plain string) > 解析 persistedContent JSON 的 .text。
  const lastUser = [...snap.messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return null;
  const text = (() => {
    if (typeof lastUser.content === 'string' && lastUser.content.length > 0) return lastUser.content;
    const persisted = (lastUser as { persistedContent?: string }).persistedContent;
    if (typeof persisted !== 'string') return null;
    // persistedContent 可能是 stringifyUserContent JSON 或纯文本 (旧消息), JSON
    // 形态都以 `{` 开头, 否则直接当 plain text。
    if (persisted.startsWith('{')) {
      try {
        const parsed = JSON.parse(persisted) as { text?: string };
        return typeof parsed.text === 'string' ? parsed.text : null;
      } catch {
        return null;
      }
    }
    return persisted;
  })();
  const files = lastUser.retryFiles ?? fallbackFilesFromMessage(lastUser);
  const mentions = lastUser.retryMentions;
  if (!text && (!files || files.length === 0) && (!mentions || mentions.length === 0)) return null;
  // model/effort/permissionMode/workingDir 走 DB session row (跟 sendUiTrigger
  // 一样的真相源, 见 makerChatStore.ts:3312-3318)。get() 是 IPC, 慢一点但
  // banner click 路径不在乎几毫秒。失败返 null, handleUpgrade 捕获后不重发。
  try {
    const row = await sessionService.get(sessionId);
    if (!row.workingDir || !row.model || !row.effort || !row.permissionMode) {
      return null;
    }
    return {
      sessionId,
      text: text ?? '',
      model: row.model,
      effort: row.effort,
      permissionMode: row.permissionMode,
      workingDir: row.workingDir,
      files,
      mentions,
    };
  } catch {
    return null;
  }
}

/**
 * Hook — 订阅 ccMgrUpgradeStore 中给定 hostId 的 pending state。
 * Returns null when no upgrade is pending for this host (banner 自身渲染 null)。
 */
function useCcMgrUpgrade(hostId: string): { currentVersion: string; availableVersion: string } | null {
  const getSnapshot = useCallback(() => getCcMgrUpgradeSnapshot(hostId), [hostId]);
  return useSyncExternalStore(subscribeCcMgrUpgradeStore, getSnapshot, getSnapshot);
}

export function UpgradeBanner({ hostId, sessionId, className, style }: UpgradeBannerProps) {
  const { t } = useTranslation();
  const pending = useCcMgrUpgrade(hostId);
  const [upgrading, setUpgrading] = useState(false);

  if (!pending) return null;

  const handleUpgrade = async (): Promise<void> => {
    if (upgrading) return;
    setUpgrading(true);
    // U3: snapshot retry candidate BEFORE upgrade kills the daemon — once
    // SESSION_CLOSED hits, the SDK turn is gone, messages[] may be patched
    // (U2 emits error event which the store reduces, but content stays on
    // the user message). Snapshot now to lock in the exact text + prefs used
    // for the original send. Await because the prefs come from DB session row
    // (sessionService.get is IPC) — see snapshotRetryCandidate doc.
    const retry = sessionId ? await snapshotRetryCandidate(sessionId) : null;
    try {
      const { daemonReady } = await forceUpgradeCcMgr(hostId, sessionId ?? undefined);
      // 成功 → main 推 available=null, store 自动清空 → 本 banner 渲染 null。
      // 不需要这里主动 setUpgrading(false), 组件直接 unmount。
      //
      // U3 auto-resend gate:
      //  1. retry candidate 存在 (UpgradeBanner.snapshotRetryCandidate 已经卡了
      //     isStreaming/agentStatus.isRunning, 空闲会话 retry=null)
      //  2. daemonReady = true (IPC 已知 daemon 真的起来了, 否则 retry sendMessage
      //     会落一条 user bubble 然后在 lazy create 时失败成噪音, 详见 codex 审视
      //     报告 #问题2)
      // 两条都满足才自动重发, daemon 起不来 (网络抖 / 远端机器问题) 时引导用户
      // 手动重试, 给出明确文案 (区分于 banner 默认升级失败 toast)。
      if (retry && daemonReady) {
        makerChatStore.sendMessage(
          retry.sessionId,
          retry.text,
          retry.model,
          retry.effort,
          retry.permissionMode,
          retry.workingDir,
          retry.files,
          retry.mentions,
        );
      } else if (retry && !daemonReady) {
        toast.error(t('chat.upgradeBanner.daemonNotReady'), { duration: 8000 });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(t('chat.upgradeBanner.failed', { message: msg }), { duration: 8000 });
      setUpgrading(false);
    }
  };

  const handleDismiss = async (): Promise<void> => {
    if (upgrading) return;
    try {
      await dismissCcMgrUpgrade(hostId);
    } catch {
      // dismiss 失败无害, 用户下次重启 desktop 还会再提示
    }
  };

  return (
    <div
      className={cn(
        'mx-auto flex select-none items-start gap-2 rounded-md px-3 py-2',
        'border bg-[var(--upgrade-banner-bg)] border-[var(--upgrade-banner-border)]',
        className,
      )}
      style={style}
    >
      {upgrading ? (
        <Spinner size={14} className="mt-[2px] text-[var(--upgrade-banner-fg)]" />
      ) : (
        <ArrowUpCircle size={14} className="shrink-0 mt-[2px] text-[var(--upgrade-banner-fg)]" />
      )}
      <span className="text-xs text-[var(--upgrade-banner-fg)] flex-1 break-all">
        {upgrading
          ? t('chat.upgradeBanner.upgrading', { hostId })
          : t('chat.upgradeBanner.description', { hostId })}
      </span>
      {!upgrading && (
        <button
          type="button"
          onClick={() => void handleUpgrade()}
          className={cn(
            'shrink-0 flex items-center gap-1 text-xs font-medium',
            'text-[var(--upgrade-banner-fg)]',
            'hover:opacity-70 transition-opacity',
          )}
          title={t('chat.upgradeBanner.upgradeTitle')}
        >
          <ArrowUpCircle size={12} />
          {t('chat.upgradeBanner.upgrade')}
        </button>
      )}
      {/* 关闭:纯 X,尺寸与不透明度对齐其它提示条的关闭按钮(2026-07 统一)。 */}
      {!upgrading && (
        <button
          type="button"
          onClick={() => void handleDismiss()}
          className="shrink-0 text-[var(--upgrade-banner-fg)] opacity-60 hover:opacity-100 transition-opacity"
          title={t('chat.upgradeBanner.dismissTitle')}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
