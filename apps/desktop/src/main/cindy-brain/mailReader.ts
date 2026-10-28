import { mailReaderMatches, parseMailMessage, parseMailDraftCallId, type MailReaderDeclaration, type MailPreviewResult } from '@cindy/maker-shared/mail-message';
import { RemoteResourceRegistryError, type RemoteResourceProvider } from '../device-link/remoteResourceRegistry.js';

export interface MailReaderPlugin { id: string; namespace?: string | null; name?: string; enabled: boolean; ready?: boolean; reader: MailReaderDeclaration }
const providerKey = (p: MailReaderPlugin) => JSON.stringify([p.id, p.namespace ?? null]);
export function createMailReader(deps: {
  plugins(): MailReaderPlugin[];
  authorize(sessionId: string): Promise<void>;
  captureScope(): () => boolean;
  call(plugin: MailReaderPlugin, sessionId: string, url: string, opened?: true): Promise<{ ok: boolean; result?: unknown; message?: string; draftCallId?: string }>;
}) {
  return async (sessionId: unknown, url: unknown, read: unknown, opened: unknown = false, providerId: unknown = undefined): Promise<MailPreviewResult> => {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 || typeof url !== 'string' || url.length > 2048 || typeof read !== 'boolean' || typeof opened !== 'boolean')
      throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Invalid mail link');
    if (providerId !== undefined && (typeof providerId !== 'string' || !providerId || providerId.length > 512))
      throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Invalid mail reader');
    const valid = deps.captureScope();
    await deps.authorize(sessionId);
    const check = () => { if (!valid()) throw new RemoteResourceRegistryError('NOT_FOUND', 'Mail unavailable'); };
    check();
    const candidates = deps.plugins().filter(p => p.enabled && mailReaderMatches(p.reader, url));
    if (!candidates.length) return { supported: false };
    // Readiness is host setup metadata, never a probe against every mailbox.
    // Explicit choices stay pinned even when another instance becomes ready.
    const ready = candidates.filter(p => p.ready !== false);
    // A registered but unconfigured reader must not take over ordinary links.
    if (!read) return { supported: ready.length > 0 };
    if (!ready.length && providerId === undefined) return { supported: true, error: 'MAIL_PROVIDER_NOT_READY' };
    const provider = providerId !== undefined ? candidates.find(p => providerKey(p) === providerId)
      : ready.length === 1 ? ready[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (!provider) return { supported: true, error: providerId === undefined ? 'MAIL_PROVIDER_AMBIGUOUS' : 'MAIL_PROVIDER_UNAVAILABLE',
      providers: (ready.length ? ready : candidates).map(p => ({ id: providerKey(p), name: p.name || p.id, namespace: p.namespace ?? null })) };
    if (provider.ready === false) return { supported: true, error: 'MAIL_PROVIDER_NOT_READY' };
    const result = opened
      ? await deps.call(provider, sessionId, url, true)
      : await deps.call(provider, sessionId, url);
    check();
    await deps.authorize(sessionId); check();
    const message = result.ok ? parseMailMessage(result.result) : null;
    if (message?.conversation?.messages.some(m => !mailReaderMatches(provider.reader, m.url))) {
      delete message.conversation;
      message.conversationUnavailable = true;
    }
    const draftCallId = opened ? parseMailDraftCallId(result.draftCallId) : undefined;
    return message ? { supported: true, message, ...(draftCallId ? { draftCallId } : {}), providerId: providerKey(provider) } : { supported: true, error: 'MAIL_READ_FAILED' };
  };
}

/** Existing device-link resource transport, scoped exactly like plugin cards. */
export function mailReaderRemoteProvider(read: ReturnType<typeof createMailReader>): RemoteResourceProvider {
  const collectionId = 'mail-messages';
  return {
    collection: { id: collectionId, resourceKind: 'message', title: 'Mail' },
    async list() { return { collectionId, revision: '1', items: [] }; },
    async get(_context, request) {
      let args: unknown; try { args = JSON.parse(request.ref.id); } catch { /* validated below */ }
      if (!Array.isArray(args) || args.length !== 3) throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Invalid mail link');
      // query is optional and ignored by older hosts; the existing read-only ID stays compatible.
      let opened = request.query === 'open', providerId: unknown;
      if (request.query?.startsWith('{')) {
        let selection: unknown;
        try { selection = JSON.parse(request.query); } catch { throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Invalid mail reader'); }
        if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Invalid mail reader');
        const p = selection as Record<string, unknown>;
        if (typeof p.opened !== 'boolean' || typeof p.providerId !== 'string') throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Invalid mail reader');
        opened = p.opened; providerId = p.providerId;
      }
      const result = await read(args[0], args[1], args[2], opened, providerId);
      return { ref: request.ref, revision: '1', display: { title: result.message?.subject || 'Mail' }, links: [],
        blocks: [{ id: 'message', primitive: 'mail-message', fallbackMarkdown: result.message?.bodyText.slice(0, 16000) || '', data: result }] };
    },
  };
}
