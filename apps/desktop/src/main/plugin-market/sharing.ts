import { isValidPluginResourceId, parsePublicPluginPresentation } from '@cindy/plugin-protocol';
import type { ShareContent } from '../../shared/share.js';
import { getBuildClientEndpoint } from '../clientEndpointsService.js';
import * as authManager from '../authManager.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { serverApiFetch, ServerApiError } from '../serverApiClient.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { rememberIssuedClipboardText } from '../textClipboard.js';

/** The fixed Share Server owns the immutable resource/profile binding. */
export async function preparePluginShare(
  pluginId: unknown,
  options: unknown = undefined,
): Promise<ShareContent> {
  if (!isValidPluginResourceId(pluginId))
    throwIpcError('INVALID_PARAMS', 'Invalid public plugin reference');
  if (
    options !== undefined &&
    (!options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      typeof (options as Record<string, unknown>).includeAttribution !== 'boolean' ||
      Object.keys(options).some((key) => key !== 'includeAttribution'))
  ) {
    throwIpcError('INVALID_PARAMS', 'Invalid share options');
  }
  // Absent options preserve the existing anonymous IPC contract for old callers.
  const includeAttribution =
    (options as { includeAttribution?: boolean } | undefined)?.includeAttribution === true;
  const session = authManager.getAuthState();
  const realm = authManager.getActiveAuthRealm();
  const isCurrent = () => {
    const current = authManager.getAuthState();
    return (
      current.ownerGeneration === session.ownerGeneration &&
      current.user?.id === session.user?.id &&
      authManager.getActiveAuthRealm() === realm &&
      current.mode === session.mode
    );
  };
  // Public sharing follows the installed edition, not a cross-realm organization session.
  const baseUrl = getBuildClientEndpoint('shareBaseUrl');
  if (!baseUrl) throwIpcError('SHARE_NOT_CONFIGURED', 'Sharing is not configured');
  const region = CURRENT_CINDY_REGION === 'global' ? 'global' : 'cn';
  try {
    const signed = includeAttribution && session.isAuthenticated && !!session.user;
    const request = (token: string | null) => {
      if (!isCurrent() || (signed && !token)) throw new Error('Share owner unavailable');
      return serverApiFetch<unknown>('/api/shares', {
        baseUrl,
        method: 'POST',
        body: { kind: 'plugin', reference: pluginId, includeAttribution: signed,
          region, lang: region === 'cn' ? 'zh-CN' : 'en', ...(signed ? { authRealm: realm } : {}) },
        token,
        skipAutoRefresh: true,
        skipSessionInvalidation: true,
        timeoutMs: 20000,
        cache: 'no-store',
        redactErrorDetails: true,
        allowedRedactedErrorCodes: ['TOKEN_EXPIRED'],
        logLabel: '/api/shares',
      });
    };
    let raw: unknown;
    try {
      raw = await request(signed ? authManager.getAccessToken() : null);
    } catch (error) {
      if (!signed || !isCurrent() || !(error instanceof ServerApiError) ||
        error.statusCode !== 401 || error.code !== 'TOKEN_EXPIRED') throw error;
      // Refresh only the original owner, then retry once with that owner's current token.
      if (!(await authManager.refresh()) || !isCurrent()) throw error;
      raw = await request(authManager.getAccessToken());
    }
    if (!raw || typeof raw !== 'object') throw new Error('Invalid share response');
    const row = raw as Record<string, unknown>;
    if (row.schemaVersion !== 1 || row.kind !== 'plugin')
      throw new Error('Unsupported share response');
    const plugin = parsePublicPluginPresentation(row.plugin);
    // The service can resolve legacy IDs, but cannot redirect the client to an arbitrary origin.
    if (typeof row.shareId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(row.shareId) || row.includeAttribution !== signed)
      throw new Error('Invalid share binding');
    const url = `${baseUrl}/s/${row.shareId}`;
    if (
      row.url !== url ||
      typeof row.imageSvg !== 'string' ||
      row.imageSvg.length > 1024 * 1024 ||
      !row.imageSvg.startsWith('<svg ')
    )
      throw new Error('Invalid share material');
    let attribution: ShareContent['attribution'];
    if (signed && row.attribution && typeof row.attribution === 'object') {
      const name = (row.attribution as Record<string, unknown>).displayName;
      if (typeof name === 'string' && name.trim() && name.length <= 256)
        attribution = { displayName: name.trim() };
    }
    if (!isCurrent()) throw new Error('Share owner changed');
    rememberIssuedClipboardText(url);
    return {
      title: plugin.name,
      url,
      imageSvg: row.imageSvg,
      ...(attribution ? { attribution } : {}),
    };
  } catch (error) {
    if (error instanceof ServerApiError && error.statusCode === 404) {
      throwIpcError('SHARE_UNAVAILABLE', 'Public plugin is unavailable');
    }
    throwIpcError('SHARE_READ_FAILED', 'Could not prepare sharing material');
  }
}
