import { REMOTE_RESOURCE_GET_CHANNEL } from '@cindy/device-link';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SupportedLocale } from '../../../shared/locale';
import { hasPublicWorkingSubject, type PlainAgentPhase } from '../../../shared/workingStatus';

/** Optional enhancement: default copy never waits for IPC or the model. */
export function useWorkingStatusCopy(
  sessionId: string | undefined,
  startedAt: number | null,
  phase: PlainAgentPhase,
  active: boolean,
  remote?: { deviceId: string; botId: string },
): string | null {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage;
  const key = JSON.stringify([sessionId, startedAt, phase, active, language, remote?.deviceId, remote?.botId]);
  const [result, setResult] = useState<{ key: string; text: string | null } | null>(null);
  useEffect(() => {
    if (!active || !sessionId || phase === 'waiting-input' || phase === 'waiting-approval' || !hasPublicWorkingSubject(phase)) return;
    let current = true;
    const request = remote
      ? async (input: { phase: string; locale: string }) => {
        const value = await window.electronAPI.deviceLink.invoke(remote.deviceId, REMOTE_RESOURCE_GET_CHANNEL, [{
          client: { protocolVersion: 1, primitives: ['status'], locale: input.locale },
          ref: { collectionId: 'teammates', kind: 'bot', id: `working:${remote.botId}/${input.phase}` },
        }]) as { blocks?: { id: string; fallbackMarkdown?: string }[] };
        return { text: value.blocks?.find(block => block.id === 'working')?.fallbackMarkdown || null };
      } : window.electronAPI?.maker?.polishWorkingStatus;
    if (!request) return;
    void request({ sessionId, phase, locale: language as SupportedLocale }).then(({ text }) => {
      if (current) setResult({ key, text });
    }).catch(() => { /* keep the immediate default */ });
    return () => { current = false; };
  }, [key, active, sessionId, phase, language]);
  return active && result?.key === key ? result.text : null;
}
