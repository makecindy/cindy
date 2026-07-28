/**
 * ProviderLogoMark —— 模型供应商的单色官方 Logo。
 *
 * 品牌路径与 provider id/upstream 识别由 @cindy/model-providers/branding 在 Desktop / Mobile
 * 间共享；本组件只负责把共享品牌数据渲染成 currentColor SVG。
 */

import {
  hasProviderLogo,
  isProviderLogoKind,
  PROVIDER_LOGO_PATHS,
  resolveProviderLogoKind,
  type ProviderLogoKind,
  type ProviderLogoRouting,
} from '@cindy/model-providers/branding';

import { AnthropicMark } from './AnthropicMark';
import { OpenAIMark } from './OpenAIMark';
import { XDIncMark } from './XDIncMark';

export { hasProviderLogo, resolveProviderLogoKind };
export type { ProviderLogoRouting };

interface ProviderLogoMarkProps {
  providerId: string;
  routing?: ProviderLogoRouting;
  /** Device-link projection resolved this before stripping private routing details. */
  logoKind?: ProviderLogoKind;
  size?: number;
  className?: string;
}

/** 按稳定 provider / preset id 渲染供应商 Logo；未知 id 返回 null，由调用方决定兜底。 */
export function ProviderLogoMark({
  providerId,
  routing,
  logoKind,
  size = 14,
  className,
}: ProviderLogoMarkProps) {
  const kind = isProviderLogoKind(logoKind)
    ? logoKind
    : resolveProviderLogoKind(providerId, routing);
  if (!kind) return null;
  if (kind === 'anthropic') return <AnthropicMark size={size} className={className} />;
  if (kind === 'openai') return <OpenAIMark size={size} className={className} />;
  if (kind === 'xd') return <XDIncMark size={size} className={className} />;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path d={PROVIDER_LOGO_PATHS[kind]} fill="currentColor" />
    </svg>
  );
}
