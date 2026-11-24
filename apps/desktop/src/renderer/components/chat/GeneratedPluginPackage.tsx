import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { installInspectedGhostFromFile } from '@/cindy-brain/installFlow';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { Button } from '@/components/ui/button';
import { GhostPluginIcon } from '@/features/plugin/GhostPluginIcon';
import { openPluginInSidebar } from '@/features/right-sidebar/pluginPlacement';
import { openPluginTaskTab } from '@/features/right-sidebar/lib/openPluginTaskTab';
import { insertPromptIntoComposer } from '@/lib/composerActionsBus';
import { toast } from '@/lib/toast';
import {
  findInstalledLocalGhostForFileImport,
  installedGhostStoragePart,
} from '../../../shared/pluginIdentity';

type Inspection = Awaited<ReturnType<typeof window.electronAPI.ghosts.inspect>>;

// Main reads the full archive for inspection. Serialize background card inspections per window.
let pendingInspection = Promise.resolve();

/** Host-verified generated package. An unreadable file or a theme keeps its ordinary file chip. */
export function GeneratedPluginPackage({
  path,
  sessionId,
  children,
}: {
  path: string;
  sessionId: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspectionRevision, setInspectionRevision] = useState(0);
  const inFlight = useRef(false);
  const installed = useInstalledGhosts(inspection !== null);

  useEffect(() => {
    let current = true;
    pendingInspection = pendingInspection.then(async () => {
      if (!current) return;
      try {
        const result = await window.electronAPI.ghosts.inspect(path);
        if (current) setInspection(result);
      } catch {
        if (current) setInspection(null);
      }
    });
    return () => {
      current = false;
    };
  }, [path, inspectionRevision]);

  if (!inspection) return children;
  const { manifest } = inspection;
  const local = findInstalledLocalGhostForFileImport(installed, manifest.id);
  const matched = local?.installedPackageSha256 === inspection.packageSha256 ? local : null;
  const hasView = !!(
    matched?.manifest.panel ||
    matched?.manifest.mainView ||
    matched?.manifest.taskView
  );
  const label = matched
    ? hasView
      ? 'chat.ghostCall.linkConfirmOpen'
      : 'settings.ghosts.detail.useAction'
    : local
      ? 'settings.ghosts.installConsent.confirmUpdate'
      : 'settings.ghosts.market.install';

  async function activate() {
    if (!inspection || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (!matched) {
        const installed = await installInspectedGhostFromFile(path, inspection, { t });
        if (!installed) setInspectionRevision((revision) => revision + 1);
        return;
      }
      const instanceId = installedGhostStoragePart(matched);
      if (matched.manifest.panel?.position === 'tab') {
        navigate('/plugins?panel=' + encodeURIComponent(instanceId));
      } else if (matched.manifest.panel) {
        await openPluginInSidebar(matched, 'panel');
      } else if (matched.manifest.mainView) {
        navigate('/apps/' + encodeURIComponent(instanceId));
      } else if (matched.manifest.taskView) {
        await openPluginTaskTab(sessionId, instanceId);
      } else if (
        !insertPromptIntoComposer({ targetSessionId: sessionId, pluginInstanceId: instanceId })
      ) {
        toast.error(t('scheduler.editor.preRunPlugin.unavailable'));
      }
    } catch {
      toast.error(t('settings.ghosts.errors.generic'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full max-w-80 items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2.5">
      <GhostPluginIcon
        iconId={manifest.id}
        iconName={manifest.name}
        fallbackKind="generic"
        iconDataUrl={inspection.iconDataUrl}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-14 font-medium text-[var(--text-primary)]"
          title={manifest.name}
        >
          {manifest.name}
        </div>
        <div className="truncate text-12 text-[var(--text-secondary)]">
          {t('settings.ghosts.detail.exportFileType')} · {manifest.version}
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        loading={busy}
        disabled={!!matched && (!matched.enabled || matched.approval.state !== 'approved')}
        onClick={() => void activate()}
      >
        {t(label)}
      </Button>
    </div>
  );
}
