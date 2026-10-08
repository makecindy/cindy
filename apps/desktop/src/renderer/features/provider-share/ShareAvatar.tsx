/**
 * 分享双方的头像：只用对方账号的头像与昵称(产品规则 §6)。头像缺失或加载失败时显示昵称首字。
 */
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

import { shareAvatarInitial } from './providerShareFormat';

export function ShareAvatar({
  displayName,
  avatarUrl,
  size = 'md',
  className,
}: {
  displayName: string;
  avatarUrl: string | null | undefined;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatarUrl]);
  const frame = cn(
    'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full',
    size === 'sm' && 'h-7 w-7 text-12',
    size === 'md' && 'h-8 w-8 text-13',
    size === 'lg' && 'h-10 w-10 text-15',
    className,
  );
  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        draggable={false}
        className={cn(frame, 'object-cover')}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(frame, 'select-none bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]')}
    >
      {shareAvatarInitial(displayName)}
    </span>
  );
}
