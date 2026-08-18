/**
 * Chip descriptors for the plain-language capability wall (settings → Capabilities).
 *
 * The wall only ever maps capabilities that really exist in `BotCapabilities` /
 * the channel mount state — it never invents an engine switch. The technical
 * originals (harness, model, MCP servers, toolsets, skills, other-task access)
 * stay reachable on the Advanced tab.
 *
 * Kept separate from the JSX so the channel-chip derivation (which accounts are
 * mountable, which kinds have no account at all) is unit-testable without
 * mounting the settings tree.
 */
import type { BotChannel, BotChannelConnection } from './botStore';

/**
 * Channel kinds a teammate can actually be mounted on, in wall order.
 * Derived from the adapter capability profiles in
 * `shared/botChannelRegistry.ts` (local adapters ∪ server relays).
 */
export const MOUNTABLE_BOT_CHANNEL_KINDS = [
  'feishu',
  'telegram',
  'slack',
  'wechat',
  'discord',
  'dingtalk',
  'wecom',
] as const satisfies readonly BotChannel[];

export type MountableBotChannelKind = (typeof MOUNTABLE_BOT_CHANNEL_KINDS)[number];

export interface BotChannelChip {
  /** Stable React key; connection id when an account exists. */
  id: string;
  kind: BotChannel;
  /** Null when no account of this kind is connected yet — the chip is then inert. */
  connection: BotChannelConnection | null;
  /** Display suffix for the chip title (account name / key), null for placeholders. */
  accountLabel: string | null;
  mounted: boolean;
  /** A chip the user cannot flip right now: no account, or a non-routable one. */
  disabled: boolean;
}

function kindOrder(kind: BotChannel): number {
  const index = (MOUNTABLE_BOT_CHANNEL_KINDS as readonly string[]).indexOf(kind);
  return index === -1 ? MOUNTABLE_BOT_CHANNEL_KINDS.length : index;
}

/**
 * One chip per mountable account, plus a greyed placeholder for every channel
 * kind with no connected account (so the wall answers "can it do Feishu?" even
 * before anything is connected).
 */
export function buildBotChannelChips(
  connections: readonly BotChannelConnection[],
  isMounted: (connection: BotChannelConnection) => boolean,
): BotChannelChip[] {
  const chips: BotChannelChip[] = connections.map((connection) => ({
    id: connection.id,
    kind: connection.kind,
    connection,
    accountLabel: connection.accountName || connection.accountKey || null,
    mounted: isMounted(connection),
    disabled: !connection.routable,
  }));
  const covered = new Set(chips.map((chip) => chip.kind));
  for (const kind of MOUNTABLE_BOT_CHANNEL_KINDS) {
    if (covered.has(kind)) continue;
    chips.push({
      id: `unconnected:${kind}`,
      kind,
      connection: null,
      accountLabel: null,
      mounted: false,
      disabled: true,
    });
  }
  return chips.sort(
    (a, b) =>
      kindOrder(a.kind) - kindOrder(b.kind) ||
      Number(b.mounted) - Number(a.mounted) ||
      (a.accountLabel ?? '').localeCompare(b.accountLabel ?? ''),
  );
}

/** Human channel name for chip titles; matches the Channels tab labeling. */
export function botChannelDisplayName(kind: BotChannel): string {
  return kind === 'local' ? 'Local' : kind[0].toUpperCase() + kind.slice(1);
}
