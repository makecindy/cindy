import { randomUUID } from 'node:crypto';
import type {
  CloudProviderSetupKind,
  CloudProviderSetupSecrets,
} from '../../shared/cloudProviderSettings.js';
import type { ManagementExecution } from '../host-settings/management.js';

type Call = (
  channel: string,
  args: unknown[],
  execution: ManagementExecution,
  options?: { sender?: boolean },
) => Promise<unknown>;
type Request = Record<string, unknown>;
interface Stage {
  owner: string;
  kind: CloudProviderSetupKind;
  request: Request;
  expiresAt: number;
  phase: 'staged' | 'running' | 'done' | 'failed';
  result?: unknown;
}
export type ProviderSetupResult =
  { status: 'pending' } | { status: 'done'; value: unknown } | { status: 'failed' };

const TTL = 10 * 60_000;
const LIMIT = 32;
const AGENTS = ['claude-code', 'codex', 'pi'] as const;
const fail = (code: string, message: string): never => {
  throw new Error(`[${code}] ${message}`);
};
const object = (value: unknown): value is Request =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is Record<string, string> =>
  object(value) && Object.values(value).every((item) => typeof item === 'string');
const secretFree = (request: Request) =>
  !request.apiKey && !(object(request.headers) && Object.keys(request.headers).length);

/** Configurations reach the instance without request headers; those travel as secrets. */
export function hasRuntimeHeaders(config: unknown): boolean {
  const runtimes = object(config) && object(config.runtimes) ? config.runtimes : {};
  return Object.values(runtimes).some(
    (runtime) => object(runtime) && object(runtime.headers) && Object.keys(runtime.headers).length,
  );
}

function parseSecrets(raw: string | undefined): CloudProviderSetupSecrets {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail('INVALID_PARAMS', 'invalid setup secrets');
  }
  if (!object(value)) return fail('INVALID_PARAMS', 'invalid setup secrets');
  const out: CloudProviderSetupSecrets = {};
  if (value.apiKey !== undefined) {
    if (typeof value.apiKey !== 'string') fail('INVALID_PARAMS', 'invalid key');
    out.apiKey = value.apiKey as string;
  }
  if (value.headers !== undefined) {
    if (!strings(value.headers)) fail('INVALID_PARAMS', 'invalid headers');
    out.headers = value.headers as Record<string, string>;
  }
  for (const field of ['keys', 'runtimeHeaders'] as const) {
    const entries = value[field];
    if (entries === undefined) continue;
    if (!object(entries) || Object.keys(entries).some((agent) => !AGENTS.includes(agent as never)))
      fail('INVALID_PARAMS', `invalid ${field}`);
    for (const item of Object.values(entries as Request))
      if (field === 'keys' ? typeof item !== 'string' : !strings(item))
        fail('INVALID_PARAMS', `invalid ${field}`);
    (out as Record<string, unknown>)[field] = entries;
  }
  return out;
}

/**
 * Two-step provider setup of the cloud providers page. The private channel stages the
 * secret-free request; the CIS ticket applies it with the secrets (API keys, request
 * headers) or runs the interactive login, so neither crosses DeviceLink. The instance
 * owner stamp binds every stage; a stage runs once and its result is read once.
 */
export function createProviderSetup(call: Call, now = Date.now) {
  const stages = new Map<string, Stage>();
  const prune = () => {
    for (const [id, stage] of stages) if (stage.expiresAt <= now()) stages.delete(id);
  };

  async function run(
    kind: CloudProviderSetupKind,
    request: Request,
    secrets: CloudProviderSetupSecrets,
    execution: ManagementExecution,
  ): Promise<unknown> {
    const credentials = {
      ...(secrets.apiKey !== undefined ? { apiKey: secrets.apiKey } : {}),
      ...(secrets.headers ? { headers: secrets.headers } : {}),
    };
    switch (kind) {
      case 'models-fetch':
        return call('maker:provider:models-fetch', [{ ...request, ...credentials }], execution);
      case 'detect':
        return call('maker:provider:detect', [{ ...request, ...credentials }], execution, {
          sender: true,
        });
      case 'test-connection': {
        if (request.kind !== 'adhoc' || !object(request.spec))
          fail('INVALID_PARAMS', 'only a form connection test takes credentials');
        return call(
          'maker:provider:test-connection',
          [{ ...request, spec: { ...(request.spec as Request), ...credentials } }],
          execution,
          { sender: true },
        );
      }
      case 'custom-create':
      case 'custom-update': {
        const config = request.config;
        if (!object(config) || !object(config.runtimes) || hasRuntimeHeaders(config))
          fail('INVALID_PARAMS', 'invalid provider configuration');
        const runtimes = { ...(config as { runtimes: Request }).runtimes };
        for (const [agent, headers] of Object.entries(secrets.runtimeHeaders ?? {})) {
          const runtime = runtimes[agent];
          if (!object(runtime)) fail('INVALID_PARAMS', 'headers for an absent engine');
          runtimes[agent] = { ...(runtime as Request), headers };
        }
        return call(
          kind === 'custom-create'
            ? 'maker:provider:custom:create'
            : 'maker:provider:custom:update',
          [
            { ...(config as Request), runtimes },
            secrets.keys ?? {},
            request.options ?? { source: 'manual-settings' },
          ],
          execution,
        );
      }
      case 'builtin-key': {
        if (typeof request.providerId !== 'string' || !secrets.apiKey?.trim())
          fail('INVALID_PARAMS', 'a key is required');
        await call(
          'builtin-api-key-store',
          [request.providerId, secrets.apiKey!.trim()],
          execution,
        );
        execution.assertCurrent();
        if ((await call('builtin-api-key-has', [request.providerId], execution)) !== true)
          fail('INTERNAL', 'the key was not saved');
        return { ok: true };
      }
      case 'oauth-login':
        if (typeof request.providerId !== 'string') fail('INVALID_PARAMS', 'missing provider');
        return call(
          'maker:provider:oauth:login',
          [
            request.providerId,
            ...(request.method === 'device' || request.method === 'browser'
              ? [{ method: request.method }]
              : []),
          ],
          execution,
        );
      case 'native-login':
        // The instance's own Claude Code / Codex / Grok login, shown on the controlling computer.
        if (request.agent === 'claude') return call('maker:claude-oauth:login', [], execution);
        // No owner token: a cloud login has no window to hold it; cancelling the ticket ends it.
        if (request.agent === 'codex')
          return call('maker:auth:trigger-login', ['codex', { mode: 'device-code' }], execution);
        if (request.agent === 'xai')
          return call(
            'maker:xai-oauth:login',
            [request.method === 'device' ? 'device' : 'browser'],
            execution,
          );
        return fail('INVALID_PARAMS', 'unknown login');
    }
  }

  return {
    /** Probes without secrets go straight to the native handler. */
    secretFree,
    stage(owner: string, kind: CloudProviderSetupKind, request: Request): string {
      prune();
      if ([...stages.values()].filter((stage) => stage.owner === owner).length >= LIMIT)
        fail('BUSY', 'too many pending provider setups');
      if (
        (kind === 'custom-create' || kind === 'custom-update') &&
        hasRuntimeHeaders(request.config)
      )
        fail('INVALID_PARAMS', 'request headers travel with the secrets');
      if (kind !== 'custom-create' && kind !== 'custom-update' && !secretFree(request))
        fail('INVALID_PARAMS', 'credentials travel with the secrets');
      const id = randomUUID();
      stages.set(id, { owner, kind, request, expiresAt: now() + TTL, phase: 'staged' });
      return id;
    },
    result(owner: string, id: string): ProviderSetupResult {
      prune();
      const stage = stages.get(id);
      if (!stage || stage.owner !== owner) return fail('NOT_FOUND', 'unknown provider setup');
      if (stage.phase === 'staged' || stage.phase === 'running') return { status: 'pending' };
      stages.delete(id);
      return stage.phase === 'done'
        ? { status: 'done', value: stage.result }
        : { status: 'failed' };
    },
    async apply(
      owner: string,
      id: string,
      rawSecrets: string | undefined,
      execution: ManagementExecution,
    ): Promise<void> {
      prune();
      const stage = stages.get(id);
      if (!stage || stage.owner !== owner || stage.phase !== 'staged')
        fail('NOT_FOUND', 'unknown provider setup');
      stage!.phase = 'running';
      stage!.expiresAt = now() + TTL;
      try {
        stage!.result = await run(stage!.kind, stage!.request, parseSecrets(rawSecrets), execution);
        execution.assertCurrent();
        stage!.phase = 'done';
      } catch (error) {
        stage!.phase = 'failed';
        throw error;
      }
    },
  };
}
export type ProviderSetup = ReturnType<typeof createProviderSetup>;

let active: { setup: ProviderSetup; owner: () => string | null } | null = null;
/** Registered by the managed instance only; ordinary desktops never list the setup ticket. */
export function setProviderSetup(value: typeof active): void {
  active = value;
}
export function providerSetup(): typeof active {
  return active;
}
