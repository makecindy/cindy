import { useEffect, useRef, type ReactNode, type Ref } from 'react';
import { Clock3, Hand, MessageCircleMore, Sparkles, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import {
  botChannelDisplayName,
  buildBotChannelChips,
  type BotChannelChip,
} from './botChannelChips';
import type { BotCapabilities, BotChannelConnection } from './botStore';

/** The non-channel chips, addressable by the ⚠ badge deep link. */
export type BotCapabilityChipId = 'automation' | 'permissions';

function ChipCard({
  icon: Icon,
  name,
  effect,
  checked,
  disabled,
  highlighted,
  busy,
  onToggle,
  controlRef,
}: {
  icon: LucideIcon;
  name: string;
  effect: string;
  checked: boolean;
  disabled?: boolean;
  highlighted?: boolean;
  busy?: boolean;
  onToggle: (next: boolean) => void;
  controlRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border px-3 py-3',
        highlighted
          ? 'border-[var(--focus-ring)] bg-[var(--surface-chip)]'
          : 'border-[var(--border-default)]',
        disabled && 'opacity-60',
      )}
    >
      <Icon size={16} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-12 font-medium text-[var(--text-primary)]">{name}</span>
        <span className="mt-0.5 block text-11 leading-4 text-[var(--text-tertiary)]">{effect}</span>
      </span>
      <Switch
        ref={controlRef}
        checked={checked}
        disabled={disabled || busy}
        aria-label={name}
        onCheckedChange={onToggle}
        className="mt-0.5 shrink-0"
      />
    </div>
  );
}

/**
 * The capability wall: plain-language chips for what a teammate can do.
 *
 * Every chip maps to a field that already exists — channel mounts, the
 * `automation` capability and the `permissions` mode. Nothing here creates a
 * new engine concept, and nothing that has no real switch gets a chip.
 */
export function BotCapabilityChips({
  capabilities,
  onCapabilitiesChange,
  connections,
  isChannelMounted,
  channelBusyId,
  onToggleChannel,
  focusChipId,
  headerAside,
  children,
}: {
  capabilities: BotCapabilities;
  onCapabilitiesChange: (value: BotCapabilities) => void;
  connections: readonly BotChannelConnection[];
  isChannelMounted: (connection: BotChannelConnection) => boolean;
  channelBusyId: string | null;
  onToggleChannel: (connection: BotChannelConnection) => void;
  /** Set by the ⚠ badge deep link so the matching chip takes focus. */
  focusChipId?: BotCapabilityChipId | null;
  headerAside?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const permissionsRef = useRef<HTMLButtonElement | null>(null);
  const automationRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (focusChipId === 'permissions') permissionsRef.current?.focus();
    if (focusChipId === 'automation') automationRef.current?.focus();
  }, [focusChipId]);

  const channelChips: BotChannelChip[] = buildBotChannelChips(connections, isChannelMounted);

  return (
    <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
          <Sparkles size={16} />
          {t('bots.capabilityChips.title')}
        </div>
        {headerAside}
      </div>
      <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
        {t('bots.capabilityChips.description')}
      </p>

      <div className="mt-4 grid gap-2 md:grid-cols-2">
        <ChipCard
          icon={Hand}
          name={t('bots.capabilityChips.act.name')}
          effect={t('bots.capabilityChips.act.effect')}
          checked={capabilities.permissions === 'trusted'}
          highlighted={focusChipId === 'permissions'}
          controlRef={permissionsRef}
          onToggle={(next) =>
            onCapabilitiesChange({ ...capabilities, permissions: next ? 'trusted' : 'ask' })
          }
        />
        <ChipCard
          icon={Clock3}
          name={t('bots.capabilityChips.automation.name')}
          effect={t('bots.capabilityChips.automation.effect')}
          checked={capabilities.automation}
          highlighted={focusChipId === 'automation'}
          controlRef={automationRef}
          onToggle={(next) => onCapabilitiesChange({ ...capabilities, automation: next })}
        />
        {channelChips.map((chip) => {
          const channelName = botChannelDisplayName(chip.kind);
          const name = chip.accountLabel ? `${channelName} · ${chip.accountLabel}` : channelName;
          return (
            <ChipCard
              key={chip.id}
              icon={MessageCircleMore}
              name={name}
              effect={
                chip.connection
                  ? t('bots.capabilityChips.channel.effect', { channel: channelName })
                  : t('bots.capabilityChips.channel.connectHint', { channel: channelName })
              }
              checked={chip.mounted}
              disabled={chip.disabled}
              busy={chip.connection ? channelBusyId === chip.connection.id : false}
              onToggle={() => {
                if (chip.connection) onToggleChannel(chip.connection);
              }}
            />
          );
        })}
      </div>

      {children}
    </section>
  );
}
