import { randomUUID } from 'node:crypto';
import {
  storedCustomProviderId,
  providerPresetOAuth,
  providerPresetOAuthRuntimes,
  type AgentKind,
  type CustomProviderConfig,
  type ProviderPreset,
  type ProviderView,
} from '@cindy/model-providers';
import { getCustomProvider } from '../maker-host/custom-provider-store.js';
import { callCloudManagement, hasCloudManagementCall } from './managementCalls.js';
import { CLOUD_PROVIDER_SETUP_ITEM } from '../../shared/cloudProviderSettings.js';
import { providerSetup } from '../instance-runtime/providerSetup.js';
import {
  managementReadExecution,
  managementRecord,
  managementTextField,
} from './managementConnections.js';
import type {
  ManagementAction,
  ManagementCaller,
  ManagementEntry,
  ManagementExecution,
} from './management.js';

const options = { source: 'manual-settings' };
async function invoke(
  channel: string,
  args: unknown[],
  execution: ManagementExecution,
): Promise<void> {
  const result = managementRecord(await callCloudManagement(channel, args, execution));
  if (result.ok !== true) throw new Error('MANAGEMENT_PROVIDER_CHANGE_FAILED');
}
const keyField = managementTextField('apiKey', 'password');

/** Provider connection management calls the native handlers and their shared queues. */
export async function listProviderManagement(caller: ManagementCaller): Promise<ManagementEntry[]> {
  const read = managementReadExecution(caller);
  const snapshot = managementRecord(await callCloudManagement('maker:provider:list', [], read));
  const presetsResult = managementRecord(
    await callCloudManagement('maker:provider:presets', [], read),
  );
  if (!Array.isArray(snapshot.providers) || !Array.isArray(presetsResult.presets))
    throw new Error('MANAGEMENT_PROVIDER_UNAVAILABLE');
  const providers = snapshot.providers as ProviderView[],
    presets = presetsResult.presets as ProviderPreset[];
  const entries: ManagementEntry[] = [];
  for (const provider of providers) {
    const resource = `provider:${provider.id}`,
      actions: ManagementAction[] = [];
    const builtinSubscription =
      provider.source === 'builtin' && ['anthropic', 'openai', 'xai'].includes(provider.id);
    // Only the official CLI owns a Claude login.
    const standaloneClaude = provider.source === 'user' && provider.auth.native === 'claude';
    if (provider.id === 'anthropic' && builtinSubscription && provider.auth.method === 'oauth')
      actions.push({ resource, label: 'management.actions.authorize', intent: 'authorize',
        run: (_values, execution) => invoke('maker:claude-oauth:login', [], execution) });
    if (provider.auth.method === 'oauth' && !builtinSubscription && !standaloneClaude) {
      actions.push({
        resource,
        label: 'management.actions.authorize',
        intent: 'authorize',
        run: (_values, execution) => invoke('maker:provider:oauth:login', [provider.id], execution),
      });
      if (provider.connected)
        actions.push({
          resource,
          label: 'management.actions.disconnect',
          intent: 'disconnect',
          confirmation: 'management.confirm.disconnect',
          run: (_values, execution) =>
            invoke('maker:provider:oauth:logout', [provider.id, undefined, options], execution),
        });
    }
    if (builtinSubscription && provider.connected && provider.auth.method === 'oauth')
      actions.push({
        resource,
        label: 'management.actions.disconnect',
        intent: 'disconnect',
        confirmation: 'management.confirm.disconnect',
        async run(_values, execution) {
          const channel =
            provider.id === 'openai'
              ? 'maker:auth:logout'
              : provider.id === 'anthropic'
                ? 'maker:claude-oauth:logout'
                : 'maker:xai-oauth:logout';
          await callCloudManagement(channel, provider.id === 'openai' ? ['codex'] : [], execution);
          execution.assertCurrent();
          const fresh = managementRecord(
            await callCloudManagement('maker:provider:list', [], execution),
          );
          if (
            (fresh.providers as ProviderView[]).find((item) => item.id === provider.id)?.connected
          )
            throw new Error('MANAGEMENT_DISCONNECT_FAILED');
        },
      });
    if (provider.source === 'user') {
      const id = storedCustomProviderId(provider.id);
      if (provider.auth.method === 'apiKey')
        actions.push({
          resource,
          label: 'management.actions.connect',
          intent: 'connect',
          fields: [keyField],
          async run(values, execution) {
            const config = await getCustomProvider(id);
            execution.assertCurrent();
            if (!config || config.auth?.method === 'oauth') throw new Error('MANAGEMENT_CHANGED');
            const keys = Object.fromEntries(
              Object.keys(config.runtimes).map((agent) => [agent, values.apiKey]),
            );
            await invoke('cloud:provider:key-replace', [id, keys], execution);
          },
        });
      if (provider.connected && provider.auth.method !== 'oauth')
        actions.push({
          resource,
          label: 'management.actions.disconnect',
          intent: 'disconnect',
          confirmation: 'management.confirm.disconnect',
          run: (_values, execution) =>
            invoke(
              'maker:provider:custom:disconnect',
              [provider.id, undefined, options],
              execution,
            ),
        });
      actions.push({
        resource,
        label: 'management.actions.delete',
        intent: 'delete',
        confirmation: 'management.confirm.delete',
        run: (_values, execution) =>
          invoke('maker:provider:custom:delete', [id, undefined, options], execution),
      });
    }
    entries.push({
      id: resource,
      label: provider.name,
      status: provider.connected ? 'connected' : 'disconnected',
      group: 'management.currentProviders',
      actions,
    });
  }
  for (const brand of ['openai', 'xai'] as const) {
    if (!providers.some((provider) => provider.id === brand)) continue;
    const name = providers.find((provider) => provider.id === brand)!.name;
    entries.push({
      id: `add:${brand}`,
      label: name,
      group: 'management.addProvider',
      status: 'available',
      actions: [
        {
          resource: `provider:new:${brand}`,
          label: 'management.actions.authorize',
          intent: 'authorize',
          async run(_values, execution) {
            const id = `${brand}-${randomUUID().slice(0, 8)}`;
            const native = brand === 'openai' ? 'codex' : 'xai';
            const config: CustomProviderConfig = {
              id,
              name,
              auth: { method: 'oauth', native },
              runtimes: {
                      codex: {
                        baseUrl:
                          brand === 'openai'
                            ? 'https://chatgpt.com/backend-api/codex'
                            : 'https://api.x.ai/v1',
                        wireProtocol: 'openai-responses',
                        models: [],
                      },
                    },
            };
            await invoke('maker:provider:custom:create', [config, {}, options], execution);
            // A failed/cancelled login leaves a disconnected connection which can be
            // retried or explicitly deleted. Never call global logout as compensation.
            await invoke('maker:provider:oauth:login', [id], execution);
          },
        },
      ],
    });
  }
  for (const preset of presets) {
    const oauth = providerPresetOAuth(preset.id);
    if (!oauth) continue;
    entries.push({
      id: `add:${preset.id}`,
      label: preset.name,
      group: 'management.addProvider',
      status: 'available',
      actions: [
        {
          resource: `provider:new:${preset.id}`,
          label: 'management.actions.authorize',
          intent: 'authorize',
          async run(_values, execution) {
            const id = `web-${randomUUID().slice(0, 8)}`;
            await invoke(
              'maker:provider:custom:create',
              [
                {
                  id,
                  name: preset.name,
                  auth: { method: 'oauth', oauth },
                  runtimes: providerPresetOAuthRuntimes(preset),
                },
                {},
                options,
              ],
              execution,
            );
            await invoke('maker:provider:oauth:login', [id], execution);
          },
        },
      ],
    });
  }
  const apiPresets = presets.filter((preset) => !providerPresetOAuth(preset.id));
  if (apiPresets.length)
    entries.push({
      id: 'add:api-preset',
      label: 'API provider',
      labelKey: 'management.apiProvider',
      status: 'available',
      group: 'management.addProvider',
      actions: [
        {
          resource: 'provider:new:preset',
          intent: 'create',
          label: 'management.actions.connect',
          fields: [
            {
              ...managementTextField('preset', 'select'),
              value: apiPresets[0]!.id,
              options: apiPresets.map((preset) => ({ value: preset.id, label: preset.name })),
            },
            { ...keyField, required: false },
          ],
          async run(values, execution) {
            const preset = apiPresets.find((value) => value.id === values.preset);
            if (!preset || (preset.authMethod !== 'none' && !values.apiKey?.trim()))
              throw new Error('MANAGEMENT_INVALID_INPUT');
            const runtimes = Object.fromEntries(
              Object.entries(preset.runtimes).map(([agent, runtime]) => [
                agent,
                {
                  baseUrl: runtime!.baseUrl,
                  wireProtocol: runtime!.wireProtocol,
                  requestPath: runtime!.requestPath,
                  supportsImageGeneration: runtime!.supportsImageGeneration,
                  models: runtime!.models,
                  headers: runtime!.headers,
                  modelsUrl: runtime!.modelsUrl,
                  modelDiscovery: runtime!.modelDiscovery,
                  piCatalogProviderId: runtime!.piCatalogProviderId,
                },
              ]),
            );
            const config = {
              id: `web-${randomUUID().slice(0, 8)}`,
              name: preset.name,
              catalogPresetId: preset.id,
              auth: { method: preset.authMethod ?? 'apiKey' },
              runtimes,
            };
            const keys =
              preset.authMethod === 'none'
                ? {}
                : Object.fromEntries(Object.keys(runtimes).map((agent) => [agent, values.apiKey]));
            await invoke('maker:provider:custom:create', [config, keys, options], execution);
          },
        },
      ],
    });
  for (const id of ['gemini', 'openai-images']) {
    if (!hasCloudManagementCall('builtin-api-key-store')) continue;
    const connected = (await callCloudManagement('builtin-api-key-has', [id], read)) === true;
    entries.push({
      id: `builtin-key:${id}`,
      label: id === 'gemini' ? 'Gemini API' : 'OpenAI API',
      group: 'management.currentProviders',
      status: connected ? 'connected' : 'disconnected',
      actions: [
        {
          resource: `provider:key:${id}`,
          label: 'management.actions.connect',
          intent: 'connect',
          fields: [{ ...keyField, maxLength: 1024 }],
          async run(values, execution) {
            await callCloudManagement('builtin-api-key-store', [id, values.apiKey], execution);
            execution.assertCurrent();
            if ((await callCloudManagement('builtin-api-key-has', [id], execution)) !== true)
              throw new Error('MANAGEMENT_PROVIDER_CHANGE_FAILED');
          },
        },
        ...(connected
          ? [
              {
                resource: `provider:key:${id}`,
                label: 'management.actions.disconnect',
                intent: 'disconnect' as const,
                confirmation: 'management.confirm.disconnect',
                async run(_values: Record<string, string>, execution: ManagementExecution) {
                  await callCloudManagement('builtin-api-key-remove', [id], execution);
                  execution.assertCurrent();
                  if ((await callCloudManagement('builtin-api-key-has', [id], execution)) === true)
                    throw new Error('MANAGEMENT_PROVIDER_CHANGE_FAILED');
                },
              },
            ]
          : []),
      ],
    });
  }
  entries.push({
    id: 'add:custom',
    label: 'Custom provider',
    labelKey: 'management.customProvider',
    status: 'available',
    group: 'management.addProvider',
    actions: [
      {
        resource: 'provider:new:custom',
        intent: 'create',
        label: 'management.actions.create',
        fields: [
          managementTextField('name'),
          managementTextField('baseUrl'),
          keyField,
          {
            ...managementTextField('protocol', 'select'),
            value: 'openai-responses',
            options: [
              { value: 'openai-responses', label: 'OpenAI Responses' },
              { value: 'openai-chat', label: 'OpenAI Chat Completions' },
              { value: 'anthropic-messages', label: 'Anthropic Messages' },
            ],
          },
          { ...managementTextField('models', 'textarea'), maxLength: 8192 },
        ],
        async run(values, execution) {
          const url = new URL(values.baseUrl!);
          if (
            !['https:', 'http:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.hash
          )
            throw new Error('MANAGEMENT_INVALID_INPUT');
          const models = [
            ...new Set(
              values
                .models!.split(/\r?\n/u)
                .map((value) => value.trim())
                .filter(Boolean),
            ),
          ];
          if (!models.length || models.length > 128 || models.some((id) => id.length > 256))
            throw new Error('MANAGEMENT_INVALID_INPUT');
          const agent: AgentKind =
            values.protocol === 'anthropic-messages'
              ? 'claude-code'
              : values.protocol === 'openai-responses'
                ? 'codex'
                : 'pi';
          const config = {
            id: `web-${randomUUID().slice(0, 8)}`,
            name: values.name!.trim(),
            auth: { method: 'apiKey' },
            runtimes: {
              [agent]: {
                baseUrl: values.baseUrl!.trim(),
                wireProtocol: values.protocol,
                models: models.map((id) => ({ id, name: id, defaultEnabled: true })),
              },
            },
          };
          await invoke(
            'maker:provider:custom:create',
            [config, { [agent]: values.apiKey }, options],
            execution,
          );
        },
      },
    ],
  });
  // Cloud providers page: applies a staged wizard or connection-form step with its secrets.
  const setup = providerSetup();
  if (setup)
    entries.push({
      id: CLOUD_PROVIDER_SETUP_ITEM,
      label: 'Provider setup',
      status: 'available',
      group: 'management.providerSetup',
      actions: [
        {
          resource: 'provider:setup',
          intent: 'connect',
          label: 'management.actions.connect',
          fields: [
            { ...managementTextField('stage'), maxLength: 64 },
            { ...managementTextField('secrets', 'password', false), maxLength: 16_384 },
          ],
          async run(values, execution) {
            const owner = setup.owner();
            if (!owner) throw new Error('MANAGEMENT_OWNER_CHANGED');
            await setup.setup.apply(owner, values.stage!, values.secrets, execution);
          },
        },
      ],
    });
  caller.assertCurrent();
  return entries;
}
