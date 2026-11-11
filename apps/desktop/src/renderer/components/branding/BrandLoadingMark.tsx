/**
 * BrandLoadingMark — 会话切换 shell-first 帧的品牌加载指示。
 *
 * 表现(Codex Desktop startup loader 同构):底层 wordmark 低亮常驻,一条亮带
 * 经同形 mask 只在字标形状内扫过(PNG alpha 通道即 mask,深浅色主题各用对应
 * logo 资产)。扫光用 transform 位移实现(compositor-only)——消息树构建会
 * 阻塞主线程,background-position 动画会被冻住,transform 不会。
 *
 * 延迟浮现(200ms,CSS animation-delay):多数会话内容在下一帧(≪200ms)就
 * 挂载完成,本指示器从未变得可见 —— 小会话不闪 loading;只有大会话构建期
 * 超过 200ms 才淡入。这与 Codex "数据就绪直接渲染、要等才显示 loading"
 * 的策略同效,且不需要预判构建耗时。
 *
 * reduced-motion:扫光停(sheen 隐藏),wordmark 静态显示,延迟淡入退化为
 * 直接显示(见 globals.css 的 reduce 块)。
 */
import { useTranslation } from 'react-i18next';
import { useBrandLogo } from '@/hooks/useBrandLogo';

interface BrandLoadingMarkProps {
  /** wordmark 显示宽度(px)。高度按 logo 资产原始宽高比(2048:699)自适应。 */
  width?: number;
}

export function BrandLoadingMark({ width = 120 }: BrandLoadingMarkProps) {
  const { t } = useTranslation();
  const logo = useBrandLogo();
  const loadingLabel = t('chat.sessionLoading', '正在加载任务');
  const maskStyle = {
    maskImage: `url("${logo}")`,
    maskRepeat: 'no-repeat',
    maskSize: 'contain',
    maskPosition: 'center',
    WebkitMaskImage: `url("${logo}")`,
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskSize: 'contain',
    WebkitMaskPosition: 'center',
  } as const;
  return (
    <span
      className="brand-loading-mark relative inline-block"
      style={{ width, aspectRatio: '2048 / 699' }}
      role="status"
      aria-live="polite"
      aria-label={loadingLabel}
    >
      <img
        src={logo}
        alt=""
        className="pointer-events-none absolute inset-0 h-full w-full select-none"
        draggable={false}
      />
      <span
        className="brand-loading-mark-sheen pointer-events-none absolute inset-0 overflow-hidden"
        style={maskStyle}
        aria-hidden
      />
    </span>
  );
}
