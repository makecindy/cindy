import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { PlatformGlyph } from './PlatformGlyph';
import './remote-connection-v2.css';

export function DeviceCardHeading({
  name,
  sub,
  subAccessory,
  platform,
  isMobile,
}: {
  name: string;
  sub: string;
  subAccessory?: ReactNode;
  platform: string | null;
  isMobile: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      {/* 与拓扑同一套外形:电脑方块,手机带「灵动岛」的竖条 */}
      <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden>
        <span
          className={cn(
            'rcv2-tile relative flex items-center justify-center rounded-lg border',
            isMobile ? 'h-8 w-5' : 'size-8',
          )}
          data-form={isMobile ? 'phone' : undefined}
        >
          {isMobile ? <span className="rcv2-island" /> : null}
          <PlatformGlyph platform={platform} isMobile={isMobile} size={isMobile ? 12 : 15} />
        </span>
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="break-words text-13 font-medium leading-[1.35] text-[var(--text-primary)]" title={name}>
          {name}
        </span>
        {sub ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="break-words text-12 leading-[1.35] text-[var(--text-secondary)]" title={sub}>
              {sub}
            </span>
            {subAccessory}
          </div>
        ) : null}
      </div>
    </div>
  );
}
