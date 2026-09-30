/**
 * 群的身份标记：侧栏行用两位成员的叠放头像，顶栏与群设置用一排叠放头像。
 * 每个头像仍是 BotAvatar（同一套 `--bot-avatar-*` 色板），叠放处用和底色同色的
 * 2px 描边隔开——与在线状态点 `border-sidebar` 的做法一致，不引入阴影或新 token。
 */
import { Users } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { BotGroupMemberView } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';

type AvatarMember = Pick<BotGroupMemberView, 'botId' | 'name' | 'avatar' | 'avatarColor'>;

/** 40px sidebar mark: the first two members, offset diagonally. */
export function BotGroupDuoAvatar({
  members,
  selected = false,
}: {
  members: readonly AvatarMember[];
  selected?: boolean;
}) {
  const [first, second] = members;
  if (!first) {
    return (
      <span
        aria-hidden
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-tertiary)]"
      >
        <Users size={16} />
      </span>
    );
  }
  if (!second) return <BotAvatar bot={first} size="md" />;
  return (
    <span aria-hidden className="relative h-10 w-10 shrink-0">
      <BotAvatar bot={first} size="xs" className="absolute left-0.5 top-0.5 h-6 w-6 text-12" />
      <span
        className={cn(
          'absolute bottom-0 right-0 flex rounded-full border-2',
          selected ? 'border-sidebar-item-active' : 'border-sidebar group-hover:border-sidebar-item-hover',
        )}
      >
        <BotAvatar bot={second} size="xs" className="h-6 w-6 text-12" />
      </span>
    </span>
  );
}

/** A row of overlapped member avatars (header lockup and settings hero). */
export function BotGroupAvatarStack({
  members,
  size = 'xs',
  max = 3,
  className,
}: {
  members: readonly AvatarMember[];
  size?: 'xs' | 'md';
  max?: number;
  className?: string;
}) {
  const visible = members.slice(0, max);
  return (
    <span aria-hidden className={cn('flex shrink-0 items-center', className)}>
      {visible.map((member, index) => (
        <span
          key={member.botId}
          className={cn(
            'flex rounded-full border-2 border-[var(--surface)]',
            index > 0 && (size === 'xs' ? '-ml-2' : '-ml-3'),
          )}
        >
          <BotAvatar bot={member} size={size} />
        </span>
      ))}
    </span>
  );
}
