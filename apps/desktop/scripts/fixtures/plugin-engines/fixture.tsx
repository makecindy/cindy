import { useState } from 'react';
import type { ProviderView } from '@cindy/model-providers';
import { mountPage, subscription } from '../../ui-page/harness';
import { ModelSelector, ModelSelectorContent } from '../../../src/renderer/components/new-chat/ModelSelector';
import type { PluginEngineView } from '../../../src/shared/pluginEngines';
import type { PluginEngineSelection } from '../../../src/renderer/lib/pluginEngineSelection';

const providers = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: 'oauth' },
    routing: { 'claude-code': {} },
    connected: true,
    models: {
      'claude-code': [
        { id: 'claude-opus-5', name: 'Opus 5', group: 'anthropic', sortOrder: 1, contextWindow: 200000, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      ],
    },
  },
] as unknown as ProviderView[];

const modes: PluginEngineView['permissionModes'] = [
  { id: 'ask', displayName: 'Ask' },
  { id: 'bypassPermissions', displayName: 'Allow all' },
];

/** 64px DeepSeek mark, as the DSH plugin ships it (manifest `icon`). */
const DSH_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAE3UlEQVR4nOyaXVLbMBDHVw73qDkJ5h1megPCWwd6h8IdCtO3hBt0Bt7jnqTqPYjVXdlKFFvfVhIY5zfT4nzYsf7aXe2uXMDEKWDinASAiXMSACbOSQCYOCcBYOJ8KgGu79eLr99ECRk5gyNwfSfm8oA1F/KvKP68PrOl65yru/UPPGH+XjQcXz5CJg4mgBw0Ezd4WOGIu3dZ96eh/5eu8xljVff3Aa3g5fcvxiEDDBJpB0Qz2N4YUva+UmvHle06QoiHt+eZd0av7xuhn3PWFFlEiBLg6ruomGhuyBQhE69PhfceyO/XM/G393YNgr34XEenvX+xwvNu1XnBQRBnYCVPzjh4YkRQq9ClFqGBkWJIe//kgM0X9b43BnSqLWBo4lnAoEZxwekCZOo4AZZP2Ryto8SDS/XOIMi2blpuzoDi3/bYwcZk9o5YztbFo8unUQBygdL2+WzNzt/PoMT7xdXCHnPUd9VvWV2AzOowgyfkLK7cpixqxwWAzu/utwI3XBfaKIAl6Oyb0ikC5gq+8yEAXEGW+mujAJ1fHgMp/MaHNbqozWEcvL/kDgSQpo/JBhwTiu4GEdB3KdBxSEQwdtt/byAAzsACPgIGEaTvCkYzyCEWXPvffrJ68DP6iyP5vhstaVFELs2cZt40eGLHAo7o+3YMlkCD6QezIfg5ifdUnNsGT+wkQuj7c3DDYU8JkRMUATO5LyH5P872pWvAg0urg6H5i+Xr02wQNMj8oGkuuuqshMMKssn/9eJIJ6S20NlYQJtFbT8QwhxoOnXpn1xOOn/0Zl9+yKRZCW5RKf+vcPC2QM0hko0AWJKXekhkLGxmlSBjaobWbItavaYCJ7Ho4hDJJgjqFVILKyECEoICDgWe2BshC6JAp7JAcj2q+SESPKeGSFzlcAkJkH8mJCwldYsoBikRKGOLFqHwpsvDU9SBXiKqm0qt1SlSS2sA31KlEDWKJgPuutjGki5t5WHXwDQ3Ivor9toVDjdlWQ0aEzBT+mqBQwLbGFAML5AjMYo15X4samfVb0kp/k84LYASoxx9+BhTNv6mvxSGkMaq8ff0F8auiyEXT8XX1elB6W7dLsfuJTG0s2yiZwEGM2p7+VmIXB2qtiz35wOUIkMiuwKYTa3KtR1Fq4O/iImGj9kf2BHA1nXJWSVGLm1eIlYJI4YgOHQDMkVThyaVsZ2dLWKZsvbrDASg9jSYbg5L0g/mCtxUrcYyEKD1J/Oa6m9dh5OU6mrkiiXGPMBqBbiEhcQDcheq12k7TfYPLIyIB3XqstfHKIDLRCke0D5boCXInSUSwvb9hHhAdcYlZMKaCbpMlESg7rFtUIbVpLL1+6XYLLyEHhv1+zhTYY+J0qCsJm60IMturmxyhonAqXGT8zEZbzXoMVG5f2h0CWttbt4HDBSB+gYLaU2ZnhcKbiAG5vE1zj3vLj33fNf4pEdCa032ElKzwagOKgUzGN38HMCh3bzYRPW2Pxm+Q6Vvd8cSJQAhn7Ro9w9K2CtiKVjx0j2SU3Vvlr0vya2yMdVqtABEt4ewgj2JYNvc0H3+6E+JEfn2BBT+J0VyM0oAhfb0WAXxViHNeNZAfciBK7II0Ge7faaLwUq1QtCuE3WhjzVonb0I8Jk4PS0OE+ckAEyckwAwcU4CwMSZvAD/AQAA//953294AAAABklEQVQDACFExP9b63vuAAAAAElFTkSuQmCC';

const engines: PluginEngineView[] = [
  {
    key: 'dsh-plugin:dsh',
    providerId: 'acp-plugin:dsh-plugin:dsh',
    ghostId: 'dsh-plugin',
    harnessId: 'dsh',
    name: 'DeepSeek Harness',
    iconDataUrl: DSH_ICON,
    availability: { state: 'available', version: '0.2.2' },
    models: [],
    permissionModes: modes,
  },
  {
    key: 'opencode-plugin:opencode',
    providerId: 'acp-plugin:opencode-plugin:opencode',
    ghostId: 'opencode-plugin',
    harnessId: 'opencode',
    name: 'OpenCode',
    availability: { state: 'unknown' },
    models: [
      // Reasoning levels as an engine plugin publishes them (DSH: low / high / max, default high).
      { id: 'oc-large', displayName: 'OpenCode Large', description: 'Reported by the engine on its last run',
        efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      { id: 'oc-small', displayName: 'OpenCode Small' },
    ],
    permissionModes: modes,
  },
  {
    key: 'gemini-plugin:gemini',
    providerId: 'acp-plugin:gemini-plugin:gemini',
    ghostId: 'gemini-plugin',
    harnessId: 'gemini',
    name: 'Gemini CLI',
    availability: {
      state: 'unavailable',
      reason: 'not-installed',
      message: 'Gemini CLI is not installed. Run npm i -g @google/gemini-cli (Node 20+), then open the picker again.',
    },
    models: [],
    permissionModes: modes,
  },
];

function DraftPicker({ selected }: { selected: boolean }) {
  const [active, setActive] = useState<PluginEngineSelection | null>(
    selected ? { providerId: engines[1]!.providerId, modelId: 'oc-large', effort: 'max' } : null,
  );
  return (
    <main className="mx-auto w-full max-w-[720px] p-3">
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-2">
        <ModelSelectorContent
          providersOverride={providers}
          providersOverrideState={{ status: 'ready', refresh: () => {} }}
          modelId="claude-opus-5"
          effort="medium"
          currentProviderId="anthropic"
          onModelChange={() => {}}
          onEffortChange={() => {}}
          onUnifiedSelect={() => {}}
          pluginEngines={{ engines, active, onSelect: setActive }}
          remoteAgent={undefined}
        />
      </div>
    </main>
  );
}

function TaskTrigger({ engineGone }: { engineGone: boolean }) {
  const engine = engineGone ? null : engines[1]!;
  return (
    <main className="flex w-full justify-end p-3 pt-[360px]">
      <ModelSelector
        modelId="oc-large"
        effort="medium"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        actualRoute
        remoteAgent={undefined}
        pluginEngineSession={{
          providerId: engines[1]!.providerId,
          engine,
          engineName: engine?.name ?? 'Plugin engine',
          modelId: 'oc-large',
          effort: 'max',
          onSelectModel: async () => true,
        }}
      />
    </main>
  );
}

void mountPage({
  host: {
    maker: {
      getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
      onProvidersChanged: subscription('providersChanged'),
      getCapabilities: async () => ({
        hasFastMode: false,
        availableModels: [],
        effortLevels: [],
        permissionModes: [{ id: 'default', displayName: 'Default' }],
      }),
    },
  },
  render: (ctx) =>
    ctx.case.startsWith('task')
      ? <TaskTrigger engineGone={ctx.case === 'task-engine-gone'} />
      : <DraftPicker selected={ctx.case === 'draft-selected' || ctx.case === 'effort-config'} />,
});
