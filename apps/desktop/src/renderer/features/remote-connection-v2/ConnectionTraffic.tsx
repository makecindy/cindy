import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SegmentedControl } from '@/components/ui/segmented-control';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import type { LinkTrafficSnapshot } from '../../../shared/deviceLinkIpc';
import { ProtocolMark } from './ProtocolMark';
import { protocolKindLabel } from './topologyPresentation';

const key = 'settings.remoteControl.v2.traffic';
const ranges = ['last5m', 'lastHour', 'lastDay'] as const;

export function ConnectionTraffic({ traffic }: { traffic?: LinkTrafficSnapshot }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<keyof LinkTrafficSnapshot>('last5m');
  const title = t(`${key}.title`);
  return (
    <section aria-label={title} className="space-y-2 border-t border-[var(--settings-theme-card-border)] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-13 font-medium text-[var(--text-primary)]">{title}</h3>
        <SegmentedControl
          aria-label={t(`${key}.range`)}
          value={range}
          options={ranges.map(value => ({ value, label: t(`${key}.${value}`) }))}
          onValueChange={setRange}
          density="sm"
        />
      </div>
      <table aria-label={title} className="w-full text-right text-12 tabular-nums text-[var(--text-secondary)]">
        <thead className="text-[var(--text-tertiary)]">
          <tr>
            <th scope="col" className="text-left font-normal">{t('settings.remoteControl.v2.popover.protocol')}</th>
            <th scope="col" className="font-normal">{t(`${key}.sent`)}</th>
            <th scope="col" className="font-normal">{t(`${key}.received`)}</th>
            <th scope="col" className="font-normal">{t(`${key}.total`)}</th>
          </tr>
        </thead>
        <tbody>
          {(['device-link', 'agent-net'] as const).map(protocol => {
            const bytes = traffic?.[range][protocol];
            return (
              <tr key={protocol}>
                <th scope="row" className="py-1 text-left font-normal">
                  <ProtocolMark kind={protocol} label={protocolKindLabel(protocol, t)!} />
                </th>
                <td>{bytes ? formatBytes(bytes.sent) : '—'}</td>
                <td>{bytes ? formatBytes(bytes.received) : '—'}</td>
                <td className="font-medium text-[var(--text-primary)]">{bytes ? formatBytes(bytes.sent + bytes.received) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-11 text-[var(--text-tertiary)]">{t(`${key}.scope`)}</p>
    </section>
  );
}
