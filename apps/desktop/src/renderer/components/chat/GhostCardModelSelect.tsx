import { useRef, useState } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { ModelSelectorContent } from '@/components/new-chat/ModelSelector';
import { useTransientModelPickerPreferences } from '@/components/new-chat/modelPickerPreferences';
import { useModelPickerAgents } from '@/hooks/useAvailableAgents';
import { cn } from '@/lib/utils';
import type { Effort } from '@/lib/userPreferences.types';
import type { PluginTaskRoute } from '../../../shared/pluginTasks';

/**
 * 插件卡内的模型下拉框(data-ghost-model-select):锚在被点按钮下方,内容与输入框的
 * 模型选择器同一套。选中模型即收起;改推理强度 / 快速模式在收起时一并交回。
 * 只改这次的草稿,不写用户自己的模型偏好。
 */
export function GhostCardModelSelect({
  rect,
  initial,
  onSelect,
  onClose,
}: {
  /** 被点按钮在卡片锚容器内的位置。 */
  rect: { top: number; left: number; width: number; height: number };
  initial: PluginTaskRoute | null;
  onSelect(route: PluginTaskRoute): void;
  onClose(): void;
}) {
  const [route, setRoute] = useState(initial);
  const draft = useRef(initial);
  const closed = useRef(false);
  const preferenceStore = useTransientModelPickerPreferences();
  const agents = useModelPickerAgents(
    route?.agentKind === 'cc' ? 'claude-code' : (route?.agentKind ?? 'codex'),
  );
  const update = (next: PluginTaskRoute | null) => {
    draft.current = next;
    setRoute(next);
  };
  const close = () => {
    if (closed.current) return;
    closed.current = true;
    const next = draft.current;
    if (next && JSON.stringify(next) !== JSON.stringify(initial)) onSelect(next);
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
          onDismiss={close}
          onModelChange={() => false}
          onEffortChange={(effort) => {
            if (draft.current) update({ ...draft.current, effort });
          }}
          onFastModeChange={(fastMode) => {
            if (draft.current) update({ ...draft.current, fastMode });
          }}
          onUnifiedSelect={({ providerId, modelId, engine, effort, fast }) => {
            update({ providerId, model: modelId, agentKind: engine, effort: effort ?? '', fastMode: fast });
            return true;
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
