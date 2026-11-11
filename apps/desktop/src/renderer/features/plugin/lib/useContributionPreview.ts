import { useEffect, useRef, useState } from 'react';
import { extractIpcError } from '@/utils/ipcError';
import type { PluginContributionsApi, PreparedPluginContribution } from '../../../../shared/pluginContributions';

const copy = 'settings.ghosts.contribution';
export function contributionErrorKey(error: unknown): string {
  const code = extractIpcError(error)?.code;
  if (code === 'OFFICIAL_PLUGIN_GITHUB_REQUIRED') return `${copy}.unavailable.officialGithubRequired`;
  if (!navigator.onLine && (!code || code === 'INTERNAL')) return `${copy}.offline`;
  if (code === 'PERMISSION_DENIED') return `${copy}.permissionDenied`;
  if (code === 'NOT_FOUND') return `${copy}.notFound`;
  if (code === 'OWNER_CHANGED') return `${copy}.accountChanged`;
  return code ? `${copy}.errors.${code}` : navigator.onLine ? `${copy}.loadFailed` : `${copy}.offline`;
}

/** All three existing publishing surfaces own a preview in the same way. */
export function useContributionPreview(
  key: string,
  instanceId: string | undefined,
  version: string | undefined,
  prepare: PluginContributionsApi['prepare'],
  discard: PluginContributionsApi['discard'],
) {
  const input = JSON.stringify([key, instanceId, version]);
  const current = useRef({ input, token: {} });
  if (current.current.input !== input) current.current = { input, token: {} };
  const token = current.current.token;
  const callbacks = useRef({ prepare, discard });
  callbacks.current = { prepare, discard };
  const [snapshot, setSnapshot] = useState<{
    token: object; prepared?: PreparedPluginContribution; error?: string;
  } | null>(null);
  useEffect(() => {
    if (!instanceId) return;
    let disposed = false;
    let held: string | undefined;
    const { prepare, discard } = callbacks.current;
    void Promise.resolve().then(() => disposed ? null : prepare(instanceId)).then(prepared => {
      if (!prepared) return;
      if (disposed || current.current.token !== token) {
        void discard(prepared.preparedId).catch(() => undefined);
      } else if (prepared.instanceId !== instanceId || (version !== undefined && prepared.version !== version)) {
        void discard(prepared.preparedId).catch(() => undefined);
        setSnapshot({ token, error: `${copy}.errors.CONTRIBUTION_PACKAGE_CHANGED` });
      } else {
        held = prepared.preparedId;
        setSnapshot({ token, prepared });
      }
    }).catch(error => {
      if (!disposed && current.current.token === token) setSnapshot({ token, error: contributionErrorKey(error) });
    });
    return () => {
      disposed = true;
      if (held) void discard(held).catch(() => undefined);
    };
  }, [token, instanceId, version]);
  return snapshot?.token === token ? snapshot : null;
}
