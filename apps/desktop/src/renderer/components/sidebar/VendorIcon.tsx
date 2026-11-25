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
 * 插件引擎(2026-11-19 用户裁决):运行中(running=true)随外层呼吸动画保留插件图标自身配色;
 * 仅非运行时(running=false)显示灰色(透明底图标按剪影取行色，不透明底图标作灰度图)。无插件
 * 图标回落通用拼图，走内置同套状态色。见 pluginIconSilhouette。
 *
 * Agent 在另一台电脑运行(remote):右上角加模型选择器同款的单波纹 + 点,波纹随图标
 * 取色与呼吸;glyph 大小与位置不变(2026-10-07 用户裁决，替代标题后的芯片图标)。
 *
 */

import { ANTIGRAVITY_MARK_DATA_URL } from '@cindy/maker-shared/branding';
import { PluginEngineIcon } from '@/components/icons/PluginEngineIcon';
import { cn } from '@/lib/utils';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { RemoteSignalOverlay } from '@/components/icons/RemoteSourceMark';
import { Puzzle } from 'lucide-react';
import { usePluginIconSilhouette } from '@/components/icons/pluginIconSilhouette';
import { isPluginEngineKind } from '../../../shared/pluginEngines';

export type VendorIconKind = 'cc' | 'codex' | 'pi';

/**
 * 任务身份图标的种类：内置三种 Harness，加上插件提供的执行引擎('acp',
 * docs/plans/acp-plugin-bridge.md)。插件引擎只有一个通用图标，不冒充任何内置 Harness。
 */
export type EngineIconKind = VendorIconKind | 'acp';

/**
 * 各 glyph 笔画右上角在自身方框里的位置(0–1，已留出与波纹点的间隙)。
 * 像素脸头部占 viewBox x 0–21 / y 5–20;花形放大 1.1 后右上沿在 (19.1, 4.9);
 * π 字形偏小且居中。
 */
const REMOTE_SIGNAL_ANCHOR: Record<EngineIconKind, { x: number; y: number }> = {
  cc: { x: 0.95, y: 0.13 },
  codex: { x: 0.9, y: 0.1 },
  pi: { x: 0.83, y: 0.36 },
  acp: { x: 0.9, y: 0.12 },
};

/**
 * agentKind → VendorIcon vendor 的唯一映射。所有渲染 agent 身份图标的调用点
 * 必须走这里,禁止各自写 `=== 'codex' ? 'codex' : 'cc'` 二元三元(那会把 pi
 * 吞成 Claude 脸,2026-07-30 实测 bug)。兼容 'claude-code' 别名与 null。
 */
export function agentKindToVendor(kind: string | null | undefined): VendorIconKind {
  return kind === 'codex' ? 'codex' : kind === 'pi' ? 'pi' : 'cc';
}

/**
 * 任务行(sessions.agent_kind)→ 身份图标。与 agentKindToVendor 只差插件引擎任务：它们画通用
 * 插件引擎图标，而不是回落成 Claude 像素脸。会出现插件引擎任务的列表用这一个。
 */
export function engineIconKindOf(kind: string | null | undefined): EngineIconKind {
  return isPluginEngineKind(kind) ? 'acp' : agentKindToVendor(kind);
}

interface VendorIconProps {
  vendor: EngineIconKind;
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
  /**
   * 仅 vendor = 'acp'：提供该引擎的插件自己的图标(清单 icon)。缺省画通用拼图。运行中保留自身
   * 配色并随外层呼吸动画明暗变化；非运行时显示灰色(透明底走剪影，不透明底走灰度图)。
   */
  iconDataUrl?: string;
}

/**
 * A plugin engine's own icon: keeps its own brand colours while running (breathing via the outer
 * wrapper), and turns monochrome only while idle — as a silhouette in the row's neutral colour
 * when it has a transparent background, else in greyscale (also while not measured yet).
 */
function PluginIdentityMark({
  iconDataUrl,
  size,
  running,
}: {
  iconDataUrl: string;
  size: number;
  running: boolean;
}) {
  // Always measure so the silhouette cache is warm the moment a running task becomes idle.
  const silhouette = usePluginIconSilhouette(iconDataUrl);
  if (running) {
    return (
      <img
        src={iconDataUrl}
        alt=""
        aria-hidden
        draggable={false}
        width={size}
        height={size}
        data-plugin-icon="original"
        style={{ width: size, height: size }}
        className="shrink-0 object-contain"
      />
    );
  }
  if (silhouette) {
    const mask = `url("${iconDataUrl}")`;
    return (
      <span
        aria-hidden
        data-plugin-icon="silhouette"
        className="inline-block shrink-0"
        style={{
          width: size,
          height: size,
          backgroundColor: 'currentColor',
          WebkitMaskImage: mask,
          maskImage: mask,
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
        }}
      />
    );
  }
  return (
    <img
      src={iconDataUrl}
      alt=""
      aria-hidden
      draggable={false}
      width={size}
      height={size}
      data-plugin-icon="greyscale"
      style={{ width: size, height: size }}
      className="shrink-0 object-contain opacity-80 grayscale"
    />
  );
}

export function VendorIcon({
  vendor,
  size = 12,
  running = false,
  className,
  colorClassName,
  remote = false,
  title,
  iconDataUrl,
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
      {vendor === 'acp' ? (
        iconDataUrl === ANTIGRAVITY_MARK_DATA_URL ? (
          <PluginEngineIcon size={size} iconDataUrl={iconDataUrl} className="text-[var(--text-secondary)]" />
        ) : iconDataUrl ? (
          <PluginIdentityMark iconDataUrl={iconDataUrl} size={size} running={running} />
        ) : (
          <Puzzle size={size} aria-hidden strokeWidth={1.75} />
        )
      ) : vendor === 'codex' ? (
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
