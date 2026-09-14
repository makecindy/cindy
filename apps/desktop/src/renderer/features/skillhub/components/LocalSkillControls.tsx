import { useRef, useState } from 'react';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { extractIpcError } from '@/utils/ipcError';
import { toast } from '@/lib/toast';
import { refresh } from '../hooks/useSkillhub';
import { showUninstallCleanup } from '../lib/uninstallCleanupNotifications';

/** Local management for Skill details, independent of cloud ownership. */
export function LocalSkillControls({ skill, disabled = false, onUninstalled }: {
  skill: SkillhubSkill;
  disabled?: boolean;
  onUninstalled?: () => void;
}) {
  const { t } = useTranslation();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  if (skill.kind !== 'skill') return null;
  const enabled = pendingEnabled ?? skill.cindyEnabled !== false;
  const reportError = (error: unknown, operation: 'toggleFailed' | 'uninstallFailed') => {
    const code = extractIpcError(error)?.code;
    toast.error(t(`skillhub.management.${code === 'PRECONDITION_FAILED' || code === 'PERMISSION_DENIED' ? 'refreshRequired' : operation}`));
  };
  const toggle = async (value: boolean) => {
    if (busyRef.current || disabled || skill.managedByPlugin) return;
    busyRef.current = true;
    setBusy(true);
    setPendingEnabled(value);
    try {
      await window.electronAPI.skillhub.setEnabled({ absolutePath: skill.absolutePath, skillId: skill.id, enabled: value });
      await refresh();
      toast.success(t(value ? 'skillhub.management.enabledToast' : 'skillhub.management.disabledToast', { name: skill.name }));
    } catch (error) { reportError(error, 'toggleFailed'); }
    finally {
      setPendingEnabled(null);
      busyRef.current = false;
      setBusy(false);
    }
  };
  const uninstall = async () => {
    if (busyRef.current || disabled || !skill.canUninstall) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await window.electronAPI.skillhub.uninstall(skill.absolutePath, skill.id);
      if (!result.success) {
        if (result.errorCode === 'CANCELLED') return;
        toast.error(t('skillhub.management.uninstallFailed'));
        return;
      }
      if (result.cleanupToken) {
        showUninstallCleanup(result.cleanupToken, skill.name, refresh);
      } else {
        toast.success(t('skillhub.detail.uninstalledToast', { name: skill.name }));
      }
      onUninstalled?.();
      await refresh();
    } catch (error) { reportError(error, 'uninstallFailed'); }
    finally { busyRef.current = false; setBusy(false); }
  };

  return (
    <div className="flex shrink-0 items-center gap-2" onClick={(event) => event.stopPropagation()}>
      <Tip text={`${skill.absolutePath}\n${t(skill.managedByPlugin ? 'skillhub.management.managedByPlugin' : 'skillhub.management.activationHint')}`}>
        {/* Keep Tooltip's open/closed data-state off the Switch's checked/unchecked root. */}
        <span className="inline-flex">
          <Switch checked={enabled} disabled={busy || disabled || skill.managedByPlugin}
            aria-label={t('skillhub.management.enabledLabel', { name: skill.name })}
            onCheckedChange={(value) => { void toggle(value); }} />
        </span>
      </Tip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" disabled={busy || disabled}
            aria-label={t('skillhub.management.moreLabel', { name: skill.name })}
            className="w-8 p-0">
            <MoreHorizontal size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="rounded-xl border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5 shadow-none">
          <DropdownMenuItem disabled={!skill.canUninstall} onSelect={() => { void uninstall(); }}
            className="gap-2 rounded-lg text-13">
            <Trash2 size={14} />{t('skillhub.detail.uninstall')}
          </DropdownMenuItem>
          {!skill.canUninstall && <p className="max-w-56 px-2 py-1 text-11 text-[var(--text-secondary)]">{t(skill.managedByPlugin ? 'skillhub.management.managedByPlugin' : 'skillhub.management.managedElsewhere')}</p>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
