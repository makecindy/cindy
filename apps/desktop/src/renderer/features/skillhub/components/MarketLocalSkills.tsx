import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useTranslation } from 'react-i18next';
import { skillhubCatalogKey } from '../../../../shared/skillhubCatalog';
import { useSkillhub } from '../hooks/useSkillhub';
import type { MarketSkill } from '../hooks/useMarketList';
import { LocalSkillControls } from './LocalSkillControls';

/** Match the market's installed-state policy, but retain every scanned location. */
export function MarketLocalSkills({ skill }: {
  skill: Pick<MarketSkill, 'name' | 'isMine' | 'catalogScope'>;
}) {
  const { t } = useTranslation();
  const { skills } = useSkillhub();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const copies = skills.filter((local) => {
    // Use the physically joined registry identity; casing alone cannot prove
    // ownership on case-sensitive volumes. Old scans keep exact-name matching.
    const localName = local.registryEntry ? local.registrySkillName ?? local.name : local.name;
    if (local.kind !== 'skill' || localName !== skill.name) return false;
    return local.registryEntry
      ? skillhubCatalogKey(localName, local.registryEntry.catalogScope)
        === skillhubCatalogKey(skill.name, skill.catalogScope)
      : skill.isMine;
  });
  if (copies.length === 0) return null;

  const selected = copies.find((local) => local.id === selectedId) ?? copies[0]!;
  const scopeLabel = (local: SkillhubSkill) => t(local.scope === 'project'
    ? 'skillhub.detail.scopeProject' : 'skillhub.detail.scopeGlobal');
  const locationLabel = (local: SkillhubSkill) => {
    const discoveredPath = local.discoveredPath ?? local.absolutePath;
    return local.scope === 'project' && local.projectRoot
      ? `${local.projectRoot} · ${discoveredPath}` : discoveredPath;
  };

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-l border-[var(--border-default)] pl-3">
      {copies.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" className="w-40 gap-1.5 px-3"
              aria-label={t('skillhub.sidebar.marketInstalledHeading')} title={locationLabel(selected)}>
              <span className="truncate">{scopeLabel(selected)}</span>
              <ChevronDown size={14} className="shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end"
            className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-0 rounded-xl border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5 shadow-none">
            <DropdownMenuRadioGroup value={selected.id} onValueChange={setSelectedId}>
              {copies.map((local) => (
                <DropdownMenuRadioItem key={local.id} value={local.id}
                  className="rounded-lg text-13 focus:bg-[var(--surface-hover)] data-[state=checked]:bg-[var(--surface-chip)]">
                  <span className="min-w-0">
                    <span className="block">{scopeLabel(local)}{' · '}
                      {local.registryEntry ? `v${local.registryEntry.version}` : t('skillhub.sidebar.marketLocalCopy')}
                    </span>
                    <span className="block break-all text-11 text-[var(--text-secondary)]">{locationLabel(local)}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <LocalSkillControls key={selected.id} skill={selected} />
    </div>
  );
}
