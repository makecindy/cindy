import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { mountPage } from '../../ui-page/harness';
import { BotSettingsSaveStatus } from '../../../src/renderer/features/bots/BotSettingsSaveStatus';
import { useBotSettingsAutosave } from '../../../src/renderer/features/bots/useBotSettingsAutosave';
import { normalizeBotSettingsPayload } from '../../../src/renderer/features/bots/botSettingsAutosave';
import type { BotCapabilities } from '../../../src/renderer/features/bots/botStore';

function Fixture() {
  const { t } = useTranslation();
  const [name, setName] = useState('Buddy');
  const draft = { name, description: '', identitySource: '', userContextSource: '', avatar: '', avatarColor: '', skills: [],
    capabilities: {} as BotCapabilities };
  const baseline = useRef(normalizeBotSettingsPayload(draft, 'Buddy'));
  const autosave = useBotSettingsAutosave({ draft, fallbackName: 'Buddy', enabled: true, baseline,
    commit: async payload => {
      await new Promise<void>(resolve => window.addEventListener('fixture:confirm-save', () => resolve(), { once: true }));
      baseline.current = payload;
    } });
  return <main className="min-h-screen bg-[var(--surface)] px-5 text-[var(--text-primary)]">
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center"><ArrowLeft size={18} /></span>
        <h2 className="text-14 font-medium">{t('bots.settingsTabs.model')}</h2>
      </div>
      <BotSettingsSaveStatus autosave={autosave} modelPage sourceTooLong={false} />
    </div>
    <button data-ui-page-control onClick={() => { setName('Edited buddy'); autosave.onEdit('model'); }}>Edit model</button>
    <button data-ui-page-control onClick={() => { setName('Edited profile'); autosave.onEdit('instant'); }}>Edit profile</button>
  </main>;
}

void mountPage({ render: () => <Fixture /> });
