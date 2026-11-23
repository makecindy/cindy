/**
 * Organization plugin publish confirmation contract between Main and Renderer.
 * Main decides what the screen may edit; Renderer only returns the user's choice.
 */
import type { AuthorMemberReference, AuthorVisibilityAudience } from './pluginAuthor';

/** Names the user mentioned in the conversation that could not be matched to one person/department. */
export interface PublisherAudienceUnresolved {
  kind: 'department' | 'member' | 'email';
  text: string;
  reason: 'not_found' | 'ambiguous';
}

export type PublisherAudienceContext =
  /** Server predates author APIs: show nothing, send nothing (same as before #1541). */
  | { kind: 'unsupported' }
  /**
   * Current audience cannot be read (not an author of an existing plugin, read failed), or it
   * carries legacy role conditions the server will not accept back on publish: keep it.
   */
  | { kind: 'locked'; reason?: 'legacyRoles' }
  /**
   * The user asked for a specific audience in the conversation, but this server or this plugin
   * cannot take one: publishing is blocked instead of going out with all members or the current
   * audience.
   */
  | { kind: 'blocked'; reason: 'unsupported' | 'locked' | 'legacyRoles' }
  | {
      kind: 'editable';
      /** New plugins default to all members; existing ones carry their current audience. */
      isNew: boolean;
      current: AuthorVisibilityAudience;
      /** Initial selection: the current audience, or what the user asked for in the conversation. */
      initial: AuthorVisibilityAudience | { type: 'matchAny' };
      /** Display names for member IDs in current/initial. */
      members: AuthorMemberReference[];
      unresolved: PublisherAudienceUnresolved[];
    };

export interface PluginPublisherConfirmFacts {
  orgSlug: string;
  orgName: string | null;
  ghostId: string;
  name: string;
  version: string;
  sizeBytes: number;
}

export interface PluginPublisherConfirmPayload {
  requestId: string;
  ownerStamp: { dataOwnerId: string; ownerGeneration: number };
  facts: PluginPublisherConfirmFacts;
  audience: PublisherAudienceContext;
}

export interface PluginPublisherConfirmDecision {
  confirmed: boolean;
  /** Only read when the context was editable. */
  visibilityAudience?: AuthorVisibilityAudience;
}

/** Conversation request: names as the user said them; Main matches them to the directory. */
export interface PublisherAudienceHint {
  departments?: string[];
  members?: string[];
  emails?: string[];
}

export const PUBLISHER_AUDIENCE_HINT_MAX_ITEMS = 20;
