import { useMemo, useRef, useState } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { ModelSelectorContent } from '@/components/new-chat/ModelSelector';
import { useTransientModelPickerPreferences } from '@/components/new-chat/modelPickerPreferences';
import { useProviderShareAgentDevices } from '@/features/provider-share/useProviderShareAgentDevices';
import { useModelPickerAgents } from '@/hooks/useAvailableAgents';
import { useSelectableDevices } from '@/hooks/useControllableDevices';
import { cn } from '@/lib/utils';
import type { Effort } from '@/lib/userPreferences.types';
import type { GhostCardModelSelection } from '../../../shared/ghost';

/**
 * 插件卡内的模型下拉框(data-ghost-model-select):锚在被点按钮下方,内容与输入框的
 * 模型选择器同一套,也列出同账号其他电脑和分享来的供应商。选中模型即收起;改推理强度 /
 * 快速模式在收起时一并交回。只改这次的草稿,不写用户自己的模型偏好。
 */
export function GhostCardModelSelect({
  rect,
  initial,
  onSelect,
  onClose,
}: {
  /** 被点按钮在卡片锚容器内的位置。 */
  rect: { top: number; left: number; width: number; height: number };
  initial: GhostCardModelSelection | null;
  onSelect(route: GhostCardModelSelection): void;
  onClose(): void;
}) {
  const [route, setRoute] = useState(initial);
  const draft = useRef(initial);
  const closed = useRef(false);
  // A model row was chosen (even the current one): that is a decision to dispatch, unlike an outside click.
  const picked = useRef(false);
  const agentDeviceId = route?.agentDeviceId ?? null;
  const preferenceStore = useTransientModelPickerPreferences();
  const agents = useModelPickerAgents(
    route?.agentKind === 'cc' ? 'claude-code' : (route?.agentKind ?? 'codex'),
  );
  // 远程位置与新建任务同一份:在线的同账号电脑(当前选中的离线电脑也保留),加上收到的分享。
  const { devices: selectable } = useSelectableDevices();
  const { devices: shares } = useProviderShareAgentDevices([agentDeviceId]);
  const devices = useMemo(
    () => [
      ...selectable
        .filter((device) => device.online || device.deviceId === agentDeviceId)
        .map(({ deviceId, name }) => ({ deviceId, name })),
      ...shares,
    ],
    [selectable, shares, agentDeviceId],
  );
  const update = (next: GhostCardModelSelection | null) => {
    draft.current = next;
    setRoute(next);
  };
  const close = () => {
    if (closed.current) return;
    closed.current = true;
    const next = draft.current;
    if (next && (picked.current || JSON.stringify(next) !== JSON.stringify(initial))) onSelect(next);
    onClose();
  };
  return (
    <Popover open onOpenChange={(open) => { if (!open) close(); }}>
      <PopoverAnchor asChild>
        <div aria-hidden className="pointer-events-none absolute" style={rect} />
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className={cn(
          'flex min-h-0 w-auto max-h-[var(--radix-popover-content-available-height)] flex-col overflow-hidden rounded-[12px] p-0',
          'border border-[var(--model-dropdown-border)] bg-[var(--model-dropdown-bg)]',
        )}
      >
        <ModelSelectorContent
          preferenceStore={preferenceStore}
          modelId={route?.model ?? ''}
          currentProviderId={route?.providerId ?? null}
          vendorKey={route?.agentKind}
          effort={(route?.effort ?? '') as Effort}
          fastMode={route?.fastMode ?? false}
          unifiedAgents={agents}
          remoteAgent={{ devices, selectedDeviceId: agentDeviceId }}
          onDismiss={close}
          onModelChange={() => false}
          onEffortChange={(effort) => {
            if (draft.current) update({ ...draft.current, effort });
          }}
          onFastModeChange={(fastMode) => {
            if (draft.current) update({ ...draft.current, fastMode });
          }}
          onUnifiedSelect={({ providerId, modelId, engine, effort, fast, agentDevice }) => {
            picked.current = true;
            update({
              providerId,
              model: modelId,
              agentKind: engine,
              effort: effort ?? '',
              fastMode: fast,
              ...(agentDevice?.deviceId ? { agentDeviceId: agentDevice.deviceId } : {}),
            });
            return true;
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
