import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { PersonalizationPage, PersonalizationPageTitle, UserPromptEditor } from '@/components/settings/UserPromptSection';
import { extractIpcError } from '@/utils/ipcError';
import {
  CLOUD_PERSONALIZATION_CHANNEL,
  cloudPersonalizationStateSchema,
  type CloudPersonalizationRequest,
  type CloudPersonalizationState,
} from '../../../shared/cloudPersonalization';

type Status = 'loading' | 'ready' | 'unsupported' | 'unavailable';
type Ready = Extract<CloudPersonalizationState, { status: 'ready' }>;

/**
 * The instance prompt over the private DeviceLink channel. Reads when the page is usable;
 * a rejected or unknown write rereads the Host value so the editor shows the conflict.
 */
export function useCloudUserPrompt(deviceId: string, active: boolean) {
  const [status, setStatus] = useState<Status>('loading');
  const [state, setState] = useState<CloudPersonalizationState | null>(null);
  const stateRef = useRef(state);
  const sequence = useRef(0);
  const invoke = useCallback(
    async (request: CloudPersonalizationRequest): Promise<CloudPersonalizationState> =>
      cloudPersonalizationStateSchema.parse(
        await window.electronAPI.deviceLink.invoke(deviceId, CLOUD_PERSONALIZATION_CHANNEL, [request]),
      ),
    [deviceId],
  );
  const accept = (next: CloudPersonalizationState | null) => {
    stateRef.current = next;
    setState(next);
  };
  const load = useCallback(async () => {
    const seq = ++sequence.current;
    try {
      const next = await invoke({ op: 'read' });
      if (seq !== sequence.current) return;
      accept(next);
      setStatus(next.status === 'ready' ? 'ready' : 'unavailable');
    } catch (error) {
      if (seq !== sequence.current) return;
      const code = extractIpcError(error)?.code;
      if (code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' || code === 'PERMISSION_DENIED') setStatus('unsupported');
      else setStatus(stateRef.current?.status === 'ready' ? 'ready' : 'unavailable');
    }
  }, [invoke]);
  useEffect(() => {
    sequence.current++;
    accept(null);
    setStatus('loading');
  }, [deviceId]);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const write = useCallback(
    async (build: (current: Ready) => CloudPersonalizationRequest, revision: string) => {
      const current = stateRef.current;
      if (current?.status !== 'ready' || revision !== current.revision) throw new Error('CONFLICT');
      const seq = ++sequence.current;
      try {
        const next = await invoke(build(current));
        if (seq !== sequence.current) return;
        accept(next);
        setStatus(next.status === 'ready' ? 'ready' : 'unavailable');
      } catch (error) {
        void load();
        throw error;
      }
    },
    [invoke, load],
  );
  return { status, state, write };
}

/**
 * Owner-only personal instructions of a cloud instance, edited like the local page. Older
 * runtimes without the channel keep the page heading only.
 */
export function CloudUserPromptSection({
  deviceId,
  disabled,
  onDirtyChange,
  wrap,
}: {
  deviceId: string;
  disabled: boolean;
  onDirtyChange(dirty: boolean): void;
  wrap(content: ReactNode): ReactNode;
}) {
  const { status, state, write } = useCloudUserPrompt(deviceId, !disabled);
  if (status === 'loading' || status === 'unsupported')
    return (
      <div className="pb-[14px]">
        <PersonalizationPageTitle />
      </div>
    );
  const ready = state?.status === 'ready' ? state : null;
  return wrap(
    <PersonalizationPage>
    <UserPromptEditor
      value={ready?.userPrompt ?? ''}
      ready={!!ready && !disabled}
      unavailable={!ready}
      customized={ready?.customized ?? false}
      revision={ready?.revision ?? null}
      ownerKey={`cloud:${deviceId}:${state?.ownerGeneration ?? 'none'}`}
      onDirtyChange={onDirtyChange}
      setValue={(value, revision) =>
        write(
          (current) => ({ op: 'save', ownerGeneration: current.ownerGeneration, revision, userPrompt: value }),
          revision,
        )
      }
      resetValue={(revision) =>
        write((current) => ({ op: 'reset', ownerGeneration: current.ownerGeneration, revision }), revision)
      }
    />
    </PersonalizationPage>,
  );
}
