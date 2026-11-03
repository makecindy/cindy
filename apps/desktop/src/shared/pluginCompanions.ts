import type { TeammateStatus } from '@cindy/maker-shared/teammate-status';

/**
 * What `cindy.companions` hands a plugin (agent.companions):
 * every companion of the account, including those running on the owner's other computers, read from each
 * companion's home computer so all computers show the same thing. Never tool inputs, commands, file names,
 * plan bodies or values the owner types for a host step.
 */

/** A request a companion is waiting on. `title` follows the bot-autonomy summary: the question, or the tool to approve; other kinds carry none. */
export interface PluginCompanionInteraction {
  /** Opaque; pass back to `open` to show this request in Cindy. */
  ref: string;
  kind: string;
  title: string | null;
}

export interface PluginCompanion {
  id: string;
  name: string;
  description: string;
  /**
   * Where the companion runs. isSelf=false: another computer of the account (`deviceName`); `online` is
   * false while that computer cannot be reached (offline, remote control off), and nothing live is known.
   */
  home: { isSelf: boolean; online: boolean; deviceName: string | null };
  /** The roster status (same precedence as the sidebar and phones); `offline` while its home cannot be reached. */
  status: TeammateStatus | 'offline';
  activity: {
    phase: string;
    /** Public generation category such as thinking, reading-file, testing; never arguments. */
    workingPhase: string | null;
    /** Host-written coarse summary; never commands, URLs or reasoning. */
    summary: string | null;
    startedAt: number | null;
    lastActivityAt: number | null;
  };
  interactions: PluginCompanionInteraction[];
  /** When the latest completed reply was persisted; a change means `reply` has something new. */
  lastReplyAt: number | null;
}

export interface PluginCompanionAvatar {
  /** data:image/jpeg URL of the artwork, or null when the companion uses a glyph. */
  src: string | null;
  /** A single glyph (the emoji avatar, or the first letter of the name) to draw without artwork. */
  fallback: string;
}

export interface PluginCompanionReply {
  text: string;
  createdAt: number;
  truncated: boolean;
}
