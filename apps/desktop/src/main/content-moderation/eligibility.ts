import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

export interface ModerationEligibilityInput {
  isPackaged: boolean;
  region: CindyRegion;
  commandLineEnabled: boolean;
  membershipKind: 'personal' | 'org' | null;
  membershipId: string | null;
  accessToken: string | null;
  identityEpoch: number;
  productionSignBaseUrl: string;
  testSignBaseUrl: string;
}

export interface ModerationIdentity {
  membershipId: string;
  accessToken: string;
  identityEpoch: number;
  signBaseUrl: string;
  environment: 'production' | 'test';
}

export function resolveModerationIdentity(
  input: ModerationEligibilityInput,
): ModerationIdentity | null {
  if (
    input.membershipKind !== 'personal'
    || !input.membershipId
    || !input.accessToken
  ) {
    return null;
  }

  if (input.isPackaged) {
    if (input.region === 'global') return null;
    if (input.region === 'cn') {
      if (!input.productionSignBaseUrl) return null;
      return {
        membershipId: input.membershipId,
        accessToken: input.accessToken,
        identityEpoch: input.identityEpoch,
        signBaseUrl: input.productionSignBaseUrl,
        environment: 'production',
      };
    }
  }

  if (!input.commandLineEnabled || !input.testSignBaseUrl) return null;
  return {
    membershipId: input.membershipId,
    accessToken: input.accessToken,
    identityEpoch: input.identityEpoch,
    signBaseUrl: input.testSignBaseUrl,
    environment: 'test',
  };
}
