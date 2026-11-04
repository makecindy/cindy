import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mountPage, subscription, forbid } from '../../ui-page/harness';
import {
  BUNDLED_CATALOG,
  buildUserProvider,
  type CustomProviderConfig,
  type ProviderView,
} from '@cindy/model-providers';
import {
  AddProviderWizard,
  type WizardEntry,
} from '../../../src/renderer/components/settings/AddProviderWizard';
import { AddSpeechModelsDialog } from '../../../src/renderer/components/settings/AddSpeechModelsDialog';
import { UnifiedModelList } from '../../../src/renderer/components/settings/UnifiedModelList';
import { Button } from '../../../src/renderer/components/ui/button';
import { appendSpeechModels, providerSpeechSetup } from '../../../src/shared/speechProviderSetup';
import { isModelEnabled, setModelVisibilityOwner, useModelVisibilityVersion } from '../../../src/renderer/state/modelVisibilityPrefs';

let stored: CustomProviderConfig = {
  id: 'minimax-personal',
  name: 'MiniMax · Personal',
  runtimes: {
    codex: {
      baseUrl: 'https://api.minimax.io/v1',
      wireProtocol: 'openai-chat',
      models: [{ id: 'MiniMax-M3', name: 'MiniMax M3' }],
    },
  },
};
function view(): ProviderView {
  const provider = buildUserProvider(stored, { modelRegistry: BUNDLED_CATALOG.modelRegistry });
  return { ...provider, connected: true, availableMediaModelIds: provider.audioModels?.map(model => model.id) ?? [] };
}
function VisibilityEvidence() {
  useModelVisibilityVersion();
  const model = stored.runtimes.codex!.models.find(model => model.id === 'speech-2.8-hd')!;
  return <output hidden data-testid="speech-visible">{String(isModelEnabled('codex', stored.id, model))}</output>;
}
function Fixture({ scenario }: { scenario: string }) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<ProviderView>(() =>
    scenario === 'subscription'
      ? {
          ...view(),
          auth: { method: 'oauth', native: 'codex' },
          id: 'openai',
          name: 'OpenAI',
          routing: {},
        }
      : view(),
  );
  const [wizard, setWizard] = useState<{ entry?: WizardEntry } | null>(null);
  const [speech, setSpeech] = useState(false);
  const [saved, setSaved] = useState(false);
  const [visibilityReady, setVisibilityReady] = useState(scenario !== 'speech-visibility');
  useEffect(() => {
    if (scenario === 'speech-visibility')
      void setModelVisibilityOwner('speech-fixture', 1, 'cloud').then(() => setVisibilityReady(true));
  }, [scenario]);
  const setup = providerSpeechSetup(provider);
  return (
    <main className="mx-auto flex max-w-[1040px] flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-20 font-medium text-[var(--text-primary)]">
          {t('settings.providers.title')}
        </h1>
        <Button variant="secondary" data-testid="add-provider" onClick={() => setWizard({})}>
          {t('settings.providers.wizard.title')}
        </Button>
      </div>
      <div className="overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--settings-theme-card-bg)]">
        <h2 className="p-5 text-16 text-[var(--text-primary)]">{provider.name}</h2>
        {visibilityReady && <UnifiedModelList
          provider={provider}
          focusModelId={scenario === 'speech-visibility' ? 'speech-2.8-hd' : undefined}
          onRefresh={forbid('manualRefresh: covered by ProvidersSection regression tests')}
          onAddSpeechModels={setup ? () => setSpeech(true) : undefined}
        />}
      </div>
      {scenario === 'speech-visibility' && visibilityReady && <VisibilityEvidence />}
      {saved && (
        <output data-testid="saved" className="text-12 text-[var(--text-secondary)]">
          {Object.values(stored.runtimes)
            .flatMap(
              (runtime) =>
                runtime?.models
                  .filter((model) => model.defaultEnabled !== false)
                  .map((model) => model.id) ?? [],
            )
            .join(', ')}
        </output>
      )}
      {wizard && (
        <AddProviderWizard
          providers={[provider]}
          entry={wizard.entry}
          onClose={() => setWizard(null)}
          onOpenCustomForm={forbid('customForm')}
          onDone={() => {
            setWizard(null);
            setProvider(view());
            setSaved(true);
          }}
        />
      )}
      {speech && (
        <AddSpeechModelsDialog
          provider={provider}
          onClose={() => setSpeech(false)}
          onSaved={() => {
            setSpeech(false);
            setProvider(view());
            setSaved(true);
          }}
        />
      )}
    </main>
  );
}
void mountPage({
  host: (ctx) => {
    if (ctx.case === 'empty') stored.runtimes.codex!.models = [];
    if (ctx.case === 'speech-visibility')
      stored.runtimes.codex!.models.push({ id: 'speech-2.8-hd', name: 'MiniMax Speech 2.8 HD', mode: 'audio_speech', defaultEnabled: false });
    if (ctx.case === 'token-plan-existing')
      stored = {
        id: 'bailian-plan', name: 'Alibaba Cloud · Token Plan', runtimes: {
          codex: { baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
            wireProtocol: 'openai-chat', models: [{ id: 'qwen-plus', name: 'Qwen Plus' }] },
        },
      };
    if (ctx.case === 'bailian-existing')
      stored = {
        id: 'bailian-workspace',
        name: 'Alibaba Cloud · Workspace',
        runtimes: {
          codex: {
            baseUrl: 'https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1',
            wireProtocol: 'openai-chat',
            models: [{ id: 'qwen-plus', name: 'Qwen Plus' }],
          },
        },
      };
    return {
      safeStorageRead: async () => 'fixture-key',
      maker: {
        claimLegacyModelVisibilityOwner: () => ({ dataOwnerId: 'speech-fixture', ownerGeneration: 1,
          canWriteOwnerScoped: true, claimed: true, claimedByOtherOwner: false,
          canInitialize: true, profileOrigin: 'new' }),
        syncModelVisibility: async () => undefined,
        listProviderPresets: async () => ({
          presets: ctx.case === 'bailian-fallback' ? [{
            id: 'bailian-empty', name: 'Fallback API', runtimes: {
              codex: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', models: [] },
            },
          }] : BUNDLED_CATALOG.presets!.filter((p) => p.id === (ctx.case === 'token-plan' ? 'aliyun-bailian-token-plan-cn' : 'minimax-global')),
        }),
        localModelList: async () => ({
          status: { runtime: 'ollama', kind: 'absent', appInstalled: false },
          models: [],
        }),
        scanLocalCli: async () => ({ detections: [] }),
        llamaCppStatus: async () => ({
          installed: false,
          supported: true,
          running: false,
          models: [],
        }),
        onProviderOAuthProgress: subscription('oauthProgress'),
        onProvidersChanged: subscription('providersChanged'),
        fetchProviderModels: async () =>
          ctx.case === 'elevenlabs'
            ? {
                ok: true,
                models: [
                  {
                    id: 'eleven_flash_v2_5',
                    name: 'Eleven Flash v2.5',
                    discoveredMetadata: { mode: 'audio_speech' },
                  },
                ],
              }
            : ctx.case === 'bailian'
              ? {
                  ok: true,
                  models: Array.from({ length: 100 }, (_, index) => ({
                    id: `chat-${index}`,
                    name: `Chat ${index}`,
                    mode: 'chat',
                  })),
                }
              : { ok: false, code: 'NETWORK' },
        createCustomProvider: async (config: CustomProviderConfig) => {
          stored = config;
          return { ok: true };
        },
        updateCustomProvider: async (
          config: CustomProviderConfig,
          _keys: unknown,
          options: { appendSpeechModelsOnly?: true },
        ) => {
          if (!options.appendSpeechModelsOnly) throw new Error('Expected additions only');
          stored = appendSpeechModels(stored, config);
          return { ok: true };
        },
        setModelDisable: forbid('setModelDisable'),
      },
    };
  },
  render: (ctx) => <Fixture scenario={ctx.case} />,
});
