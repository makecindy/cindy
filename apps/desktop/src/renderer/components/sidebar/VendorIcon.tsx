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
 */

import { cn } from '@/lib/utils';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';

export type VendorIconKind = 'cc' | 'codex' | 'pi';

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
}

export function VendorIcon({
  vendor,
  size = 12,
  running = false,
  className,
  colorClassName,
}: VendorIconProps) {
  const wrapperClassName = cn(
    'inline-flex shrink-0',
    running && 'session-status-breathing',
    // running 呼吸一律 Thinking Orange(--warning-accent,07-17 定稿 running 状态色);
    // 用户拍板 2026-07-20:选中态也保持橙,优先级高于 colorClassName 反相前景。
    running ? 'text-[var(--warning-accent)]' : (colorClassName ?? 'text-[hsl(var(--sidebar-muted))]'),
    className,
  );

  return (
    <span className={wrapperClassName}>
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
    </span>
  );
}
