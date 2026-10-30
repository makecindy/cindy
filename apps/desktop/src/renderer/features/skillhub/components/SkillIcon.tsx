import { useState } from 'react';
import { Package } from 'lucide-react';

const DEFAULT_SKILL_ICON_URL = /\/assets\/default-skill-icon(?:-v\d+)?\.svg(?:[?#]|$)/i;

/** 默认占位与本地 Skill 共用 Package 图标；仅真正配置的市场图标使用图片。 */
export function SkillIcon({ url }: { url?: string }) {
  const normalizedUrl = url?.trim() || null;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const useRemoteIcon = normalizedUrl !== null
    && normalizedUrl !== failedUrl
    && !DEFAULT_SKILL_ICON_URL.test(normalizedUrl);

  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[22%] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--plugin-card-shadow)]">
      {useRemoteIcon ? (
        <img
          src={normalizedUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="size-full object-cover"
          onError={() => setFailedUrl(normalizedUrl)}
          referrerPolicy="no-referrer"
        />
      ) : (
        <Package size={17} strokeWidth={1.75} aria-hidden="true" />
      )}
    </span>
  );
}
