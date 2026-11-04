/**
 * One-time setup items for this computer (accounts, keys, permissions…). Each row opens the
 * Settings page where the item is done; nothing here asks for or shows secret values.
 */
import { useTranslation } from 'react-i18next';
import {
  Cast,
  Check,
  Cpu,
  KeyRound,
  Link2,
  LogIn,
  MessageSquare,
  MonitorCog,
  Package,
  Plug,
  Server,
  Store,
  Terminal,
  Wand2,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  SetupMigrationChecklistItem,
  SetupMigrationChecklistKind,
} from '../../../shared/setupMigration';
import { BUILTIN_KEY_NAMES } from './checklistTargets';
import { startSetupMigrationWalkthrough } from './setupMigrationStore';

const ICONS: Record<SetupMigrationChecklistKind, LucideIcon> = {
  'plugin-setup': Plug,
  'plugin-manual': Package,
  'market-source': Store,
  'skill-manual': Wand2,
  'provider-key': KeyRound,
  'provider-connection': Link2,
  'provider-sign-in': LogIn,
  'local-model': Cpu,
  'mcp-token': Server,
  'builtin-key': KeyRound,
  'im-channel': MessageSquare,
  'computer-use': MonitorCog,
  'remote-desktop': Cast,
  ssh: Terminal,
  'ssh-host': Terminal,
};

type Translate = ReturnType<typeof useTranslation>['t'];

/** Kinds whose row explains why the item cannot be done automatically. */
const KINDS_WITH_DETAIL: ReadonlySet<SetupMigrationChecklistKind> = new Set([
  'plugin-manual',
  'market-source',
  'skill-manual',
  'provider-connection',
  'local-model',
  'im-channel',
  'computer-use',
  'remote-desktop',
  'ssh',
  'ssh-host',
]);

/** Reuse the names the IM settings pages already show. */
const IM_CHANNEL_NAME_KEYS: Record<string, string> = {
  telegram: 'settings.telegramBot.title',
  feishu: 'settings.sections.feishuBot',
  wecom: 'settings.wecomBot.title',
  dingtalk: 'settings.dingtalkBot.title',
  discord: 'settings.sections.discordBot',
};

export function checklistItemName(t: Translate, item: SetupMigrationChecklistItem): string {
  if (item.kind === 'builtin-key') {
    return item.ref === 'voice-asr'
      ? t('setupMigration.checklist.voiceAsrName')
      : (BUILTIN_KEY_NAMES[item.ref ?? ''] ?? item.label);
  }
  if (item.kind === 'im-channel') {
    const key = IM_CHANNEL_NAME_KEYS[item.ref ?? ''];
    return key ? t(key) : item.label;
  }
  return item.label;
}

export function checklistItemTitle(t: Translate, item: SetupMigrationChecklistItem): string {
  return t(`setupMigration.checklist.${item.kind}.title`, {
    name: checklistItemName(t, item),
    ...(item.kind === 'ssh' ? { count: Number(item.label) || 0 } : {}),
  });
}

/** Opens the first pending item and walks the rest with the bottom bar. */
export function startChecklistWalkthrough(
  items: readonly SetupMigrationChecklistItem[],
  open: (item: SetupMigrationChecklistItem) => void,
): void {
  const pending = items.filter((item) => !item.done);
  if (pending.length === 0) return;
  startSetupMigrationWalkthrough(pending.map((item) => item.id));
  open(pending[0]);
}

export function SetupMigrationChecklist({
  items,
  variant,
  onOpen,
  onMarkDone,
  onStartAll,
}: {
  items: SetupMigrationChecklistItem[];
  variant: 'dialog' | 'settings';
  onOpen: (item: SetupMigrationChecklistItem) => void;
  onMarkDone?: (item: SetupMigrationChecklistItem) => void;
  /** Shown when two or more items are left: walk them one by one. */
  onStartAll?: () => void;
}) {
  const pendingCount = items.filter((item) => !item.done).length;
  const { t } = useTranslation();
  const titleClass =
    variant === 'dialog' ? 'text-[var(--confirm-title)]' : 'text-[var(--settings-section-sublabel)]';
  const metaClass =
    variant === 'dialog'
      ? 'text-[var(--confirm-desc)]'
      : 'text-[var(--text-tertiary)]';
  return (
    <>
    {onStartAll && pendingCount >= 2 ? (
      <div className={cn('flex justify-end pb-1', variant === 'settings' && 'px-4')}>
        <Button variant="secondary" size="sm" compact onClick={onStartAll}>
          {t('setupMigration.checklist.startAll', { count: pendingCount })}
        </Button>
      </div>
    ) : null}
    <ul className="flex flex-col">
      {items.map((item, index) => {
        const Icon = ICONS[item.kind] ?? Plug;
        const detail = item.details?.length
          ? t('setupMigration.checklist.needs', { items: item.details.join(t('setupMigration.listSeparator')) })
          : KINDS_WITH_DETAIL.has(item.kind)
            ? t(`setupMigration.checklist.${item.kind}.detail`, { name: checklistItemName(t, item) })
            : null;
        return (
          <li
            key={item.id}
            className={cn(
              'flex items-center gap-3 py-2.5',
              index > 0 && 'border-t border-[var(--border-default)]',
              variant === 'settings' && 'px-4',
            )}
          >
            <Icon
              size={16}
              strokeWidth={1.8}
              aria-hidden="true"
              className={cn('shrink-0', item.done ? 'text-[var(--status-success)]' : metaClass)}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 select-text">
              <span className={cn('break-words text-13 font-medium', titleClass, item.done && 'opacity-60')}>
                {checklistItemTitle(t, item)}
              </span>
              {detail ? <span className={cn('break-words text-12 leading-[1.4]', metaClass)}>{detail}</span> : null}
            </span>
            {item.done ? (
              <span className="flex shrink-0 items-center gap-1 text-12 text-[var(--status-success)]">
                <Check size={14} aria-hidden="true" />
                {t('setupMigration.checklist.done')}
              </span>
            ) : (
              <span className="flex shrink-0 items-center gap-2">
                {onMarkDone ? (
                  <Button variant="secondary" size="sm" tone="quiet" compact onClick={() => onMarkDone(item)}>
                    {t('setupMigration.checklist.markDone')}
                  </Button>
                ) : null}
                <Button variant="secondary" size="sm" compact onClick={() => onOpen(item)}>
                  {t(`setupMigration.checklist.${item.kind}.action`)}
                </Button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
    </>
  );
}
