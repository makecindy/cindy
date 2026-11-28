/**
 * The requester's own group-Cindy requests held until they choose a computer (bot-group-chat.md
 * 第 9 节). Docked above the composer and shown only to them: the rest of the group sees no notice,
 * running state or timeline entry for it. Continue binds the computer, which releases every held
 * request; cancel ends them. Both use the group's ordinary management call.
 */
import { useEffect, useRef, useState } from 'react';
import { EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { BotGroupSummary, ChatGroupAction } from '../../../shared/botGroupChat';
import { chatErrorKey } from './chatError';
import { refreshBotGroups } from './botGroupStore';

const key = (name: string) => `bots.groupChat.assistantDevice.${name}`;

type Group = Pick<BotGroupSummary, 'id' | 'assistantComputers' | 'assistantDeviceWaits'>;

export function BotGroupAssistantDeviceCard({ group }: { group: Group }) {
  const { t } = useTranslation();
  const computers = group.assistantComputers ?? [];
  const waits = group.assistantDeviceWaits ?? [];
  const [deviceId, setDeviceId] = useState('');
  const [pending, setPending] = useState<'continue' | 'cancel' | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const chosen = computers.some(computer => computer.id === deviceId) ? deviceId : computers[0]?.id ?? '';
  if (!waits.length || !computers.length) return null;

  const run = async (kind: 'continue' | 'cancel', actions: ChatGroupAction[]) => {
    if (pending) return;
    setPending(kind); setError('');
    const owner = getDataOwnerGeneration();
    try {
      for (const action of actions) {
        const result = await window.electronAPI.maker.chatServer.manage({ groupId: group.id, action });
        if (!result.ok) {
          if (mounted.current && isDataOwnerGenerationCurrent(owner)) setError(t(chatErrorKey(result.errorCode)));
          return;
        }
      }
    } catch {
      if (mounted.current && isDataOwnerGenerationCurrent(owner)) setError(t(chatErrorKey('REQUEST_FAILED')));
    } finally {
      refreshBotGroups();
      if (mounted.current) setPending(null);
    }
  };

  const [first] = waits;
  const request = waits.length > 1 ? t(key('requests'), { count: waits.length })
    : first.requestText ? t(key('request'), { request: first.requestText }) : t(key('requestUnknown'));
  return (
    <section data-testid="bot-group-assistant-device" aria-labelledby="bot-group-assistant-device-title"
      className="mb-2 w-full rounded-xl border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 id="bot-group-assistant-device-title" className="min-w-0 text-15 font-medium leading-6 text-[var(--text-primary)]">
          {t(key('title'))}
        </h2>
        <span className="inline-flex shrink-0 items-center gap-1 text-12 leading-5 text-[var(--text-tertiary)]">
          <EyeOff size={12} aria-hidden />{t(key('onlyYou'))}
        </span>
      </div>
      {/* Two sentences, two lines: languages join sentences differently (no space in Chinese or Japanese). */}
      <p className="mt-1 break-words text-13 leading-5 text-[var(--text-secondary)] [overflow-wrap:anywhere]">{request}</p>
      <p className="break-words text-13 leading-5 text-[var(--text-secondary)]">{t(key('remember'))}</p>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Select size="compact" label={t('bots.groupChat.server.settings.assistantComputer')} value={chosen}
          className="mr-auto w-[220px] max-w-full" truncateOptions disabled={!!pending}
          options={computers.map(computer => ({ value: computer.id, label: computer.name }))} onValueChange={setDeviceId} />
        {/* The two answers wrap together, never one per line. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={!!pending} loading={pending === 'cancel'}
            onClick={() => void run('cancel', waits.map(wait => ({ type: 'cancelAssistantDeviceWait', executionId: wait.executionId })))}>
            {t(key('cancel'))}
          </Button>
          <Button type="button" variant="primary" size="sm" disabled={!!pending || !chosen} loading={pending === 'continue'}
            onClick={() => void run('continue', [{ type: 'assistantDevice', deviceId: chosen }])}>
            {t(key('continue'))}
          </Button>
        </div>
      </div>
      {error ? <p role="alert" className="mt-2 text-12 leading-5 text-[var(--error-fg)]">{error}</p> : null}
    </section>
  );
}
