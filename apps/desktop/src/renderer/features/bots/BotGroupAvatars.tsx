/**
 * 群的身份标记：侧栏按人数显示组合头像，顶栏与群设置用一排叠放头像。
 * 每个头像仍是 BotAvatar。侧栏组合头像的叠放间隙是真正的透明镂空，
 * 不以背景色描边模拟遮挡，避免玻璃面 hover 的半透明色叠加或透出后层头像。
 */
import { Users } from 'lucide-react';
import { useId } from 'react';

import { cn } from '@/lib/utils';
import type { BotGroupMemberView } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';

type AvatarMember = Pick<BotGroupMemberView, 'botId' | 'name' | 'avatar' | 'avatarColor'>;

/** SVG 黑白仅表示遮罩的保留/挖空，不是界面颜色；坐标相对于被遮罩头像的外框。 */
function AvatarCutout({ id, holes }: { id: string; holes: readonly { x: number; y: number; radius: number }[] }) {
  return <svg aria-hidden width="0" height="0" className="absolute pointer-events-none">
    <defs>
      <mask id={id} maskUnits="objectBoundingBox" maskContentUnits="objectBoundingBox" x="0" y="0" width="1" height="1" style={{ maskType: 'luminance' }}>
        <rect width="1" height="1" fill="white" />
        {holes.map((hole, index) => <circle key={index} cx={hole.x} cy={hole.y} r={hole.radius} fill="black" />)}
      </mask>
    </defs>
  </svg>;
}

/** 固定头像区域：双人斜向叠放，多人沿圆周聚拢，透明间隙区分前后层次。 */
export function BotGroupSidebarAvatar({
  members,
  compact = false,
}: {
  members: readonly AvatarMember[];
  compact?: boolean;
}) {
  const maskId = useId();
  const frameClass = compact ? 'h-9 w-9' : 'h-11 w-11';
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
    const positions = visible.map((_, index) => {
      const angle = (-3 * Math.PI) / 4 + (index * 2 * Math.PI) / visible.length;
      return { x: radius * (1 + Math.cos(angle)), y: radius * (1 + Math.sin(angle)) };
    });
    return (
      <span aria-hidden className={cn('relative flex shrink-0', frameClass)}>
        {visible.map((member, index) => {
          const position = positions[index];
          const id = `${maskId}-${index}`;
          // 挖去所有更前层头像的外圆；外框的 2px 留白使真实头像之间保留原有间距。
          const holes = positions.slice(index + 1).map(front => ({
            x: (front.x - position.x) / diameter + 0.5,
            y: (front.y - position.y) / diameter + 0.5,
            radius: 0.5,
          }));
          return (
            <span
              key={member.botId}
              className="absolute flex rounded-full p-0.5"
              style={{
                width: `${diameter}%`,
                height: `${diameter}%`,
                left: `${position.x}%`,
                top: `${position.y}%`,
                maskImage: holes.length ? `url("#${id}")` : undefined,
              }}
            >
              {holes.length > 0 && <AvatarCutout id={id} holes={holes} />}
              <BotAvatar bot={member} size="xs" className="h-full w-full text-11" />
            </span>
          );
        })}
      </span>
    );
  }
  const backSize = compact ? 26 : 30;
  const frontSize = backSize + 4;
  const frameSize = compact ? 36 : 44;
  const frontCenter = (frameSize - frontSize / 2) / backSize;
  return (
    <span aria-hidden className={cn('relative flex shrink-0', frameClass)}>
      <span className={cn('absolute left-0 top-0 flex', compact ? 'size-[26px]' : 'size-[30px]')}
        style={{ maskImage: `url("#${maskId}")` }}>
        <AvatarCutout id={maskId} holes={[{ x: frontCenter, y: frontCenter, radius: frontSize / (2 * backSize) }]} />
        <BotAvatar
          bot={second}
          size="xs"
          className={compact ? 'size-[26px] text-12' : 'size-[30px] text-14'}
        />
      </span>
      <span className="absolute bottom-0 right-0 flex rounded-full p-0.5">
        <BotAvatar
          bot={first}
          size="xs"
          className={compact ? 'size-[26px] text-12' : 'size-[30px] text-14'}
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
