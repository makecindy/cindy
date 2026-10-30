/**
 * 群的身份标记：侧栏按人数显示组合头像，顶栏与群设置用一排叠放头像。
 * 每个头像仍是 BotAvatar（同一套 `--bot-avatar-*` 色板），叠放处用和底色同色的
 * 描边隔开——与离线状态点 `border-sidebar` 的做法一致，不引入阴影或新 token。
 */
import { Users } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { BotGroupMemberView } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';

type AvatarMember = Pick<BotGroupMemberView, 'botId' | 'name' | 'avatar' | 'avatarColor'>;

/** 固定头像区域：双人斜向叠放，多人沿圆周聚拢，描边区分前后层次。 */
export function BotGroupSidebarAvatar({
  members,
  selected = false,
  compact = false,
}: {
  members: readonly AvatarMember[];
  selected?: boolean;
  compact?: boolean;
}) {
  const frameClass = compact ? 'h-12 w-12' : 'h-11 w-11';
  const [first, second] = members;
  if (!first) {
    return (
      <span
        aria-hidden
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-tertiary)]',
          frameClass,
        )}
      >
        <Users size={16} />
      </span>
    );
  }
  if (!second) return <BotAvatar bot={first} size={compact ? 'strip' : 'row'} />;
  if (members.length >= 3) {
    // 先取群里的前五位，再从后向前绘制：第一位最后绘制，完整露在最前层。
    const visible = members.slice(0, 5).reverse();
    // 与手机共用比例：3/4/5 人分别占头像框的 60%/55%/50%。
    const diameter = visible.length === 3 ? 60 : visible.length === 4 ? 55 : 50;
    const radius = (100 - diameter) / 2;
    return (
      <span aria-hidden className={cn('relative flex shrink-0', frameClass)}>
        {visible.map((member, index) => {
          const angle = (-3 * Math.PI) / 4 + (index * 2 * Math.PI) / visible.length;
          return (
            <span
              key={member.botId}
              className={cn(
                'absolute flex rounded-full',
                'border-2',
                selected
                  ? 'border-sidebar'
                  : 'border-sidebar group-hover:border-sidebar-item-hover',
              )}
              style={{
                width: `${diameter}%`,
                height: `${diameter}%`,
                left: `${radius * (1 + Math.cos(angle))}%`,
                top: `${radius * (1 + Math.sin(angle))}%`,
              }}
            >
              <BotAvatar bot={member} size="xs" className="h-full w-full text-11" />
            </span>
          );
        })}
      </span>
    );
  }
  return (
    <span aria-hidden className={cn('relative flex shrink-0', frameClass)}>
      <BotAvatar
        bot={second}
        size="xs"
        className={cn(
          'absolute',
          compact ? 'left-0 top-0 size-[34px] text-14' : 'left-0 top-0 size-[30px] text-14',
        )}
      />
      <span
        className={cn(
          'absolute bottom-0 right-0 flex rounded-full',
          'border-2',
          selected
            ? 'border-sidebar'
            : 'border-sidebar group-hover:border-sidebar-item-hover',
        )}
      >
        <BotAvatar
          bot={first}
          size="xs"
          className={compact ? 'size-[34px] text-14' : 'size-[30px] text-14'}
        />
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
