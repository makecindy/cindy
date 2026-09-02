// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSkillhubIdentityPolicy } from '../useSkillhubIdentityPolicy';

describe('useSkillhubIdentityPolicy', () => {
  const capabilities = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      skillhub: { capabilities },
    };
  });

  it('keeps organization writes disabled until the server capability arrives', async () => {
    let resolveCapabilities!: (value: unknown) => void;
    capabilities.mockReturnValue(new Promise((resolve) => {
      resolveCapabilities = resolve;
    }));

    const { result } = renderHook(() => useSkillhubIdentityPolicy({
      membershipKind: 'org',
      orgSlug: 'example-org',
    }));

    expect(result.current.canWrite).toBe(false);
    resolveCapabilities({
      success: true,
      capabilities: {
        canWrite: true,
        ownerType: 'organization',
        allowedVisibilities: ['shared', 'public'],
        readOnlyReason: null,
      },
    });
    await waitFor(() => expect(result.current.canWrite).toBe(true));
    expect(result.current.allowedVisibilities).toEqual(['DEPARTMENT_SCOPED', 'PUBLIC']);
  });

  it('uses the generic read-only capability without inspecting organization names', async () => {
    capabilities.mockResolvedValue({
      success: true,
      capabilities: {
        canWrite: false,
        ownerType: 'organization',
        allowedVisibilities: [],
        readOnlyReason: 'organization-catalog-read-only',
      },
    });

    const { result } = renderHook(() => useSkillhubIdentityPolicy({
      membershipKind: 'org',
      orgSlug: 'any-organization',
    }));

    await waitFor(() => {
      expect(result.current.readOnlyReason).toBe('organization-catalog-read-only');
    });
    expect(result.current.canWrite).toBe(false);
  });
});
