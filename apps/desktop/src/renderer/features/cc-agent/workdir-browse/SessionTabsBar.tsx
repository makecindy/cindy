/**
 * SessionTabsBar — doc 模式右栏顶部 chat session tab 条。
 *
 * 与 ccagent 普通模式的差分：仅 /cc-agent/files/:sessionId 路由用，
 * 普通 /cc-agent/:sessionId 不挂这条。
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────┐
 *   │ [● title ×][title ×][title ×] ……scroll ……      [+]  │
 *   └──────────────────────────────────────────────────────┘
 *
 * 行为：
 *   - 点 tab → 切 active（外部回调更新 URL :sessionId）。
 *   - × 关闭 → 默认 = archive（外部弹确认 + 后端归档；归档后 session 状态变
 *     archived,自然从列表里消失,不需要单独维护 "已打开" 状态）。
 *   - 用户选择「禁用关闭最后一个」→ tabs.length<=1 时整个 × 隐藏。
 *   - 横向溢出 → wheel 转 scrollLeft；active 紧贴边缘时给前/后留半个 tab
 *     宽度的 peek。
 *   - 右侧 + 按钮：弹下拉菜单(Claude / Codex)→ onCreateNew(agentKind),
 *     外层用 newMakerDraft 草稿里对应 vendor 的上次 prefs + 当前 workdir
 *     创建新 session 并切 URL。
 *
 * 数据来源：tab 列表 = 当前 workdir 下所有 active session,父层(WorkdirBrowseRoute)
 * 已用 projectGrouping 的 compare 函数排好序传进来,本组件纯渲染。不持久化
 * "打开过哪些 tab" —— 每次进 doc 模式都看到 workdir 的真实 active 状态,新建
 * session 直接出现,关闭(archive)直接消失。
 *
 * active 由外部传入的 activeSessionId 决定(来自 URL :sessionId)。
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Tip } from '@/components/ui/tooltip';
import { VendorIcon } from '@/components/sidebar/VendorIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AgentKind, Session } from '@/lib/ccAgent.types';
import { makerChatStore } from '@/lib/makerChatStore';
import { getSessionDisplayTitle, toStoredSessionTitle } from '../lib/sessionDisplayTitle';

export interface SessionTabsBarProps {
  /** 当前 URL :sessionId 指向的 session；null 表示无 active（极少出现）。 */
  activeSessionId: string | null;
  /** 当前 workdir 下所有 active session,父层已按 projectGrouping 规则排好序
   *  (pinned 在前 → status → pinnedAt/sortTime desc)。本组件直接按数组顺序渲染。 */
  sessions: readonly Session[];
  /** 用户点 tab → 切 active session（外部更新 URL）。 */
  onActivate: (sessionId: string) => void;
  /** 用户从 + 下拉里选了一种 agent → 创建新 session 并切到它。
   *  外部全权负责(IPC 调用 + URL 跳转 + prefs 读取)。 */
  onCreateNew: (agentKind: AgentKind) => void;
  /** 用户点 × → 外部决定要不要 archive（弹确认 + 后端写入 + 清 in-memory state
   *  + 切下一个 active）。Bar 自身不再直接动 store, 把"关闭语义"整体交给宿主。
   *  `neighborId` = 关掉这个之后 bar 推荐切到的下一个 active(显示顺序里 next
   *  优先 / 否则 prev / 都没有时 null), 宿主可直接拿来 navigate。 */
  onClose: (sessionId: string, neighborId: string | null) => void;
  /** 双击 tab title → 内联重命名提交。空串 / 与原值相同时调用方应忽略;
   *  Bar 内部已经做了 trim + 同值短路, 这里把 trimmed newTitle 直接交出去。
   *  与 sidebar SessionItem 一套交互(双击进入 / Enter 提交 / Esc 取消 /
   *  Blur 提交)。 */
  onRename: (sessionId: string, newTitle: string) => void;
  /** false = 隐藏右侧 + 新建按钮。device-link 远程 doc 模式用:控制端无法替
   *  被控端创建会话,本地新建会得到一个指向远端路径的坏本地会话。默认 true。 */
  canCreateNew?: boolean;
}

/** 自动滚动时给 active tab 旁边留出的"半个 tab"预览空间(px)。
 *  ≈ 一个常规 session tab 宽度的一半:icon(13) + gap(6) + title(<=160) + ×(16) +
 *  padding(16) ≈ 210 / 2 ≈ 100,但保守取 80 以免末端 peek 过大。 */
const PEEK_PX = 80;

export function SessionTabsBar({
  activeSessionId,
  sessions,
  onActivate,
  onCreateNew,
  canCreateNew = true,
  onClose,
  onRename,
}: SessionTabsBarProps) {
  const { t } = useTranslation();
  const unnamedLabel = t('ccAgent.common.unnamedSession');
  // 订阅 running session map —— 与 sidebar SessionItem 同源(都来自
  // makerChatStore),保证 doc 模式 tab 上的 vendor icon 呼吸态与项目侧
  // session 行的呼吸完全同步出现/消失。多个订阅者 useSyncExternalStore
  // 自带 dedupe,这里再订阅一次几乎零成本。
  const runningMap = useSyncExternalStore(
    makerChatStore.subscribeAll,
    makerChatStore.getRunningSnapshot,
    makerChatStore.getRunningSnapshot,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());

  // ── 双击重命名(对齐 sidebar SessionItem 同款交互) ──
  // 一个时刻只能有一个 tab 处于编辑态; null = 没有正在编辑的 tab。
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter 触发 commit 后 input 立刻 unmount, onBlur 又会再触发一次 ——
  // committedRef 防止第二次重复发出 onRename。
  const committedRef = useRef(false);

  const enterRename = useCallback((sessionId: string, currentTitle: string) => {
    setEditValue(currentTitle);
    committedRef.current = false;
    setRenamingId(sessionId);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
  }, []);

  const commitRename = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    const id = renamingId;
    setRenamingId(null);
    if (!id) return;
    const trimmed = editValue.trim();
    const target = sessions.find((s) => s.id === id);
    const original = target?.title ?? '';
    // 显示标题也算「没改」(与 SessionContentHeader 同口径):未起名的会话 tab 上
    // 预填的是本地化兜底文案,它不等于库里的英文哨兵 —— 只比原始 title 的话,
    // 用户双击后原样回车会把兜底文案写进库、冲掉哨兵,自动起名从此跳过这个会话。
    const displayed = target ? getSessionDisplayTitle(target, unnamedLabel) : '';
    if (!trimmed || trimmed === original || trimmed === displayed) return;
    // 预填是显示标题(legacy automation 会话已剥掉 `[Schedule] ` 前缀),落库前还原,
    // 否则会话会从 automation 分组里消失(PR #1031 review P1)。
    onRename(id, target ? toStoredSessionTitle(target, trimmed) : trimmed);
  }, [renamingId, editValue, sessions, onRename, unnamedLabel]);

  // 进编辑态后自动 focus + 全选 input。
  useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renamingId]);

  // active 切换 → 把目标 tab 滚进可视范围,且在 active 紧贴边缘时给前/后留
  // PEEK_PX 的"半个 tab"预览空间,让用户能看到还有更多 tab 可点(否则点完
  // 末尾的 tab 之后,后面的 tab 完全被裁掉,根本点不到)。
  // 首次 mount 用直接赋值绕开浏览器 smooth scroll 调度,避免进 doc 模式
  // 时一帧动画;后续切 tab 走 scrollTo({ behavior:'smooth' })。
  const firstScrollRef = useRef(true);
  useEffect(() => {
    if (!activeSessionId) return;
    const el = tabRefs.current.get(activeSessionId);
    const scroller = scrollRef.current;
    if (!el || !scroller) return;

    const idx = sessions.findIndex((s) => s.id === activeSessionId);
    // 末尾 / 首位时把对应方向的 peek 收掉 —— 真没有后续 tab 时再硬留
    // 60px 空白反而显丑。
    const peekRight = idx >= 0 && idx < sessions.length - 1 ? PEEK_PX : 0;
    const peekLeft = idx > 0 ? PEEK_PX : 0;

    const tabLeft = el.offsetLeft;
    const tabRight = tabLeft + el.offsetWidth;
    const viewLeft = scroller.scrollLeft;
    const viewRight = viewLeft + scroller.clientWidth;

    let target: number;
    if (tabLeft - peekLeft < viewLeft) {
      target = Math.max(0, tabLeft - peekLeft);
    } else if (tabRight + peekRight > viewRight) {
      target = tabRight + peekRight - scroller.clientWidth;
    } else {
      return; // 已经在 peek 边距内,不动。
    }

    if (firstScrollRef.current) {
      firstScrollRef.current = false;
      scroller.scrollLeft = target;
    } else {
      scroller.scrollTo({ left: target, behavior: 'smooth' });
    }
  }, [activeSessionId, sessions]);

  // 单击立即切换 active；双击时第二个 click 由 event.detail 跳过，
  // 后续 doubleClick 只额外进入重命名。
  function handleTabClick(e: React.MouseEvent, sessionId: string): void {
    if (renamingId) return;
    if (e.detail > 1) return;
    if (sessionId !== activeSessionId) onActivate(sessionId);
  }

  function handleTabDoubleClick(e: React.MouseEvent, sessionId: string, title: string): void {
    e.stopPropagation();
    e.preventDefault();
    enterRename(sessionId, title);
  }

  function handleClose(e: React.MouseEvent, sessionId: string): void {
    e.stopPropagation();
    // 用户选择「禁用关闭最后一个」—— 调用方应该已经隐藏 ×，但这里再兜一道。
    if (sessions.length <= 1) return;
    // 邻居取「显示顺序里的下一个 / 上一个」—— 按当前显示顺序算,
    // 关 active 后切的目标符合用户视觉预期(右边 → 右边的下一个)。
    const idx = sessions.findIndex((s) => s.id === sessionId);
    const neighbor = sessions[idx + 1]?.id ?? sessions[idx - 1]?.id ?? null;
    onClose(sessionId, neighbor);
  }

  function handleWheel(e: React.WheelEvent<HTMLDivElement>): void {
    const el = scrollRef.current;
    if (!el) return;
    if (e.shiftKey || e.deltaX !== 0) return;
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 0) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }

  // sessions.length === 0：理论上 active session 自己也是 active 状态,父层
  // 至少会传它一个进来；这里仍兜底处理避免 closable 异常。
  const closable = sessions.length > 1;

  return (
    <div
      className={cn(
        // 与 FileTabsBar 等高/同色：方便视觉上跟左侧文件 tab 条对齐成一条横线。
        'relative flex h-9 w-full shrink-0 items-stretch',
        'border-b border-[var(--cmd-palette-border)]',
        'bg-[hsl(var(--content-area))]',
      )}
      // mac 上 doc 模式不渲染通用 ContentHeader,tab 条整行承担窗口拖拽,
      // tab / 按钮各自 no-drag,行尾空白保持可拖(windowDrag.tsx 约定)
      style={WINDOW_DRAG_STYLE}
    >
      <div
        ref={scrollRef}
        className={cn(
          'min-w-0 flex-1 flex overflow-x-auto overflow-y-hidden',
          // 用全局 scrollbar 自动隐藏体系；横向 6px 与 FileTabsBar 一致。
          'workdir-tabs-scroll',
        )}
        onWheel={handleWheel}
      >
        {sessions.map((session) => {
          const sessionId = session.id;
          const title = getSessionDisplayTitle(session, unnamedLabel).trim() || unnamedLabel;
          const vendor = session.agentKind;
          const isActive = sessionId === activeSessionId;
          const isRunning = runningMap.has(sessionId);
          const isEditing = renamingId === sessionId;
          // 编辑态屏蔽 tooltip —— 否则 hover 到 input 上还会弹原标题, 干扰输入。
          const tabBody = (
            <div
              ref={(node) => {
                if (node) tabRefs.current.set(sessionId, node);
                else tabRefs.current.delete(sessionId);
              }}
              onClick={(e) => handleTabClick(e, sessionId)}
              onDoubleClick={(e) => handleTabDoubleClick(e, sessionId, title)}
              style={WINDOW_NO_DRAG_STYLE}
              className={cn(
                // px-2 + max-w-[80px] 标题:rail 默认宽 380 时能放下 3 个常规
                // 长度 tab(超长走 truncate),小于 px-3 是因为 session 标题
                // 普遍比文件名长,要把横向密度提一档。
                'group/tab relative flex h-full shrink-0 items-center gap-1.5 px-2',
                'border-r border-[var(--cmd-palette-border)]',
                'cursor-pointer text-12 transition-colors',
                isActive
                  ? 'bg-[var(--chat-input-chip-bg)] text-foreground font-medium'
                  : 'text-[var(--cmd-palette-item-meta)] hover:bg-[var(--chat-input-chip-bg)] hover:text-foreground',
              )}
            >
              {/* Agent 身份 icon —— Claude Code 像素脸 / Codex CLI 花形+`>_`。
                  running=true → VendorIcon 自动切 Thinking Orange + 呼吸
                  动画(.session-status-breathing),与 sidebar SessionItem 同款;
                  inactive 默认 Stone 灰,active 时给个 text-foreground 高亮
                  (running 优先于 active —— 呼吸态颜色由 VendorIcon 自己
                   接管,这里不要叠 className)。 */}
              <VendorIcon
                vendor={vendor}
                size={13}
                running={isRunning}
                className={cn(!isRunning && isActive && 'text-foreground')}
              />
              {isEditing ? (
                <input
                  ref={inputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      commitRename();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  className={cn(
                    'max-w-[160px] h-5 px-1 rounded',
                    'text-12 font-medium text-foreground',
                    'bg-transparent outline-none',
                    'border-[1.5px] border-[var(--focus-ring)]',
                  )}
                />
              ) : (
                <span className="max-w-[160px] truncate">{title}</span>
              )}
              {closable && !isEditing && (
                <button
                  type="button"
                  onClick={(e) => handleClose(e, sessionId)}
                  aria-label={t('ccAgent.workdirBrowse.sessionTabs.closeSession', { title })}
                  className={cn(
                    'ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded',
                    'text-[var(--cmd-palette-item-meta)]',
                    'opacity-0 transition-opacity duration-150',
                    'group-hover/tab:opacity-100 focus-visible:opacity-100',
                    isActive && 'opacity-100',
                    'hover:bg-[var(--cmd-palette-border)] hover:text-foreground',
                  )}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              )}
            </div>
          );
          return (
            <Tip
              key={sessionId}
              text={title}
              side="bottom"
              delay={400}
              disabled={isEditing}
            >
              {tabBody}
            </Tip>
          );
        })}
      </div>

      {/* 右侧 + 按钮:sticky 在 tabs 区右边,不参与横向滚动。
          点击 → 弹下拉菜单(Claude / Codex);选 agent → 调用方用
          newMakerDraft 里对应 vendor 的上次 prefs + 当前 workdir 创建会话。
          border-l 与 tab 的 border-r 同色同位,把 + 区从横向滚动区视觉切开,
          避免最后一个 tab 滚到边缘时和 + 按钮糊成一坨。 */}
      {canCreateNew && (
      <div className="flex shrink-0 items-center border-l border-[var(--cmd-palette-border)] px-1.5" style={WINDOW_NO_DRAG_STYLE}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('ccAgent.workdirBrowse.sessionTabs.newSession')}
              className={cn(
                'flex size-6 items-center justify-center rounded-md',
                'text-[var(--settings-section-desc)]',
                'hover:bg-[var(--chat-input-chip-bg)] hover:text-foreground',
                'data-[state=open]:bg-[var(--chat-input-chip-bg)] data-[state=open]:text-foreground',
                'transition-colors outline-none',
              )}
            >
              <Plus size={14} strokeWidth={2} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={4}
            className={cn(
              // 与 ProjectNode / SessionItem 菜单同款 shadcn 覆盖,统一项目侧
              // dropdown 视觉。
              'rounded-xl p-0.5 overflow-hidden min-w-[140px]',
              'bg-[var(--cmd-palette-bg)]',
              'border border-[var(--cmd-palette-border)]',
              'shadow-[var(--shadow-menu)]',
            )}
          >
            <DropdownMenuItem
              onSelect={() => onCreateNew('cc')}
              className="h-7 px-2.5 rounded-md text-13 text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
            >
              <VendorIcon vendor="cc" size={14} className="mr-2 text-foreground" />
              Claude
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onCreateNew('codex')}
              className="h-7 px-2.5 rounded-md text-13 text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
            >
              <VendorIcon vendor="codex" size={14} className="mr-2 text-foreground" />
              Codex
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      )}
    </div>
  );
}
