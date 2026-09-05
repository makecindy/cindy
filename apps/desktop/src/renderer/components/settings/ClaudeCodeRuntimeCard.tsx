import { useEffect, useState } from 'react';
import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import type {
  ClaudeCodeRuntimeProbeResult,
  ClaudeCodeRuntimeSettingsState,
  ClaudeCodeRuntimeSource,
} from '../../../shared/claudeCodeRuntimeSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';

export function ClaudeCodeRuntimeCard() {
  const { t } = useTranslation();
  const [state, setState] = useState<ClaudeCodeRuntimeSettingsState | null>(null);
  const [pathDraft, setPathDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<ClaudeCodeRuntimeProbeResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker.agent
      .getClaudeCodeRuntimeSettings()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setPathDraft(next.value.customPath);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state) return null;

  const save = async (source: ClaudeCodeRuntimeSource, customPath: string) => {
    setBusy(true);
    try {
      const next = await window.electronAPI.maker.agent.setClaudeCodeRuntimeSettings({
        source,
        customPath,
      });
      setState(next);
      setPathDraft(next.value.customPath);
      setProbe(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('settings.about.claudeRuntime.saveFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleProbe = async () => {
    setBusy(true);
    try {
      setProbe(await window.electronAPI.maker.agent.probeSystemClaudeCode(pathDraft));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('settings.about.claudeRuntime.probeFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    setBusy(true);
    try {
      const next = await window.electronAPI.maker.agent.resetClaudeCodeRuntimeSettings();
      setState(next);
      setPathDraft(next.value.customPath);
      setProbe(null);
    } catch {
      toast.error(t('settings.defaults.restoreFailed'));
    } finally {
      setBusy(false);
    }
  };

  const activeSource = state.decision?.activeSource;
  const activeLabel = activeSource
    ? t(`settings.about.claudeRuntime.source.${activeSource}`)
    : t('settings.about.version.loading');

  return (
    <div className="flex flex-col gap-[14px] rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-14 font-medium text-[var(--settings-section-title)]">
            {t('settings.about.claudeRuntime.title')}
          </p>
          <p className="mt-1 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
            {t('settings.about.claudeRuntime.description')}
          </p>
        </div>
        <DefaultOverrideControls
          isCustomized={state.isCustomized}
          disabled={busy}
          onReset={() => void handleReset()}
        />
      </div>

      <Select.Root
        value={state.value.source}
        disabled={busy}
        onValueChange={(value) =>
          void save(value as ClaudeCodeRuntimeSource, state.value.customPath)
        }
      >
        <Select.Trigger
          aria-label={t('settings.about.claudeRuntime.selectAria')}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-full border px-3 text-12 outline-none',
            'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
            'focus:ring-2 focus:ring-[var(--focus-ring-soft)] data-[disabled]:opacity-60',
          )}
        >
          <Select.Value />
          <Select.Icon asChild>
            <ChevronDown size={15} />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            side="bottom"
            align="start"
            sideOffset={4}
            className="z-[10010] w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1"
          >
            <Select.Viewport>
              <RuntimeOption
                value="managed"
                label={t('settings.about.claudeRuntime.source.managed')}
              />
              <RuntimeOption
                value="system"
                label={t('settings.about.claudeRuntime.source.system')}
              />
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>

      {state.value.source === 'system' ? (
        <div className="flex flex-col gap-2">
          <label
            className="text-12 font-medium text-[var(--settings-section-sublabel)]"
            htmlFor="claude-code-system-path"
          >
            {t('settings.about.claudeRuntime.pathLabel')}
          </label>
          <input
            id="claude-code-system-path"
            value={pathDraft}
            disabled={busy}
            onChange={(event) => setPathDraft(event.target.value)}
            placeholder={t('settings.about.claudeRuntime.pathPlaceholder')}
            className="h-9 w-full rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 text-12 text-[var(--settings-input-text)] outline-none placeholder:text-[var(--settings-section-desc)] focus:ring-2 focus:ring-[var(--focus-ring-soft)] disabled:opacity-60"
          />
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleProbe()}
              className="rounded-full border border-[var(--settings-theme-card-border)] px-4 py-2 text-12 font-medium text-[var(--settings-section-title)] transition-colors hover:bg-[var(--surface-hover)] active:scale-[0.98] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
            >
              {t('settings.about.claudeRuntime.checkInstallation')}
            </button>
            <button
              type="button"
              disabled={busy || pathDraft.trim() === state.value.customPath}
              onClick={() => void save('system', pathDraft)}
              className="rounded-full bg-[var(--accent-cta-bg)] px-4 py-2 text-12 font-medium text-[var(--accent-pure-cta-fg)] transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              {t('settings.about.claudeRuntime.savePath')}
            </button>
          </div>
        </div>
      ) : null}

      <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
        {t('settings.about.claudeRuntime.activeSource', { source: activeLabel })}
      </p>
      {state.restartRequired ? (
        <p className="text-12 leading-[1.5] text-[var(--warning-fg)]">
          {t('settings.about.claudeRuntime.restartRequired')}
        </p>
      ) : null}
      {state.decision?.fallbackReason ? (
        <p className="text-12 leading-[1.5] text-[var(--warning-fg)]">
          {t(`settings.about.claudeRuntime.fallback.${state.decision.fallbackReason}`, {
            minimumVersion: state.decision.minimumVersion,
          })}
        </p>
      ) : null}
      {probe ? (
        <p
          className={cn(
            'text-12 leading-[1.5]',
            probe.ok ? 'text-[var(--success)]' : 'text-[var(--warning-fg)]',
          )}
        >
          {probe.ok
            ? t('settings.about.claudeRuntime.probeReady', {
                version: probe.version,
                path: probe.binaryPath,
              })
            : t(`settings.about.claudeRuntime.probe.${probe.reason ?? 'version_unavailable'}`, {
                minimumVersion: probe.minimumVersion,
              })}
        </p>
      ) : null}
    </div>
  );
}

function RuntimeOption({ value, label }: { value: ClaudeCodeRuntimeSource; label: string }) {
  return (
    <Select.Item
      value={value}
      className="flex w-full cursor-pointer select-none items-center justify-between rounded-lg px-3 py-2 text-12 text-[var(--settings-input-text)] outline-none data-[highlighted]:bg-[var(--surface-hover)]"
    >
      <Select.ItemText>{label}</Select.ItemText>
      <Select.ItemIndicator>
        <Check size={14} />
      </Select.ItemIndicator>
    </Select.Item>
  );
}
