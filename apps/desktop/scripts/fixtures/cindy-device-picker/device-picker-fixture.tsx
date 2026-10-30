import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppFrame, mountPage } from '../../ui-page/harness';
import { CindyDeviceRow } from '../../../src/renderer/features/bots/CindyDeviceRow';
import { cindyDeviceOptions } from '../../../src/renderer/features/bots/cindyDeviceRoster';
import { Select } from '../../../src/renderer/components/ui/select';

// Roster hooks are replaced at build time (ui-page.mjs `stubs`); the row, picker,
// Radix select, routing, theme and fonts are the production implementations.
type Roster = Parameters<typeof cindyDeviceOptions>;

function DevicePickerPage({ data }: { data: Record<string, unknown> }) {
  const { t } = useTranslation();
  const roster = data as unknown as {
    bots: Roster[0];
    remoteBots: Roster[1];
    devices: Roster[2];
    unread: Roster[3];
    currentIndex: number;
    selected: boolean;
  };
  const options = cindyDeviceOptions(
    roster.bots,
    roster.remoteBots,
    roster.devices,
    roster.unread,
    t('bots.devicePicker.local'),
  );
  const [current, setCurrent] = useState(options[roster.currentIndex]);
  const [opens, setOpens] = useState(0);
  const [selections, setSelections] = useState(0);
  const route = useLocation();
  // Sidebar list containers mirror TeammatesSection (section > list > rows).
  const sidebar = (
    <div className="flex w-full flex-col gap-0.5 pt-3" data-sidebar-section="teammates">
      <div className="flex flex-col pt-1 pr-0 pl-3">
        <div className="flex flex-col gap-1" data-ui-page-subject>
          <CindyDeviceRow
            current={current}
            options={options}
            selected={roster.selected}
            subtitle={t('bots.list.startChat')}
            timestamp="13:56"
            onOpen={() => setOpens((count) => count + 1)}
            onSelect={(option) => {
              setCurrent(option);
              setSelections((count) => count + 1);
            }}
          />
        </div>
      </div>
    </div>
  );
  return (
    <AppFrame sidebar={sidebar}>
      <div className="min-h-0 flex-1 p-6">
        <output hidden data-testid="opens">
          {opens}
        </output>
        <output hidden data-testid="selections">
          {selections}
        </output>
        <output hidden data-testid="route">
          {route.pathname}
        </output>
        {/* Control sample: the shared Select must keep its trigger-width menu. */}
        <div data-testid="ordinary-select" style={{ width: 180 }}>
          <Select
            label="Select"
            value="one"
            options={[{ value: 'one', label: 'Option' }]}
            onValueChange={() => {}}
            className="w-full"
          />
        </div>
      </div>
    </AppFrame>
  );
}

void mountPage({
  route: '/bots/cindy-default',
  render: (ctx) => <DevicePickerPage data={ctx.data} />,
});
