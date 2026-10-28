import { useEffect, useState } from 'react';
import { AppShortcutBindings } from './AppShortcutBindings';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight, Package } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useWorkLouderCodex } from '@/hooks/useWorkLouderCodex';
import { useXboxGamepad } from '@/hooks/useXboxGamepad';
import { WorkLouderCodexEntry, WorkLouderCodexSettings } from './WorkLouderCodexSettings';
import {
  isWorkLouderModel,
  VISIBLE_WORKLOUDER_MODELS,
  type WorkLouderModel,
} from '../../../shared/workLouderCodex';
import {
  GAMEPAD_FAMILIES,
  VISIBLE_GAMEPAD_FAMILIES,
  type GamepadFamily,
} from '../../../shared/xboxGamepad';
import { XboxGamepadEntry, XboxGamepadSettings } from './XboxGamepadSettings';

function shouldShowHardwareOutside(device: {
  present: boolean | null | undefined;
  enabled: boolean | undefined;
}): boolean {
  return device.present === true || device.enabled === true;
}

type HardwarePane = 'list' | 'accessories' | WorkLouderModel | GamepadFamily;

function AccessoriesEntry({ onOpen }: { onOpen(): void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="settings-shortcuts-accessories"
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border p-4 text-left outline-none transition-colors',
        'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
        'hover:bg-[var(--settings-menu-bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
      )}
      aria-label={t('settings.shortcuts.accessories.openAria')}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-chip)] text-[var(--text-secondary)]">
        <Package size={18} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          id="settings-search-settings-shortcuts-accessories-title"
          className="truncate text-13 font-medium text-[var(--text-primary)]"
        >
          {t('settings.shortcuts.accessories.title')}
        </span>
        <span className="text-12 leading-[1.4] text-[var(--text-secondary)]">
          {t('settings.shortcuts.accessories.description')}
        </span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
    </button>
  );
}

export function KeyboardShortcutsSection() {
  const { t } = useTranslation();
  const [hardwarePane, setHardwarePane] = useState<HardwarePane>('list');
  const [hardwareReturnTo, setHardwareReturnTo] = useState<'list' | 'accessories'>('list');
  const workLouderCodex = useWorkLouderCodex({ model: 'codex-micro', watchConnection: true });
  const workLouderCreator = useWorkLouderCodex({
    model: 'creator-micro-2',
    watchConnection: true,
  });
  const workLouderBoards = {
    'codex-micro': workLouderCodex,
    'creator-micro-2': workLouderCreator,
  };
  const xboxGamepad = useXboxGamepad({ family: 'xbox', watchConnection: true });
  const playstationGamepad = useXboxGamepad({ family: 'playstation', watchConnection: true });
  const nintendoGamepad = useXboxGamepad({ family: 'nintendo', watchConnection: true });
  const genericGamepad = useXboxGamepad({ family: 'generic', watchConnection: true });
  const gamepads = {
    xbox: xboxGamepad,
    playstation: playstationGamepad,
    nintendo: nintendoGamepad,
    generic: genericGamepad,
  };
  const workLouderConnected = Object.fromEntries(
    VISIBLE_WORKLOUDER_MODELS.map((model) => [
      model,
      shouldShowHardwareOutside({
        present: workLouderBoards[model].state?.devicePresent,
        enabled: workLouderBoards[model].state?.settings.deviceEnabled,
      }),
    ]),
  ) as Record<WorkLouderModel, boolean>;
  const gamepadConnected = Object.fromEntries(
    GAMEPAD_FAMILIES.map((family) => [
      family,
      shouldShowHardwareOutside({
        present: gamepads[family].state?.devicePresent,
        enabled: gamepads[family].state?.settings.deviceEnabled,
      }),
    ]),
  ) as Record<GamepadFamily, boolean>;
  const workLouderOpenRequested =
    new URLSearchParams(window.location.search).get('workLouderCodex') === '1';

  useEffect(() => {
    if (workLouderOpenRequested) {
      setHardwareReturnTo('list');
      setHardwarePane('codex-micro');
    }
  }, [workLouderOpenRequested]);

  const openWorkLouder = (model: WorkLouderModel, from: 'list' | 'accessories') => {
    setHardwareReturnTo(from);
    setHardwarePane(model);
  };
  const openGamepad = (family: GamepadFamily, from: 'list' | 'accessories') => {
    setHardwareReturnTo(from);
    setHardwarePane(family);
  };

  if (isWorkLouderModel(hardwarePane)) {
    return (
      <WorkLouderCodexSettings
        model={hardwarePane}
        onBack={() => setHardwarePane(hardwareReturnTo)}
      />
    );
  }
  if ((GAMEPAD_FAMILIES as readonly string[]).includes(hardwarePane)) {
    return (
      <XboxGamepadSettings
        family={hardwarePane as GamepadFamily}
        onBack={() => setHardwarePane(hardwareReturnTo)}
      />
    );
  }
  if (hardwarePane === 'accessories') {
    return (
      <div className="flex flex-col gap-[14px]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setHardwarePane('list')}
            className="flex size-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
            aria-label={t('settings.shortcuts.accessories.back')}
          >
            <ArrowLeft size={17} />
          </button>
          <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
            {t('settings.shortcuts.accessories.title')}
          </h2>
        </div>
        <div
          className={cn(
            'flex flex-col overflow-hidden rounded-xl',
            'bg-[var(--settings-theme-card-bg)]',
            'border border-[var(--settings-theme-card-border)]',
            '[&>*+*]:border-t [&>*+*]:border-[var(--settings-theme-card-border)]',
          )}
        >
          {VISIBLE_WORKLOUDER_MODELS.map((model) => (
            <WorkLouderCodexEntry
              key={model}
              model={model}
              state={workLouderBoards[model].state}
              loading={workLouderBoards[model].loading}
              grouped
              onOpen={() => openWorkLouder(model, 'accessories')}
            />
          ))}
          {VISIBLE_GAMEPAD_FAMILIES.map((family) => (
            <XboxGamepadEntry
              key={family}
              family={family}
              state={gamepads[family].state}
              loading={gamepads[family].loading}
              grouped
              onOpen={() => openGamepad(family, 'accessories')}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <AppShortcutBindings>
      {VISIBLE_WORKLOUDER_MODELS.filter((model) => workLouderConnected[model]).map((model) => (
        <WorkLouderCodexEntry
          key={model}
          model={model}
          state={workLouderBoards[model].state}
          loading={workLouderBoards[model].loading}
          onOpen={() => openWorkLouder(model, 'list')}
        />
      ))}
      {VISIBLE_GAMEPAD_FAMILIES.filter((family) => gamepadConnected[family]).map((family) => (
        <XboxGamepadEntry
          key={family}
          family={family}
          state={gamepads[family].state}
          loading={gamepads[family].loading}
          onOpen={() => openGamepad(family, 'list')}
        />
      ))}
      <AccessoriesEntry onOpen={() => setHardwarePane('accessories')} />
    </AppShortcutBindings>
  );
}
