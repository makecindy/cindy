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
): string | null {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage;
  const key = JSON.stringify([sessionId, startedAt, phase, active, language]);
  const [result, setResult] = useState<{ key: string; text: string | null } | null>(null);
  useEffect(() => {
    if (!active || !sessionId || phase === 'waiting-input' || phase === 'waiting-approval' || !hasPublicWorkingSubject(phase)) return;
    let current = true;
    const request = window.electronAPI?.maker?.polishWorkingStatus;
    if (!request) return;
    void request({ sessionId, phase, locale: language as SupportedLocale }).then(({ text }) => {
      if (current) setResult({ key, text });
    }).catch(() => { /* keep the immediate default */ });
    return () => { current = false; };
  }, [key, active, sessionId, phase, language]);
  return active && result?.key === key ? result.text : null;
}
