/**
 * SessionRenameInput — 会话行内重命名输入框(共用组件)
 * ---------------------------------------------------------------------------
 * SessionItem(侧边栏列表行)/ SessionCard(list + card 两个变体)/
 * SessionContentHeader(内容区顶栏)四处双击改名输入框的统一实现:
 *   - input 本体:Enter / Blur / 点击容器外提交、Escape 取消、点击不冒泡(避免
 *     触发行导航),挂载即聚焦全选(输入框仅在编辑态挂载,等价于旧的 isEditing
 *     effect)。外点检测走 document pointerdown capture:点击不可聚焦区域(聊天
 *     区空白等)不会转移焦点、blur 不触发,只靠 blur 编辑态会一直挂着
 *   - 右侧 Magic 按钮(Sparkles):点击调 maker:regenerate-title,由 main 读该会话
 *     最新一轮对话素材重新起标题,成功后只把结果填入输入框并全选(不直接提交),
 *     用户 Enter 确认才生效、Escape 放弃;生成中图标转 spinner,失败 toast 提示,
 *     两种情况都停留在编辑态
 *   - 生成期间用户手动 Enter / Blur 提交或 Escape 取消 → 编辑器卸载,mountedRef
 *     守卫丢弃迟到的 AI 结果(手动操作优先,与自动起名的防碰撞语义一致)
 *   - device-link 远程会话经隧道在被控端执行(素材与 provider 凭证都在被控端),
 *     路由由 makerTransport.regenerateSessionTitleFor 决定;老被控端不识别该
 *     channel 时 invoke 被拒,走同一条失败 toast
 *
 * 视觉:边框 / 圆角 / 透明底等共有部分内置;字号字重(各处不同)与布局定位
 * (flex-1 / 固定宽)分别由 inputClassName / containerClassName 传入。
 */

import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { regenerateSessionTitleFor } from '@/lib/makerTransport';
import { extractIpcError } from '@/utils/ipcError';

const log = createLogger('SessionRenameInput');

/**
 * Magic 生成失败的场景化提示:远程会话的隧道错误按 IPC 错误码细分——
 * 老被控端白名单没有该 channel(版本过旧)与链路不通(离线/超时)给不同文案,
 * 其余(本机生成失败、无素材等)落通用失败提示。
 */
const AI_RENAME_ERROR_I18N: Record<string, string> = {
  DEVICE_LINK_CHANNEL_NOT_ALLOWED: 'ccAgent.rename.aiRenameRemoteOutdated',
  DEVICE_LINK_VERSION_MISMATCH: 'ccAgent.rename.aiRenameRemoteOutdated',
  DEVICE_LINK_NOT_CONNECTED: 'ccAgent.rename.aiRenameRemoteOffline',
  DEVICE_LINK_DEVICE_OFFLINE: 'ccAgent.rename.aiRenameRemoteOffline',
  DEVICE_LINK_TIMEOUT: 'ccAgent.rename.aiRenameRemoteOffline',
};

function aiRenameFailureKey(err: unknown): string {
  const code = extractIpcError(err)?.code;
  return (code && AI_RENAME_ERROR_I18N[code]) || 'ccAgent.rename.aiRenameFailed';
}

interface SessionRenameInputProps {
  sessionId: string;
  value: string;
  onValueChange: (value: string) => void;
  /**
   * 提交(Enter / Blur)。参数是待保存的标题原文——
   * 调用方沿用自己原有的 trim / 去重 / committedRef 防重语义。
   */
  onCommit: (raw: string) => void;
  /** Escape 取消。调用方负责退出编辑态(及各自的防 blur 二次提交处理)。 */
  onCancel: () => void;
  /** input 视觉类:高度 / 字号 / 字重(共有的边框、圆角、透明底已内置)。 */
  inputClassName?: string;
  /** 外层容器布局类:min-w-0 flex-1 或固定宽度。 */
  containerClassName?: string;
  /** 位于侧栏 active 反相底色上时，input 与 Magic 按钮都切到配套前景色。 */
  activeForeground?: boolean;
}

export function SessionRenameInput({
  sessionId,
  value,
  onValueChange,
  onCommit,
  onCancel,
  inputClassName,
  containerClassName,
  activeForeground = false,
}: SessionRenameInputProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [generating, setGenerating] = useState(false);
  // 卸载 = 编辑态已终结(提交/取消)。迟到的 AI 结果(成功或失败)据此丢弃:
  // 不再填入输入框、不再 toast、不再 setState,避免污染用户的下一轮编辑。
  const mountedRef = useRef(true);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 外点提交:点击容器外任何位置 = 结束编辑(语义与 blur 提交一致)。
  // 用 ref 透传最新 value / onCommit,避免每次输入都重挂 document 监听。
  // capture 阶段监听:外部元素即使 stopPropagation / preventDefault 也拦不住。
  const latestRef = useRef({ value, onCommit });
  latestRef.current = { value, onCommit };
  useEffect(() => {
    const onPointerDownOutside = (e: PointerEvent) => {
      const el = containerRef.current;
      if (!el || el.contains(e.target as Node)) return;
      latestRef.current.onCommit(latestRef.current.value);
    };
    document.addEventListener('pointerdown', onPointerDownOutside, true);
    return () => document.removeEventListener('pointerdown', onPointerDownOutside, true);
  }, []);

  const handleAiRename = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const { title } = await regenerateSessionTitleFor(sessionId);
      // 本实例已卸载 = 这轮编辑已被用户终结(提交/取消),结果一律丢弃,
      // 避免过期结果误填进用户重新打开的下一轮编辑。
      if (!mountedRef.current) return;
      const trimmed = title?.trim();
      if (trimmed) {
        // 生成结果只填入输入框、不直接提交:用户 Enter 确认才生效,Escape 放弃。
        onValueChange(trimmed);
        // 等父组件把新 value 渲染进 DOM 后再聚焦全选(立即 select 选中的还是旧文本),
        // 方便直接 Enter 确认或整体重打。
        requestAnimationFrame(() => {
          if (!mountedRef.current) return;
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      } else {
        toast.warning(t('ccAgent.rename.aiRenameFailed'));
      }
    } catch (err) {
      log.warn('regenerate title failed', err);
      if (!mountedRef.current) return;
      toast.warning(t(aiRenameFailureKey(err)));
    }
    setGenerating(false);
  };

  return (
    <div
      ref={containerRef}
      className={cn('relative flex items-center', containerClassName)}
      // 失焦提交放在容器层而非 input:焦点在 input ↔ Magic 按钮之间移动(Tab 键盘
      // 访问)不算离开编辑器,否则 Tab 到按钮的瞬间 input blur 就提交并卸载编辑器,
      // 纯键盘用户永远无法触发 AI 改名(Codex review P2)。React 的 onBlur 会冒泡,
      // relatedTarget 是即将获得焦点的元素,仍在容器内则跳过提交。
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        onCommit(value);
      }}
      // input 自身的 keydown 已 stopPropagation,这里只会收到 Magic 按钮上的按键:
      // 让 Esc 在焦点位于按钮时同样可取消编辑。
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          // IME 组合中的 Enter 是确认候选词,不是提交
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onCommit(value);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onClick={(e) => e.stopPropagation()}
        // dblclick 也要拦:侧栏行的 onDoubleClick 是"进入改名"入口,冒泡出去
        // 会重置编辑草稿(AI 刚填入的标题被打回旧值)且其 preventDefault 会
        // 吃掉浏览器默认的双击选词。stopPropagation 不影响默认选词行为。
        onDoubleClick={(e) => e.stopPropagation()}
        className={cn(
          'w-full min-w-0 px-1.5 rounded',
          'bg-transparent outline-none',
          'border-[1.5px] border-[var(--focus-ring)]',
          'pr-7',
          inputClassName,
          activeForeground && 'text-sidebar-item-active-foreground',
        )}
      />
      <button
        type="button"
        aria-label={t('ccAgent.rename.aiRename')}
        title={t('ccAgent.rename.aiRename')}
        // 生成中不能用 disabled:禁用当前聚焦元素会让浏览器立即 blur 它(焦点落到
        // body,relatedTarget 为 null)→ 容器失焦提交并卸载编辑器,键盘激活路径
        // 自毁(code review P2)。重入由 handleAiRename 顶部的 generating 守卫拦,
        // 可聚焦性保留,仅用 aria-disabled 表达状态。
        aria-disabled={generating}
        // preventDefault:保住 input 焦点,点按钮不触发 blur 提交;
        // stopPropagation:不惊动行级 pointer/mouse 处理(导航、菜单收起等)
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void handleAiRename();
        }}
        className={cn(
          'absolute right-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded',
          'transition-colors',
          activeForeground
            ? 'text-sidebar-item-active-foreground hover:text-sidebar-item-active-foreground hover:bg-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_14%,transparent)]'
            : 'text-[var(--cmd-palette-item-meta)] hover:bg-titlebar-button-hover hover:text-foreground',
          'focus:outline-none',
        )}
      >
        {generating ? <Spinner size={13} /> : <Sparkles size={13} />}
      </button>
    </div>
  );
}
