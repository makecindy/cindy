import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { createCloudSettingsService, type CloudClientCaller } from '../service';
import { cloudSettingsClientHandlers } from '../ipc';
import { CloudClientError, type CloudClientIdentity } from '../transport';
import { createSettingsManagement, type ManagementExecution } from '../../host-settings/management';
import { additionalSettingsSchemas } from '../../../shared/settingsEditableCatalog';
import type { CloudSettingsState } from '../../../shared/cloudSettings';
import type { CloudSettingsRendererApi } from '../../../shared/cloudSettingsClient';
import type { SettingsWebCommand, SettingsWebResult } from '../../../shared/settingsWeb';

/** In-memory CIS candidate envelope + existing management engine; no live service. */
export function fixture(
  desktop?: {
    domain: 'desktopGeneral' | 'desktopChat';
    defaults: NonNullable<CloudSettingsState['defaults']>;
  },
  // The Host answers after the POST (as on CIS), and whether CIS holds `?wait=1` reads.
  queue?: { resultWait: boolean },
) {
  let desktopValue = { ...desktop?.defaults };
  let desktopKeys: string[] = [];
  let identity: CloudClientIdentity | null = {
    key: 'owner-a:realm-cn:1',
    generation: 1,
    baseUrl: 'https://cis.example.test',
    accessToken: 'invalid-test-token',
  };
  let value = true,
    revision = 'r1',
    unsupported = false,
    lose = false,
    unknown = false;
  const runtimeId = randomUUID(),
    history: SettingsWebCommand[] = [];
  const results = new Map<string, SettingsWebResult>(),
    receipts = new Map<string, SettingsWebResult>();
  const cancelled = vi.fn();
  const run = vi.fn(async (_values: Record<string, string>, execution: ManagementExecution) => {
    execution.prompt({
      kind: 'device',
      userCode: 'SAMPLE-CODE',
      url: 'https://login.example.test',
      expiresAt: Date.now() + 60000,
    });
    execution.onCancel(cancelled);
    await new Promise<void>((resolve) =>
      execution.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  });
  const engine = createSettingsManagement({
    list: async () => [
      {
        id: 'provider:example',
        label: 'Example',
        status: 'disconnected',
        actions: [{ resource: 'provider:example', intent: 'authorize', label: 'Authorize', run }],
      },
    ],
  });
  const state = (): SettingsWebResult => ({
    ok: true,
    settings: {
      domain: desktop?.domain ?? 'memory',
      status: 'ready',
      revision,
      operationId: randomUUID(),
      value: desktop ? desktopValue : { maker: value, claudeCode: true, codex: true, pi: true },
      defaults: desktop?.defaults ?? { maker: true, claudeCode: true, codex: true, pi: true },
      isCustomized: desktop ? desktopKeys.length > 0 : !value,
      customizedKeys: desktop ? desktopKeys : value ? [] : ['maker'],
    },
  });
  const request = vi.fn(
    async (
      _identity: CloudClientIdentity,
      path: string,
      method: string,
      body: unknown,
      signal: AbortSignal,
      check: () => void,
    ): Promise<unknown> => {
      check();
      if (signal.aborted) throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
      if (path === '/instance-login/api/manage/instances')
        return { instances: [{ instanceId: 'instance-a', deviceId: 'cloud-a' }] };
      if (method === 'POST' && path.endsWith('/sessions')) {
        if (unsupported) throw new CloudClientError('CLOUD_SETTINGS_UNSUPPORTED');
        return {
          sessionId: randomUUID(),
          instanceId: 'instance-a',
          deviceId: 'cloud-a',
          runtimeId,
          domains: [desktop?.domain ?? 'memory', 'personalization', 'gitSafety', 'shortcuts'],
          readBatch: true,
          managementV1: true,
          ...(queue?.resultWait === false ? {} : { resultWait: true }),
          resourceCpuCores: 4,
        };
      }
      const sessionId = path.match(/\/sessions\/([^/?]+)/)?.[1];
      if (method === 'DELETE') return undefined;
      if (path.endsWith('/heartbeat')) return undefined;
      if (method === 'GET') {
        const requestId = path.match(/\/requests\/([^/?]+)/)?.[1];
        if (!requestId) throw Error('invalid fixture request');
        if (unknown || !results.has(requestId)) return { requestId, status: 'unknown' };
        return { requestId, status: 'complete', result: results.get(requestId) };
      }
      const input = body as { requestId: string; command: SettingsWebCommand };
      history.push(input.command);
      let result: SettingsWebResult;
      const command = input.command;
      if (command.kind === 'read') result = state();
      else if (command.kind === 'readBatch')
        result = {
          ok: true,
          entries: [{ domain: desktop?.domain ?? 'memory', result: state() as never }],
          remainingDomains: [],
        };
      else if (command.kind === 'receipt')
        result = receipts.get(command.operationId) ?? { ok: true, receipt: { status: 'unknown' } };
      else if (command.kind === 'update') {
        if (command.change.expectedRevision !== revision) result = { ok: false, code: 'CONFLICT' };
        else {
          const change = command.change;
          if (desktop) {
            desktopKeys = [
              ...new Set([
                ...desktopKeys.filter((key) => !change.clear?.includes(key)),
                ...Object.keys(change.set ?? {}),
              ]),
            ];
            desktopValue = additionalSettingsSchemas[desktop.domain].parse({
              ...desktopValue,
              ...Object.fromEntries(
                (change.clear ?? []).map((key) => [key, desktop.defaults[key]]),
              ),
              ...change.set,
            });
          }
          value = change.clear?.includes('maker')
            ? true
            : ((change.set as { maker?: boolean }).maker ?? value);
          revision = 'r' + (Number(revision.slice(1)) + 1);
          result = {
            ok: true,
            receipt: {
              status: 'saved',
              saved: true,
              operationId: change.operationId,
              domain: change.domain,
              revision,
              application: 'next_agent_start',
            },
          };
          receipts.set(change.operationId, result);
        }
      } else if (command.kind === 'manage')
        result = {
          ok: true,
          management: await engine.execute(
            { key: sessionId!, assertCurrent: check },
            command.command,
          ),
        };
      // Browser-only Host calls never come from the native client.
      else result = { ok: false, code: 'SETTINGS_UNSUPPORTED' };
      results.set(input.requestId, result);
      if (lose && ['update', 'manage'].includes(command.kind)) {
        lose = false;
        throw new CloudClientError('CLOUD_SETTINGS_UNAVAILABLE');
      }
      return queue
        ? { requestId: input.requestId, status: 'queued' }
        : { requestId: input.requestId, status: 'complete', result };
    },
  );
  const pause = vi.fn(async () => {});
  const service = createCloudSettingsService({
    identity: () => identity,
    http: { request },
    ...(queue ? { pause } : {}),
  });
  const handlers = cloudSettingsClientHandlers(service);
  const caller = (id = 1): CloudClientCaller => ({ id, assertCurrent() {} });
  const bridge = (id = 1): CloudSettingsRendererApi =>
    Object.fromEntries(
      Object.entries(handlers).map(([key, handler]) => [
        key,
        (raw: unknown) => handler(caller(id), raw),
      ]),
    ) as unknown as CloudSettingsRendererApi;
  return {
    service,
    bridge,
    caller,
    request,
    pause,
    history,
    engine,
    run,
    cancelled,
    runtimeId,
    setIdentity: (next: CloudClientIdentity | null) => {
      identity = next;
    },
    identity: () => identity!,
    unsupported: () => {
      unsupported = true;
    },
    loseReply: () => {
      lose = true;
    },
    unknown: () => {
      unknown = true;
    },
    externalChange: () => {
      revision = 'external';
    },
    state,
    stop: () => {
      service.invalidate();
      engine.stop();
    },
  };
}
