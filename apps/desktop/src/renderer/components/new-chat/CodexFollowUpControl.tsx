import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { Tip } from '@/components/ui/tooltip';
import { makerApiForSticky } from '@/lib/makerTransport';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from '@/components/settings/DefaultOverrideControls';
import type { CodexFollowUpMode, CodexFollowUpState } from '../../../shared/codexFollowUp';

export function CodexFollowUpControl({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation();
  const id = useId();
  const [state, setState] = useState<CodexFollowUpState | null>(null);
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);
  const generation = useRef(0);
  const saving = useRef(false);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    if (!window.electronAPI?.maker?.codexFollowUp) {
      setSupported(false);
      return;
    }
    setState(null);
    setSupported(true);
    const deviceId = sessionId ? getStickySessionDeviceId(sessionId) : null;
    const current = () => alive && (!sessionId || getStickySessionDeviceId(sessionId) === deviceId);
    const load = async () => {
      const token = ++generation.current;
      try {
        const api = sessionId ? makerApiForSticky(sessionId) : window.electronAPI.maker;
        if (sessionId) {
          const projection = await api.input.getProjection(sessionId);
          if (!current() || token !== generation.current) return;
          if (!projection.composerAutoDelivery) {
            setSupported(false);
            return;
          }
        }
        setSupported(true);
        const value = await api.codexFollowUp.get(sessionId);
        if (current() && token === generation.current && !saving.current) setState(value);
      } catch {
        /* Keep the last confirmed value; focus retries the read. */
      }
    };
    refresh.current = () => {
      void load();
    };
    void load();
    const offGlobal = window.electronAPI.maker.codexFollowUp.onChanged(() => {
      void load();
    });
    const offLocal = sessionId
      ? window.electronAPI.maker.onInputProjection((projection) => {
          if (
            !deviceId &&
            projection.sessionId === sessionId &&
            projection.codexFollowUp &&
            current()
          ) {
            ++generation.current;
            setState(projection.codexFollowUp);
          }
        })
      : () => {};
    const offRemote =
      sessionId && deviceId
        ? window.electronAPI.deviceLink.onRemotePush((push, ownerStamp) => {
            if (
              push.deviceId !== deviceId ||
              push.channel !== 'maker:input:projection' ||
              !isDeviceLinkRemotePushCurrent(push, ownerStamp)
            )
              return;
            const projection = push.payload as {
              sessionId?: string;
              codexFollowUp?: CodexFollowUpState;
            };
            if (projection.sessionId === sessionId && projection.codexFollowUp && current()) {
              ++generation.current;
              setState(projection.codexFollowUp);
            }
          })
        : () => {};
    window.addEventListener('focus', refresh.current);
    const focus = refresh.current;
    return () => {
      alive = false;
      ++generation.current;
      offGlobal();
      offLocal();
      offRemote();
      window.removeEventListener('focus', focus);
    };
  }, [sessionId]);
  const save = async (value: string) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    const token = ++generation.current;
    try {
      const mode = value === 'inherit' ? null : (value as CodexFollowUpMode);
      const result = sessionId
        ? await makerApiForSticky(sessionId).codexFollowUp.setSession(sessionId, mode)
        : await window.electronAPI.maker.codexFollowUp.setGlobal(mode);
      if (token === generation.current) setState(result);
    } catch {
      toast.error(t('codexFollowUp.saveFailed'));
    } finally {
      saving.current = false;
      if (token === generation.current) setBusy(false);
      else {
        setBusy(false);
        refresh.current();
      }
    }
  };
  if (!supported) return null;
  const label = t(sessionId ? 'codexFollowUp.taskLabel' : 'codexFollowUp.globalLabel');
  const hint = t(sessionId ? 'codexFollowUp.taskHint' : 'codexFollowUp.globalHint');
  const options = [
    ...(sessionId
      ? [
          {
            value: 'inherit',
            label: t('codexFollowUp.inherit', {
              mode: t(
                state?.globalMode === 'steer' ? 'codexFollowUp.steer' : 'codexFollowUp.queue',
              ),
            }),
          },
        ]
      : []),
    { value: 'queue', label: t('codexFollowUp.queue') },
    { value: 'steer', label: t('codexFollowUp.steer') },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="codex-follow-up-control">
      <Tip text={hint} side="top">
        <label htmlFor={id} className="text-12 leading-[1.5] text-[var(--text-secondary)]">
          {label}
        </label>
      </Tip>
      <Tip text={hint} side="top">
        <span>
          <Select
            id={id}
            label={label}
            aria-describedby={`${id}-hint`}
            value={sessionId ? (state?.override ?? 'inherit') : (state?.globalMode ?? 'queue')}
            options={options}
            disabled={busy || !state}
            onValueChange={(value) => {
              void save(value);
            }}
            className={sessionId ? 'h-8 min-w-[100px] px-2' : 'min-w-[100px]'}
          />
        </span>
      </Tip>
      <span id={`${id}-hint`} className="sr-only">
        {hint}
      </span>
      {!sessionId && (
        <DefaultOverrideControls
          isCustomized={state?.isCustomized ?? false}
          onReset={() => {
            void save('inherit');
          }}
        />
      )}
    </div>
  );
}
