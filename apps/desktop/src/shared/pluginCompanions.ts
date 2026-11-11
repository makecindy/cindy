import type { TeammateStatus } from '@cindy/maker-shared/teammate-status';

/**
 * What `cindy.companions` hands a plugin (agent.companions):
 * every companion of the account, including those running on the owner's other computers, read from each
 * companion's home computer so all computers show the same thing. The list never carries tool inputs,
 * commands, file names, plan bodies or values the owner types for a host step; `interaction` hands over one
 * request the way the conversation shows it, so the plugin can let the owner answer it in its own page.
 */

/**
 * What a request asks of the owner. question / permission / plan can be answered with `answer` (allowing
 * still goes through Cindy's own confirmation); `other` is one of Cindy's own confirmations, done in Cindy.
 */
export type PluginCompanionInteractionKind = 'question' | 'permission' | 'plan' | 'other';

/** A request a companion is waiting on. `title` follows the pending-interaction summary (taskPhase.ts): the question, or the tool to approve; other kinds carry none. */
export interface PluginCompanionInteraction {
  /** Opaque; pass back to `interaction`, `answer` or `open`. */
  ref: string;
  kind: PluginCompanionInteractionKind;
  title: string | null;
}

/** One request as the conversation card shows it (tool inputs already redacted like on a phone). */
export type PluginCompanionInteractionDetail =
  | {
      ref: string;
      kind: 'question';
      questions: Array<{
        question: string;
        header: string | null;
        options: Array<{ label: string; description: string | null }>;
        multiSelect: boolean;
      }>;
    }
  | {
      ref: string;
      kind: 'permission';
      /** What allowing lets the companion do. */
      action: 'command' | 'file-read' | 'file-write' | 'browser' | 'plugin' | 'tool';
      /** The tool's readable name. */
      tool: string;
      /** The plugin or server for action=plugin. */
      subject: string | null;
      /** The command, paths or arguments being confirmed. */
      preview: string;
      /**
       * Whether the plugin may allow it: Cindy's own dialog can show all of it (the whole command or short
       * arguments). False for file writes and anything longer — allow those in Cindy (`open`); `answer` with
       * allow returns ALLOW_IN_CINDY. Declining works either way.
       */
      allowHere: boolean;
    }
  | {
      ref: string;
      kind: 'plan';
      plan: string;
      truncated: boolean;
      /** Whether the plugin may allow it: the whole plan fits Cindy's own dialog; otherwise allow it in Cindy. */
      allowHere: boolean;
    }
  | { ref: string; kind: 'other'; title: string | null };

/**
 * The owner's answer, given in the plugin's page. Answers to questions go by question order: picked option
 * labels and/or the owner's own words. Allowing a permission or a plan opens Cindy's own confirmation.
 */
export type PluginCompanionAnswer =
  | { kind: 'question'; answers: Array<{ choices: string[]; text?: string }> }
  | { kind: 'permission'; decision: 'allow' | 'deny' }
  | { kind: 'plan'; decision: 'allow' | 'deny'; feedback?: string };

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

/** One message of the companion's main conversation as the chat shows it: the owner's words or the companion's reply. */
export interface PluginCompanionMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  truncated: boolean;
}

/** The latest messages, oldest first; `more`: older ones exist (see them in Cindy). */
export interface PluginCompanionHistory {
  messages: PluginCompanionMessage[];
  more: boolean;
}
