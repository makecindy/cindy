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

/**
 * Why the server will reject any upload of this plugin (publish-context answers with the same error
 * as the upload, #1593): member publishing off or no publishing permission (403), an archived
 * plugin, a Platform common-plugin copy, or a repository-managed plugin.
 */
export type PublisherDeniedReason = 'forbidden' | 'archived' | 'commonManaged' | 'repositoryManaged';

export type PublisherAudienceContext =
  /**
   * Keep the current audience, unchanged and not sent: the publisher may not edit it (not an
   * author or plugin manager), it could not be read, or it carries legacy role conditions the
   * upload will not accept back.
   */
  | { kind: 'locked'; reason?: 'legacyRoles' }
  /**
   * The user asked for a specific audience in the conversation, but the audience can only be kept:
   * publishing is blocked instead of going out with the current audience.
   */
  | { kind: 'blocked'; reason: 'locked' | 'legacyRoles' }
  /** The upload would fail for anyone; the screen explains why and cannot confirm. */
  | { kind: 'denied'; reason: PublisherDeniedReason }
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
