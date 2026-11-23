import { lazy, Suspense, useMemo, useState } from 'react';
import { RemotePluginPage } from '@/features/plugin/RemotePluginPage';
import {
  usePluginDeviceDirectory,
  type CatalogDeviceControl,
} from '@/features/plugin/PluginDevicePicker';

const RemoteSkillsPage = lazy(() =>
  import('@/features/skillhub/RemoteSkillsPage').then((module) => ({
    default: module.RemoteSkillsPage,
  })),
);

/**
 * The instance's plugins and skills, on the pages the client already uses for
 * another computer (Settings → Plugins with that computer chosen). The computer is fixed to
 * this instance. Everything goes over DeviceLink to the instance's Host, as for any other
 * computer; nothing here uses CIS or the remote desktop. The settings page shows its 「正在管理」
 * notice above this category as above every other, so these pages leave out theirs while it
 * says nothing more; their offline, loading and failure notices still show.
 */
export function CloudPluginManagement({
  deviceId,
  name,
  active,
}: {
  deviceId: string;
  name: string;
  active: boolean;
}) {
  const device = useMemo(() => ({ deviceId, name }), [deviceId, name]);
  const directory = usePluginDeviceDirectory(device);
  // These settings belong to the instance: no other computer can be chosen from here.
  const control: CatalogDeviceControl = {
    selected: device,
    onSelect: () => {},
    directory,
    fixed: true,
  };
  const [tab, setTab] = useState<'plugins' | 'skills'>('plugins');
  // Skills are read once their tab is opened, as on the local settings page.
  const [skillsOpened, setSkillsOpened] = useState(false);
  const select = (next: 'plugins' | 'skills') => {
    if (next === 'skills') setSkillsOpened(true);
    setTab(next);
  };
  return (
    <div className="h-full min-h-0">
      <div className={tab === 'plugins' ? 'h-full min-h-0' : 'hidden'}>
        <RemotePluginPage
          device={device}
          online={directory.online}
          active={active && tab === 'plugins'}
          embedded
          deviceControl={control}
          onSelectCatalogTab={select}
          hideManagingNotice
        />
      </div>
      {skillsOpened && (
        <div className={tab === 'skills' ? 'h-full min-h-0' : 'hidden'}>
          <Suspense fallback={null}>
            <RemoteSkillsPage
              device={device}
              online={directory.online}
              active={active && tab === 'skills'}
              embedded
              deviceControl={control}
              onSelectCatalogTab={select}
              hideManagingNotice
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
