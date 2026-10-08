/** Universal host retirement page. No former plugin code, settings, or webview is mounted. */
import { Info, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { InstalledGhost } from '../../../shared/ghost';
import { featureRetirementById } from '../../../shared/featureRetirements';
import { GhostPluginIcon } from './GhostPluginIcon';
import { PluginDetailTopBar, usePluginDetailScrolled } from './PluginDetailTopBar';

export function RetiredFeatureDetail({
  ghost,
  replacement,
  busy,
  onBack,
  onReplace,
  onDismiss,
  onUninstall,
}: {
  ghost: InstalledGhost;
  replacement?: InstalledGhost;
  busy: boolean;
  onBack: () => void;
  onReplace: () => void;
  onDismiss: () => void;
  onUninstall: () => void;
}) {
  const { t } = useTranslation();
  const { scrolled, onScroll } = usePluginDetailScrolled();
  const descriptor = featureRetirementById(ghost.retirement!.id);
  if (!descriptor) return null;
  const base = 'settings.ghosts.retirement';
  return (
    <div className="h-full overflow-y-auto bg-[var(--surface)]" onScroll={onScroll}>
      <PluginDetailTopBar label={t('settings.ghosts.title')} onBack={onBack} scrolled={scrolled} />
      <article className="mx-auto max-w-[824px] px-8 pb-12 pt-5">
        <header className="flex items-center gap-5">
          <GhostPluginIcon
            iconDataUrl={ghost.iconDataUrl}
            iconId={ghost.manifest.id}
            iconName={ghost.manifest.name}
            size="detail"
          />
          <div>
            <h1 className="text-28 font-medium text-[var(--text-primary)]">
              {ghost.manifest.name}
            </h1>
            <p className="mt-2 text-13 text-[var(--text-tertiary)]">{t(`${base}.status`)}</p>
          </div>
        </header>
        <section className="mt-8 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6">
          <div className="flex items-center gap-2 text-[var(--text-primary)]">
            <Info size={18} />
            <h2 className="text-16 font-medium">{t(`${descriptor.copyKey}.title`)}</h2>
          </div>
          <p className="mt-3 text-14 leading-6 text-[var(--text-secondary)]">
            {t(`${descriptor.copyKey}.description`)}
          </p>
        </section>
        {ghost.retirement?.eligible && descriptor.replacement ? (
          <section className="mt-6 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6">
            <p className="text-12 text-[var(--text-tertiary)]">{t(`${base}.recommendation`)}</p>
            <h2 className="mt-3 text-20 font-medium text-[var(--text-primary)]">
              {t(`${descriptor.copyKey}.replacementName`)}
            </h2>
            <p className="mt-1 text-12 text-[var(--text-tertiary)]">
              Cindy · {t('settings.ghosts.title')}
            </p>
            <p className="mt-4 text-14 leading-6 text-[var(--text-secondary)]">
              {t(`${descriptor.copyKey}.replacementDescription`)}
            </p>
            <p className="mt-2 text-12 leading-5 text-[var(--text-tertiary)]">
              {t(`${descriptor.copyKey}.requirements`)}
            </p>
            {replacement && (
              <p className="mt-4 flex items-center gap-2 text-13 text-[var(--text-secondary)]">
                <CheckCircle2 size={16} />
                {t(`${base}.${replacement.enabled ? 'installed' : 'installedDisabled'}`)}
              </p>
            )}
            <div className="mt-5 flex flex-wrap gap-3">
              <Button variant="cta" loading={busy} disabled={busy} onClick={onReplace}>
                {t(
                  `${base}.${replacement ? (replacement.enabled ? 'open' : 'enable') : 'install'}`,
                  { name: descriptor.replacement.name },
                )}
              </Button>
              {!replacement && (
                <Button variant="secondary" disabled={busy} onClick={onDismiss}>
                  {t(`${base}.later`)}
                </Button>
              )}
            </div>
          </section>
        ) : null}
        <p className="mt-5 text-12 leading-5 text-[var(--text-tertiary)]">
          {t(`${descriptor.copyKey}.dataNotice`)}
        </p>
        <Button variant="secondary" className="mt-5" onClick={onUninstall}>
          {t(`${base}.remove`)}
        </Button>
      </article>
    </div>
  );
}
