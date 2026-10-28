import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import {
  PanelsTopLeft,
  Maximize2,
  Settings2,
  ArrowUp,
  ArrowDown,
  MousePointer2,
} from 'lucide-react';
import { useAppShortcutDisplay } from '@/hooks/useAppShortcut';
import { toast } from '@/lib/toast';
import { Tip } from '@/components/ui/tooltip';
import { extractIpcError } from '@/utils/ipcError';
import { useHud, setHudActive, shiftHudLayer, setHudPassThrough } from './store';
import { HudSection } from '@/components/settings/HudSection';
import { useHudPointerRouting } from './useHudPointerRouting';
import './hud.css';

export function HudChrome({ showEntry = true }: { showEntry?: boolean }) {
  const hud = useHud();
  const pointerShortcut = useAppShortcutDisplay('hud-toggle-pass-through');
  useHudPointerRouting(hud);
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [layerBusy, setLayerBusy] = useState(false);
  const [pointerBusy, setPointerBusy] = useState(false);
  const togglePointer = async () => {
    setPointerBusy(true);
    try {
      await setHudPassThrough(!hud.passThrough);
    } catch (error) {
      toast.error(
        t(
          extractIpcError(error)?.message === 'HUD_SHORTCUT_UNAVAILABLE'
            ? 'hud.shortcutUnavailable'
            : 'hud.failed',
        ),
      );
    } finally {
      setPointerBusy(false);
    }
  };
  const changeLayer = async (step: -1 | 1) => {
    setLayerBusy(true);
    try {
      await shiftHudLayer(step);
    } catch {
      toast.error(t('hud.failed'));
    } finally {
      setLayerBusy(false);
    }
  };
  const layerName = t(['hud.layerNormal', 'hud.layerFloating', 'hud.layerHigh'][hud.layer]);
  useEffect(() => {
    if (!hud.active) setSettingsOpen(false);
  }, [hud.active]);
  const location = useLocation();
  const supported = window.electronAPI?.platform === 'darwin';
  const toggle = async (active: boolean) => {
    try {
      await setHudActive(active);
    } catch (error) {
      toast.error(
        t(extractIpcError(error)?.message === 'HUD_FULLSCREEN' ? 'hud.fullscreen' : 'hud.failed'),
      );
    }
  };
  useEffect(() => {
    if (!hud.active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && !event.defaultPrevented) {
        event.preventDefault();
        void setHudActive(false);
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [hud.active]);
  useEffect(() => {
    document.documentElement.classList.toggle('hud-window', hud.active);
    return () => document.documentElement.classList.remove('hud-window');
  }, [hud.active]);
  useEffect(() => {
    if (hud.active && !location.pathname.startsWith('/cc-agent/')) void setHudActive(false);
  }, [hud.active, location.pathname]);
  if (!supported || !location.pathname.startsWith('/cc-agent/')) return null;
  if (!hud.active)
    return showEntry ? (
      <div className="hud-entry" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
        <HudEntry />
      </div>
    ) : null;
  return (
    <>
      <div className="hud-chrome" style={{ WebkitAppRegion: 'drag' } as CSSProperties}>
        <span className="text-12 text-muted-foreground">
          {hud.capturing ? t('hud.capturing') : 'Cindy · HUD'}
        </span>
        <div className="flex gap-1" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
          <Tip
            text={[t(hud.passThrough ? 'hud.passThroughOn' : 'hud.passThroughOff'), pointerShortcut]
              .filter(Boolean)
              .join(' · ')}
          >
            <button
              type="button"
              className="hud-icon hud-recovery"
              aria-label={t('hud.passThrough')}
              aria-pressed={hud.passThrough}
              disabled={pointerBusy}
              onClick={() => void togglePointer()}
            >
              <MousePointer2 size={15} />
            </button>
          </Tip>
          {(
            [
              { step: 1, label: t('hud.layerUp'), Icon: ArrowUp, bound: 2 },
              { step: -1, label: t('hud.layerDown'), Icon: ArrowDown, bound: 0 },
            ] as const
          ).map(({ step, label, Icon, bound }) => (
            <Tip key={step} text={`${label} · ${layerName}`}>
              <button
                type="button"
                className="hud-icon hud-recovery"
                aria-label={label}
                disabled={hud.layer === bound || layerBusy || hud.capturing}
                onClick={() => void changeLayer(step)}
              >
                <Icon size={15} />
              </button>
            </Tip>
          ))}
          <Tip text={t('hud.settingsAction')}>
            <button
              type="button"
              className="hud-icon hud-recovery"
              aria-label={t('hud.settingsAction')}
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((value) => !value)}
            >
              <Settings2 size={15} />
            </button>
          </Tip>
          <Tip text={t('hud.exit')}>
            <button
              type="button"
              className="hud-icon hud-recovery"
              aria-label={t('hud.exit')}
              onClick={() => void toggle(false)}
            >
              <Maximize2 size={15} />
            </button>
          </Tip>
        </div>
      </div>
      {settingsOpen && (
        <div className="hud-settings-overlay" role="region" aria-label={t('hud.settingsAction')}>
          <HudSection />
        </div>
      )}
    </>
  );
}

/** Shared entry can live in the owning sidebar toolbar without overlapping its controls. */
export function HudEntry() {
  const hud = useHud();
  const { t } = useTranslation();
  const location = useLocation();
  if (
    hud.active ||
    window.electronAPI?.platform !== 'darwin' ||
    !location.pathname.startsWith('/cc-agent/')
  )
    return null;
  return (
    <Tip text={t('hud.enter')} side="bottom">
      <button
        type="button"
        className="hud-icon"
        aria-label={t('hud.enter')}
        onClick={() => void setHudActive(true).catch(() => toast.error(t('hud.failed')))}
      >
        <PanelsTopLeft size={15} />
      </button>
    </Tip>
  );
}
