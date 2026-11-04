/** Display-only quota; never used to route or authorize model requests. */
export interface CliProxyQuotaBucket {
  label: string;
  window: string;
  remainingFraction: number;
  resetTime: string | null;
  disabled: boolean;
}
export interface CliProxyQuotaAccount {
  name: string;
  disabled: boolean;
  unavailable: boolean;
  groups: { label: string; buckets: CliProxyQuotaBucket[] }[];
}
export interface CliProxyQuotaSnapshot {
  configured: boolean;
  accounts: CliProxyQuotaAccount[];
  observedAt: number;
}

/** Only explicit loopback addresses; never resolve an arbitrary hostname. */
export function cliProxyManagementBase(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !['', '/', '/v1', '/v1/'].includes(url.pathname) ||
      url.search ||
      url.hash
    )
      return null;
    return `${url.origin}/v8/management`;
  } catch {
    return null;
  }
}

export function parseCliProxyQuota(value: unknown): CliProxyQuotaAccount['groups'] {
  if (!value || typeof value !== 'object') return [];
  const groups = (value as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return [];
  return groups.slice(0, 20).flatMap((group) => {
    if (!group || typeof group !== 'object' || !Array.isArray(group.buckets)) return [];
    const buckets = group.buckets.slice(0, 20).flatMap((bucket: Record<string, unknown>) => {
      if (
        !bucket ||
        typeof bucket !== 'object' ||
        typeof bucket.remainingFraction !== 'number' ||
        !Number.isFinite(bucket.remainingFraction) ||
        bucket.remainingFraction < 0 ||
        bucket.remainingFraction > 1
      )
        return [];
      return [
        {
          label: typeof bucket.displayName === 'string' ? bucket.displayName.slice(0, 200) : '',
          window: typeof bucket.window === 'string' ? bucket.window.slice(0, 40) : '',
          remainingFraction: bucket.remainingFraction,
          resetTime:
            typeof bucket.resetTime === 'string' && Number.isFinite(Date.parse(bucket.resetTime))
              ? bucket.resetTime
              : null,
          disabled: bucket.disabled === true,
        },
      ];
    });
    return buckets.length
      ? [
          {
            label: typeof group.displayName === 'string' ? group.displayName.slice(0, 200) : '',
            buckets,
          },
        ]
      : [];
  });
}
