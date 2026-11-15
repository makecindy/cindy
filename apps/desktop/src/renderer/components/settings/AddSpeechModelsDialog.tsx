import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import type { ProviderRuntimeModelConfig, ProviderView } from '@cindy/model-providers';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useDialogExit } from '@/hooks/useDialogExit';
import {
  providerViewToCustomProviderConfig,
  readCustomProviderKey,
  updateCustomProvider,
} from '@/lib/customProviders';
import { toast } from '@/lib/toast';
import {
  providerSpeechSetup,
  speechReferenceModels,
  isSpeechModel,
} from '../../../shared/speechProviderSetup';
import { SpeechModelChoices, type SpeechModelChoice } from './SpeechModelChoices';

type Choice = SpeechModelChoice & { model: ProviderRuntimeModelConfig };

/** Additions-only: Main merges into the latest config under its existing provider queue. */
export function AddSpeechModelsDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider: ProviderView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useDialogExit();
  // Keep one connection snapshot for this dialog; a late provider refresh cannot reset choices.
  const [config] = useState(() => providerViewToCustomProviderConfig(provider));
  const [target] = useState(() => providerSpeechSetup(provider));
  const [choices, setChoices] = useState<Choice[]>(() => {
    if (!target) return [];
    const saved = new Map(
      Object.values(config.runtimes).flatMap(
        (runtime) => runtime?.models.map((model) => [model.id, model] as const) ?? [],
      ),
    );
    const references = speechReferenceModels(config.runtimes[target.agent]?.baseUrl ?? '').map(
      (model) => ({
        id: model.id,
        name: saved.get(model.id)?.name ?? model.name,
        checked: !saved.has(model.id) && model.defaultEnabled !== false,
        recommended: model.defaultEnabled !== false,
        reference: true,
        saved: saved.has(model.id),
        model,
      }),
    );
    const ids = new Set(references.map((model) => model.id));
    return [
      ...references,
      ...[...saved.values()]
        .filter((model) => isSpeechModel(model) && !ids.has(model.id))
        .map((model) => ({
          id: model.id,
          name: model.name,
          checked: false,
          recommended: false,
          saved: true,
          model,
        })),
    ];
  });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    void (async () => {
      if (!target) return;
      const runtime = config.runtimes[target.agent];
      if (!runtime) return;
      try {
        const apiKey = await readCustomProviderKey(config.id, target.agent);
        if (cancelled) return;
        const result = await window.electronAPI.maker.fetchProviderModels({
          savedProviderId: config.id,
          agent: target.agent,
          authMethod: 'apiKey',
          baseUrl: runtime.baseUrl,
          wireProtocol: runtime.wireProtocol,
          modelsUrl: runtime.modelsUrl,
          apiKey,
        });
        if (cancelled) return;
        setFailed(!result.ok);
        if (result.ok)
          setChoices((previous) => {
            const next = new Map(previous.map((choice) => [choice.id, choice]));
            const saved = new Set(
              Object.values(config.runtimes).flatMap(
                (value) => value?.models.map((model) => model.id) ?? [],
              ),
            );
            for (const model of result.models ?? []) {
              const old = next.get(model.id);
              if (!isSpeechModel(model)) {
                // An explicit non-TTS capability beats an offline reference. Saved membership stays intact.
                if (old?.reference && model.discoveredMetadata?.mode && !old.saved)
                  next.delete(model.id);
                continue;
              }
              next.set(model.id, {
                id: model.id,
                name: old?.saved ? old.name : model.name,
                checked: old?.checked ?? false,
                recommended: old?.recommended ?? false,
                saved: saved.has(model.id),
                reference: false,
                model: {
                  id: model.id,
                  name: model.name,
                  discoveredMetadata: model.discoveredMetadata,
                },
              });
            }
            return [...next.values()];
          });
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [config, target]);
  const selected = choices.filter((choice) => choice.checked && !choice.saved);
  const close = () => {
    if (!savingRef.current) dialog.close(onClose);
  };
  const save = async () => {
    if (savingRef.current || !target || selected.length === 0) return;
    const runtime = config.runtimes[target.agent];
    if (!runtime) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await updateCustomProvider(
        {
          ...config,
          runtimes: {
            [target.agent]: {
              ...runtime,
              models: selected.map((choice) => ({ ...choice.model, defaultEnabled: true })),
            },
          },
        },
        {},
        { appendSpeechModelsOnly: true },
      );
      if (!mounted.current) return;
      if (!result.ok) {
        toast.error(t('settings.providers.speechSetup.saveFailed'));
        return;
      }
      dialog.close(onSaved);
    } catch {
      if (mounted.current) toast.error(t('settings.providers.speechSetup.saveFailed'));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return (
    <Dialog.Root
      open={dialog.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={dialog.onOpenAutoFocus}
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault();
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={dialog.onCloseAutoFocus}
          className="modal-panel fixed left-1/2 top-1/2 z-[10001] flex max-h-[85vh] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col text-[var(--text-primary)]"
        >
          <div className="p-5">
            <Dialog.Title className="text-16 font-medium">
              {t('settings.providers.speechSetup.add')}
            </Dialog.Title>
            <p className="mt-1 text-12 text-[var(--text-secondary)]">{provider.name}</p>
          </div>
          <div className="flex flex-col gap-3 overflow-y-auto border-y border-[var(--border-default)] p-5">
            {loading ? (
              <div role="status" className="flex items-center gap-2 text-12">
                <Spinner size={14} />
                {t('settings.providers.wizard.fetching')}
              </div>
            ) : (
              <>
                {failed && (
                  <p className="text-12 text-[var(--text-secondary)]">
                    {t('settings.providers.speechSetup.fetchFailed')}
                  </p>
                )}
                <SpeechModelChoices
                  choices={choices}
                  loading={saving}
                  onToggle={(id) =>
                    setChoices((previous) =>
                      previous.map((choice) =>
                        choice.id === id ? { ...choice, checked: !choice.checked } : choice,
                      ),
                    )
                  }
                  onAdd={(id) =>
                    setChoices((previous) => {
                      const old = previous.find((choice) => choice.id === id);
                      if (old?.saved) return previous;
                      const existing = Object.values(config.runtimes).some((runtime) =>
                        runtime?.models.some((model) => model.id === id),
                      );
                      if (existing) return previous;
                      const choice: Choice = {
                        id,
                        name: old?.name ?? id,
                        checked: true,
                        recommended: old?.recommended ?? false,
                        manual: true,
                        model: { id, name: old?.name ?? id, mode: 'audio_speech' },
                      };
                      return old
                        ? previous.map((value) => (value.id === id ? choice : value))
                        : [...previous, choice];
                    })
                  }
                />
              </>
            )}
          </div>
          <div className="flex justify-end gap-2 p-4">
            <Button variant="secondary" size="lg" disabled={saving} onClick={close}>
              {t('settings.providers.wizard.cancel')}
            </Button>
            <Button
              variant="cta"
              size="lg"
              loading={saving}
              disabled={loading || saving || selected.length === 0}
              onClick={() => void save()}
            >
              {t('settings.providers.wizard.addManualModel')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
