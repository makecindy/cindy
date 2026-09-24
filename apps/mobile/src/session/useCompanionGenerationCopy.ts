import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_PROTOCOL_VERSION } from '@cindy/device-link';
import { hasPublicWorkingSubject, type WorkingPhase } from '@cindy/maker-shared';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useAuth } from '@/auth/AuthContext';

/** Both list and composer read the host's per-turn/per-language cache. */
export function useCompanionGenerationCopy({ deviceId, botId, phase, active, turnId }: {
  deviceId: string; botId: string; phase: WorkingPhase | null; active: boolean; turnId: string;
}) {
  const { t, i18n } = useTranslation();
  const { invoke } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const scope = JSON.stringify([accountGeneration, deviceId, botId, turnId, phase, i18n.language, active]);
  const [caption, setCaption] = useState<{ scope: string; text: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (active && phase && hasPublicWorkingSubject(phase)) {
      void invoke<unknown>(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [{ client: {
        protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: ['status'], locale: i18n.language,
      }, ref: { collectionId: 'teammates', kind: 'bot', id: `working:${botId}/${phase}` } }]).then(value => {
        if (cancelled || !value || typeof value !== 'object') return;
        const blocks = (value as { blocks?: unknown }).blocks;
        if (!Array.isArray(blocks)) return;
        const text = blocks.find(block => block?.id === 'working' && block.primitive === 'status')?.fallbackMarkdown;
        if (typeof text === 'string' && text.trim() && text.length <= 160) setCaption({ scope, text });
      }).catch(() => { /* Older hosts retain the local factual caption. */ });
    }
    return () => { cancelled = true; };
  }, [scope, invoke]);
  return active ? caption?.scope === scope ? caption.text : t(`devices.companions.working.${phase ?? 'processing'}`) : null;
}
