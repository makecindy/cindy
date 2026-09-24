import { afterEach, describe, expect, it } from 'vitest';

import {
  readByokCredential,
  readByokInferenceBase,
  isInstalledByokProvider,
  setByokCredentialReader,
  setByokEndpointReader,
  setByokManagedProviderReader,
} from '../byokCredentials.js';
import { isExternalOrganizationByokUser } from '../organizationManaged.js';

afterEach(() => {
  setByokCredentialReader(() => null);
  setByokEndpointReader(() => null);
  setByokManagedProviderReader(() => false);
});

describe('BYOK live credential readers', () => {
  it('enables managed BYOK only for external organization identities', () => {
    expect(isExternalOrganizationByokUser(null)).toBe(false);
    expect(
      isExternalOrganizationByokUser({
        membershipKind: 'personal',
        orgId: null,
        orgSlug: null,
        orgName: null,
      }),
    ).toBe(false);
    expect(
      isExternalOrganizationByokUser({
        membershipKind: 'org',
        orgId: 'org-xd',
        orgSlug: 'xd',
        orgName: 'XD',
      }),
    ).toBe(false);
    expect(
      isExternalOrganizationByokUser({
        membershipKind: 'org',
        orgId: null,
        orgSlug: 'acme',
        orgName: 'Acme',
      }),
    ).toBe(false);
    expect(
      isExternalOrganizationByokUser({
        membershipKind: 'org',
        orgId: 'org-acme',
        orgSlug: 'acme',
        orgName: 'Acme',
      }),
    ).toBe(true);
  });

  it('does not require a chat engine to read the image key', () => {
    setByokCredentialReader((id, agent) =>
      id === 'byok-a' && agent === 'image' ? 'member-key' : null,
    );
    expect(readByokCredential('byok-a', 'image')).toBe('member-key');
    expect(readByokCredential('byok-a', 'pi')).toBeNull();
  });

  it('does not turn a legacy personal prefix into a live managed connection', () => {
    expect(isInstalledByokProvider('byok-legacy-personal')).toBe(false);
    setByokManagedProviderReader((id) => id === 'byok-live');
    expect(isInstalledByokProvider('byok-live')).toBe(true);
  });

  it.each([
    ['https://gateway.example.invalid/v1', 'https://gateway.example.invalid'],
    ['https://gateway.example.invalid/v1/', 'https://gateway.example.invalid'],
    ['https://gateway.example.invalid', 'https://gateway.example.invalid'],
    ['https://gateway.example.invalid/', 'https://gateway.example.invalid'],
  ] as const)('normalizes %s to the OpenAI-images origin', (endpoint, origin) => {
    setByokEndpointReader(() => endpoint);
    expect(readByokInferenceBase('byok-a')).toBe(origin);
    expect(readByokInferenceBase('byok-missing')).toBe(origin);
  });

  it('returns null after the installed connection disappears', () => {
    setByokEndpointReader((id) => (id === 'byok-a' ? 'https://gateway.example.invalid/v1' : null));
    expect(readByokInferenceBase('byok-a')).toBe('https://gateway.example.invalid');
    expect(readByokInferenceBase('byok-b')).toBeNull();
    setByokEndpointReader(() => null);
    expect(readByokInferenceBase('byok-a')).toBeNull();
  });
});
