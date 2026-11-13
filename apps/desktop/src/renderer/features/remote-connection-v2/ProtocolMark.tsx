/**
 * ProtocolMark —— 一台设备用哪种连接方式:图标 + 名称(拓扑行与设备卡片共用)。
 * Agent-Net 是网络节点图标、紫色 --remote-agent-net-accent;Device Link 是链环图标、跟随所在文字的灰色
 * (用户裁决 2026-11-13,DESIGN.md §2「Remote connection V2 topology」)。紫色只表示协议，不表示状态。
 */

import { Link2, Waypoints } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { ProtocolKind } from './topologyPresentation';

export function ProtocolMark({ kind, label, className }: { kind: ProtocolKind; label: string; className?: string }) {
  const Icon = kind === 'agent-net' ? Waypoints : Link2;
  return (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-full items-center gap-1',
        className,
        // 放在 className 之后:调用方给的灰色只作用于 Device Link
        kind === 'agent-net' && 'font-medium text-[var(--remote-agent-net-accent)]',
      )}
    >
      <Icon className="size-3 shrink-0" strokeWidth={2} aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
