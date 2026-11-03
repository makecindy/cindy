/**
 * VendorIcon — sidebar session 行的 Agent 身份 + running 状态指示器
 * ---------------------------------------------------------------------------
 * 2026-07-21(产品语义纠偏):Agent 身份保留 Claude Code 像素脸 / Codex CLI
 * 花形+`>_` glyph;模型厂牌另用 AnthropicMark / OpenAIMark。
 * 2026-07-19(用户拍板,撤销 D4-1):恢复按 Agent 类型区分的 glyph。
 *   D4-1 曾统一替换为品牌箭头(BrandArrow),实测后发现依赖图标区分 agent 类型的
 *   场景(创建自动化 chips、侧栏混排)全部失效,故换回按 vendor 分支渲染。
 *
 * 状态(不变):
 *   - idle (默认)   : Stone 灰 #737373 / dark #a3a3a3
 *   - running=true  : Thinking Orange(--warning-accent,全主题同值)+ session-breathing 呼吸;选中态同样橙(用户拍板 2026-07-20)
 *
 * Agent 在另一台电脑运行(remote):右上角加模型选择器同款的单波纹 + 点,波纹随图标
 * 取色与呼吸;glyph 大小与位置不变(2026-10-07 用户裁决，替代标题后的芯片图标)。
 *
 */

import { cn } from '@/lib/utils';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { RemoteSignalOverlay } from '@/components/icons/RemoteSourceMark';

export type VendorIconKind = 'cc' | 'codex' | 'pi';

/**
 * 各 glyph 笔画右上角在自身方框里的位置(0–1，已留出与波纹点的间隙)。
 * 像素脸头部占 viewBox x 0–21 / y 5–20;花形放大 1.1 后右上沿在 (19.1, 4.9);
 * π 字形偏小且居中。
 */
const REMOTE_SIGNAL_ANCHOR: Record<VendorIconKind, { x: number; y: number }> = {
  cc: { x: 0.95, y: 0.13 },
  codex: { x: 0.9, y: 0.1 },
  pi: { x: 0.83, y: 0.36 },
};

/**
 * agentKind → VendorIcon vendor 的唯一映射。所有渲染 agent 身份图标的调用点
 * 必须走这里,禁止各自写 `=== 'codex' ? 'codex' : 'cc'` 二元三元(那会把 pi
 * 吞成 Claude 脸,2026-07-30 实测 bug)。兼容 'claude-code' 别名与 null。
 */
export function agentKindToVendor(kind: string | null | undefined): VendorIconKind {
  return kind === 'codex' ? 'codex' : kind === 'pi' ? 'pi' : 'cc';
}

interface VendorIconProps {
  vendor: VendorIconKind;
  size?: number;
  /** true → 切 Thinking Orange + 呼吸动画,复用 .session-status-breathing */
  running?: boolean;
  className?: string;
  /** 覆盖默认取色(如选中态传 active 前景 —— 用户规则 2026-07-20:选中态上
   *  所有前景元素与文字同色);running 呼吸动画不受影响。 */
  colorClassName?: string;
  /** true → Agent 在另一台电脑运行:右上角外侧叠信号波纹(不占布局，向右上溢出)。 */
  remote?: boolean;
  /** 悬停说明(如 Agent 在哪台电脑上运行)。 */
  title?: string;
}

export function VendorIcon({
  vendor,
  size = 12,
  running = false,
  className,
  colorClassName,
  remote = false,
  title,
}: VendorIconProps) {
  const anchor = REMOTE_SIGNAL_ANCHOR[vendor];
  const wrapperClassName = cn(
    'inline-flex shrink-0',
    remote && 'relative',
    running && 'session-status-breathing',
    // running 呼吸一律 Thinking Orange(--warning-accent,07-17 定稿 running 状态色);
    // 用户拍板 2026-07-20:选中态也保持橙,优先级高于 colorClassName 反相前景。
    running ? 'text-[var(--warning-accent)]' : (colorClassName ?? 'text-[hsl(var(--sidebar-muted))]'),
    className,
  );

  return (
    <span className={wrapperClassName} title={title}>
      {vendor === 'codex' ? (
        <CodexMark size={size} />
      ) : vendor === 'pi' ? (
        <span
          aria-hidden
          style={{ fontSize: size * 0.86, lineHeight: `${size}px`, width: size, height: size }}
          className="inline-flex items-center justify-center font-semibold"
        >
          π
        </span>
      ) : (
        <ClaudeMark size={size} />
      )}
      {remote && <RemoteSignalOverlay markSize={size} anchorX={anchor.x} anchorY={anchor.y} />}
    </span>
  );
}
