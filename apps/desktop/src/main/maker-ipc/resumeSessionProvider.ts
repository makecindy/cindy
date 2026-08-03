import type { AgentKind } from '@cindy/maker-core';

export interface ResumeSessionProviderOpts {
  agentKind: AgentKind;
  model?: string;
  providerId?: string | null;
}

export interface ResumeSessionProviderDeps<TOpts extends ResumeSessionProviderOpts, TSession> {
  resolveImplicitUserProvider(agent: AgentKind, model: string): Promise<string | null>;
  createSession(opts: TOpts): Promise<TSession>;
}

/**
 * A verified resume may carry the historical `provider_id = NULL` representation of an
 * implicit user provider. Materialize that provider before handing the options to Maker so
 * Codex chooses the API-key transport instead of the ChatGPT subscription transport.
 */
export async function createVerifiedResumeSession<
  TOpts extends ResumeSessionProviderOpts,
  TSession,
>(
  opts: TOpts,
  verifiedResume: boolean,
  deps: ResumeSessionProviderDeps<TOpts, TSession>,
): Promise<TSession> {
  if (verifiedResume && !opts.providerId && typeof opts.model === 'string' && opts.model) {
    const providerId = await deps.resolveImplicitUserProvider(opts.agentKind, opts.model);
    if (providerId) opts.providerId = providerId;
  }
  return deps.createSession(opts);
}
