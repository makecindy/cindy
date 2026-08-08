import { useSyncExternalStore } from 'react';

/**
 * 对话切换序号徽标(mod+1..9 快速切换, 复刻 Codex 桌面版交互)。
 *
 * 按住主修饰键超过阈值时, CCAgentSidebarUpper 按侧边栏当前可见顺序
 * (getVisibleSidebarSessionIds, 与快捷键执行同一口径)构建
 * sessionId → 显示标签('⌘1' / 'Ctrl+1')的映射写入本模块级 store; 松开清空。
 *
 * 不走 props / context 而用 useSyncExternalStore 精准订阅, 是为了守住
 * SessionItem 的性能不变量(见其文件头注释): 行内订阅必须按 sessionId 取
 * primitive —— map 更替时只有标签真正变化的行(前 9 行)重渲染, 其余几百行
 * snapshot 恒为 null, React 不触碰它们。
 */

type SessionOrdinalBadgeMap = ReadonlyMap<string, string> | null;

let currentBadges: SessionOrdinalBadgeMap = null;
const listeners = new Set<() => void>();

export function setSessionOrdinalBadges(next: SessionOrdinalBadgeMap): void {
  if (next === currentBadges) return;
  currentBadges = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 行组件读取自己的序号徽标标签; 不在前 9 个可见对话内(或未按住)返回 null。 */
export function useSessionOrdinalBadge(sessionId: string): string | null {
  return useSyncExternalStore(subscribe, () => currentBadges?.get(sessionId) ?? null);
}

/**
 * 徽标本体(对齐 Codex 原版观感): 无边框、currentColor 10% 透明底、大圆角。
 * 文字与底色都继承 current —— 定位容器负责给出前景色(普通行次级灰、active
 * 反色行浅色), Light/Dark 与 active 态自动适配, 不引入新 token。徽标出现时
 * 行内时间/badge 由各自容器让位淡出, 徽标独占行尾。纯视觉提示, aria-hidden。
 */
export function SessionOrdinalBadgeKbd({ label }: { label: string }) {
  // mac 显示形是「修饰符号 + 键名」直排(如 ⌘1)。⌃⌥⇧⌘ 这类符号在 UI 字体
  // 里字形明显小于数字且基线偏高, 整串渲染像上标 —— 拆开后给符号略大字号
  // 补偿, 加 1px 间距, 与 Codex 原版观感对齐。非 mac(Ctrl+1)整串原样。
  const macParts = label.match(/^([⌃⌥⇧⌘]+)(.+)$/);
  return (
    <kbd
      aria-hidden
      className="flex select-none items-center gap-px rounded-md bg-[color-mix(in_srgb,currentColor_10%,transparent)] px-1.5 py-[2px] text-11 font-normal leading-none text-current"
    >
      {macParts ? (
        <>
          <span className="text-13 leading-none">{macParts[1]}</span>
          <span>{macParts[2]}</span>
        </>
      ) : (
        label
      )}
    </kbd>
  );
}
