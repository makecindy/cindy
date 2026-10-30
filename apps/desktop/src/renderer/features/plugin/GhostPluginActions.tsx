import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus, Sparkles, Store, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Add-plugin menu shared by local and remote catalogs. */
export function GhostPluginActions({
  onInstall,
  onCreateWithCindy,
  onAddMarketplace,
  disabled = false,
  installTarget,
}: {
  onInstall: () => void;
  onCreateWithCindy?: () => void;
  onAddMarketplace?: () => void;
  disabled?: boolean;
  installTarget?: string;
}) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="primary"
          size="lg"
          type="button"
          disabled={disabled}
          aria-label={t('settings.ghosts.page.addPluginAria')}
          className="plugin-management-action-trigger group shrink-0 shadow-[var(--plugin-card-shadow)] data-[state=open]:[--button-face-bg:var(--surface-chip)]"
        >
          <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="plugin-management-action-label">
            {t('settings.ghosts.page.addPlugin')}
          </span>
          <ChevronDown
            size={13}
            strokeWidth={1.75}
            className="plugin-management-action-chevron transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </Button>
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
