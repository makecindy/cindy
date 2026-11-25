import { useTranslation } from 'react-i18next';
import { ChevronDown, Github, Plus, Sparkles, Store, Upload } from 'lucide-react';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useCompactPluginControl } from './lib/useCompactPluginControl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function PluginCatalogPublishButton({
  onClick,
  unreadTone,
}: {
  onClick: () => void;
  unreadTone?: 'error' | 'done';
}) {
  const { t } = useTranslation();
  const label = t('settings.ghosts.contribution.myPlugins');
  const [trigger, iconOnly] = useCompactPluginControl(420, '.plugin-management-layout-root');
  return (
    <Tip
      ref={trigger}
      text={label}
      controlledOpen={iconOnly ? undefined : false}
      resetHoverOnControlChange
    >
      <Button
        variant="secondary"
        tone="quiet"
        size="md"
        compact
        className={cn('plugin-publish-trigger whitespace-nowrap', iconOnly && 'w-8 px-0')}
        aria-label={unreadTone ? `${label} · ${t('settings.ghosts.contribution.unreadReview')}` : label}
        onClick={onClick}
      >
        <Upload size={15} strokeWidth={1.75} className="plugin-publish-icon" aria-hidden="true" />
        {!iconOnly && <span>{label}</span>}
        {unreadTone ? (
          <span className="inline-flex" aria-hidden="true">
            <AttentionDot tone={unreadTone} />
          </span>
        ) : null}
      </Button>
    </Tip>
  );
}

/** Add-plugin menu shared by local and remote catalogs. */
export function GhostPluginActions({
  onInstall,
  onInstallGithubRelease,
  onCreateWithCindy,
  onAddMarketplace,
  disabled = false,
  installTarget,
}: {
  onInstall: () => void;
  onInstallGithubRelease?: () => void;
  onCreateWithCindy?: () => void;
  onAddMarketplace?: () => void;
  disabled?: boolean;
  installTarget?: string;
}) {
  const { t } = useTranslation();
  const label = t('settings.ghosts.page.addPlugin');
  const [trigger, iconOnly] = useCompactPluginControl(720, '.plugin-management-layout-root');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Tip
          ref={trigger}
          text={label}
          controlledOpen={iconOnly ? undefined : false}
          resetHoverOnControlChange
        >
          <Button
            variant="primary"
            size="md"
            compact
            type="button"
            disabled={disabled}
            aria-label={t('settings.ghosts.page.addPluginAria')}
            className={cn('group whitespace-nowrap', iconOnly && 'w-8 px-0')}
          >
            <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
            {!iconOnly && (
              <span className="inline-flex items-center gap-1">
                {label}
                <ChevronDown
                  size={13}
                  strokeWidth={1.75}
                  className="shrink-0 text-[var(--text-tertiary)] transition-transform duration-[var(--motion-fast)] group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                  aria-hidden="true"
                />
              </span>
            )}
          </Button>
        </Tip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-max min-w-52 max-w-[calc(100vw-2rem)] p-1.5"
      >
        {installTarget ? (
          <DropdownMenuLabel>
            {t('settings.ghosts.remote.installDestination', { device: installTarget })}
          </DropdownMenuLabel>
        ) : null}
        {onCreateWithCindy ? (
          <>
            <DropdownMenuItem onSelect={onCreateWithCindy} className="gap-3 whitespace-nowrap">
              <Sparkles
                size={16}
                strokeWidth={1.7}
                className="text-[var(--text-secondary)]"
                aria-hidden="true"
              />
              {t('settings.ghosts.page.createWithCindy')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={onInstall} className="gap-3 whitespace-nowrap">
          <Upload
            size={16}
            strokeWidth={1.7}
            className="text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          {t('settings.ghosts.install')}
        </DropdownMenuItem>
        {onInstallGithubRelease && (
          <DropdownMenuItem onSelect={onInstallGithubRelease} className="gap-3 whitespace-nowrap">
            <Github size={16} strokeWidth={1.7} className="text-[var(--text-secondary)]" aria-hidden="true" />
            {t('settings.ghosts.page.githubInstall.label')}
          </DropdownMenuItem>
        )}
        {onAddMarketplace ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onAddMarketplace} className="gap-3 whitespace-nowrap">
              <Store
                size={16}
                strokeWidth={1.7}
                className="text-[var(--text-secondary)]"
                aria-hidden="true"
              />
              {t('settings.ghosts.market.sources.addMarketplace')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
