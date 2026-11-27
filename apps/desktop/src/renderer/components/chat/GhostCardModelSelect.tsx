import { useMemo, useRef, useState } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { ModelSelectorContent } from '@/components/new-chat/ModelSelector';
import { previewModelGroup, useModelGroups } from '@/features/model-groups/modelGroupsClient';
import type { ModelGroupSelection } from '../../../shared/modelGroups';
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
  const { config: modelGroupsConfig } = useModelGroups();
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
  const pickGroup = async (selection: ModelGroupSelection) => {
    const preview = await previewModelGroup(selection);
    if (preview?.outcome !== 'routed' || preview.route.agentKind === 'acp') return;
    picked.current = true;
    update({
      providerId: preview.route.providerId,
      model: preview.route.model,
      agentKind: preview.route.agentKind,
      effort: preview.route.effort ?? '',
      fastMode: preview.route.fastMode ?? false,
      ...(preview.route.agentDeviceId ? { agentDeviceId: preview.route.agentDeviceId } : {}),
      modelGroup: selection.id,
    });
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
          'flex min-h-0 w-auto max-h-[var(--radix-popover-content-available-height)] flex-col overflow-hidden rounded-xl p-0',
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
          modelGroups={{
            config: modelGroupsConfig,
            active: route?.modelGroup && modelGroupsConfig.routes.some((r) => r.id === route.modelGroup)
              ? { type: 'route', id: route.modelGroup }
              : null,
            onSelect: (selection) => { void pickGroup(selection); },
            onAttach: (selection) => {
              if (!draft.current) return;
              picked.current = true;
              update({ ...draft.current, modelGroup: selection.id });
            },
          }}
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
