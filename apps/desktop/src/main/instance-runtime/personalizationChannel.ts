import {
  CLOUD_PERSONALIZATION_CHANNEL,
  cloudPersonalizationRequestSchema,
  type CloudPersonalizationState,
} from '../../shared/cloudPersonalization.js';
import type { HostSettingState, PersonalizationSettings, SettingsOwnerStamp } from '../../shared/hostSettings.js';
import type { OverrideSettingsCommitOptions, OverrideSettingsMutation } from '../maker-host/override-settings-file.js';

export interface PersonalizationChannelDeps {
  /** The managed instance exists and its signed-in member is the instance owner. */
  isInstanceOwner(): boolean;
  owner(): SettingsOwnerStamp | null;
  inspect(): Promise<HostSettingState<PersonalizationSettings>>;
  commit(mutation: OverrideSettingsMutation<PersonalizationSettings>, options: OverrideSettingsCommitOptions): Promise<unknown>;
}

const fail = (code: string, message: string): never => {
  throw new Error(`[${code}] ${message}`);
};

/**
 * The owner's cloud settings page reads and edits the instance prompt like the local page:
 * full text, revision-checked saves and reset to the default. Never logs the text.
 */
export function createPersonalizationChannel(deps: PersonalizationChannelDeps) {
  const ownerAtIngress = (): SettingsOwnerStamp => {
    if (!deps.isInstanceOwner()) fail('PERMISSION_DENIED', 'not the instance owner');
    return deps.owner() ?? fail('OWNER_CHANGED', 'the instance account is changing');
  };
  const state = async (owner: SettingsOwnerStamp): Promise<CloudPersonalizationState> => {
    const current = await deps.inspect();
    return current.status === 'ready'
      ? {
          status: 'ready',
          ownerGeneration: owner.ownerGeneration,
          revision: current.revision,
          userPrompt: current.value.userPrompt,
          customized: current.isCustomized,
        }
      : { status: current.status === 'unreadable' ? 'unreadable' : 'unavailable', ownerGeneration: owner.ownerGeneration };
  };
  return {
    channel: CLOUD_PERSONALIZATION_CHANNEL,
    async handle(_controller: string, raw: unknown): Promise<CloudPersonalizationState> {
      const owner = ownerAtIngress();
      const parsed = cloudPersonalizationRequestSchema.safeParse(raw);
      if (!parsed.success) fail('INVALID_PARAMS', 'invalid personalization request');
      const request = parsed.data!;
      if (request.op === 'read') return state(owner);
      if (request.ownerGeneration !== owner.ownerGeneration) fail('OWNER_CHANGED', 'the instance account changed');
      const assertCurrent = () => {
        const now = deps.isInstanceOwner() ? deps.owner() : null;
        if (!now || now.dataOwnerId !== owner.dataOwnerId || now.ownerGeneration !== owner.ownerGeneration)
          fail('OWNER_CHANGED', 'the instance account changed');
      };
      try {
        await deps.commit(
          request.op === 'save' ? { set: { userPrompt: request.userPrompt } } : { clear: ['userPrompt'] },
          { expectedRevision: request.revision, assertCurrent },
        );
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        if (code === 'CONFLICT') fail('REVISION_CONFLICT', 'the instructions changed; reload before saving');
        if (error instanceof Error && /^\[[A-Z_]+\]/.test(error.message)) throw error;
        fail('PRECONDITION_FAILED', 'the instructions were not saved');
      }
      assertCurrent();
      return state(owner);
    },
  };
}
