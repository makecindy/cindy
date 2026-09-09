import { useState } from 'react';

import { GhostPluginPage } from '@/features/plugin/GhostPluginPage';
import { SkillhubHomeView } from '@/features/skillhub/SkillhubHomeView';
import { useSkillhubStoreSync } from '@/features/skillhub/SkillhubFeatureLayout';

/**
 * Settings → Plugins embeds the same Plugin / Skill catalogs.
 * Tab clicks stay inside Settings instead of routing to /plugins or /skillhub.
 * Skills store sync waits until the Skills tab is opened so entering Plugins
 * does not refetch CC sessions or scan skills on the first frame.
 */
export function SettingsCatalogPanel() {
  const [catalogTab, setCatalogTab] = useState<'plugins' | 'skills'>('plugins');
  const [skillsVisited, setSkillsVisited] = useState(false);
  const showSkills = catalogTab === 'skills' || skillsVisited;

  return (
    <div className="h-full min-h-0">
      <div className={catalogTab === 'plugins' ? 'h-full min-h-0' : 'hidden'}>
        <GhostPluginPage
          embedded
          onSelectCatalogTab={(tab) => {
            if (tab === 'skills') setSkillsVisited(true);
            setCatalogTab(tab);
          }}
        />
      </div>
      {showSkills ? (
        <SettingsSkillsPane active={catalogTab === 'skills'} onSelectTab={setCatalogTab} />
      ) : null}
    </div>
  );
}

function SettingsSkillsPane({
  active,
  onSelectTab,
}: {
  active: boolean;
  onSelectTab: (tab: 'plugins' | 'skills') => void;
}) {
  useSkillhubStoreSync();
  return (
    <div className={active ? 'h-full min-h-0' : 'hidden'}>
      <SkillhubHomeView embedded onSelectCatalogTab={onSelectTab} />
    </div>
  );
}
