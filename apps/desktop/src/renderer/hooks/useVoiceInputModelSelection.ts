import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

const log = createLogger('voice-input-model-selection');

type ModelSelectionResult = VoiceInputModelSelectionResultData;
type ModelSelectionPatch = Parameters<typeof window.electronAPI.voiceInput.setModelSelection>[0];

/**
 * Voice service source + model selection state (settings "服务来源" card).
 *
 * Wraps the `voice-input:model-selection:get|set` IPC pair. The selection is
 * persisted in the main-owned `voice-input-models.json` with sparse override
 * semantics: writing `null` for a field clears the user override so the value
 * re-follows the current product default (see configuration design
 * principles — reset never snapshots defaults).
 */
export function useVoiceInputModelSelection(): {
  ready: boolean;
  selection: ModelSelectionResult['selection'] | null;
  asrProfiles: ModelSelectionResult['asrProfiles'];
  refinerProfiles: ModelSelectionResult['refinerProfiles'];
  readiness: ModelSelectionResult['readiness'] | null;
  customAsrApiKeyConfigured: boolean;
  saving: boolean;
  setServiceMode: (mode: VoiceInputServiceModeData) => Promise<void>;
  setAsrProvider: (provider: string) => Promise<void>;
  setRefinerProvider: (provider: string) => Promise<void>;
  setRefinerFallbackProvider: (provider: string) => Promise<void>;
  saveCustomAsr: (config: {
    protocol: 'openai-realtime' | 'qwen-realtime';
    websocketUrl: string;
    model: string;
  }, apiKey?: string) => Promise<boolean>;
  clearCustomAsrApiKey: () => Promise<void>;
  resetToDefault: () => Promise<void>;
  refresh: () => Promise<void>;
} {
  const { t } = useTranslation();
  const [result, setResult] = useState<ModelSelectionResult | null>(null);
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await window.electronAPI.voiceInput.getModelSelection();
      if (mountedRef.current) setResult(next);
    } catch (error) {
      log.warn('voice input model selection load failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyPatch = useCallback(async (patch: ModelSelectionPatch) => {
    setSaving(true);
    try {
      const next = await window.electronAPI.voiceInput.setModelSelection(patch);
      if (mountedRef.current) setResult(next);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('voice input model selection save failed', { message });
      toast.error(t('settings.voiceInput.saveFailed', { message }));
      // Re-sync so the UI never renders an optimistic value main rejected.
      await refresh();
      return false;
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [refresh, t]);

  const setServiceMode = useCallback(async (mode: VoiceInputServiceModeData) => {
    // The default mode is 'cindy': selecting it clears the override so the
    // user keeps following future product defaults; only 'byok' is persisted
    // as an explicit customization.
    await applyPatch({ serviceMode: mode === 'byok' ? 'byok' : null });
  }, [applyPatch]);

  const setAsrProvider = useCallback(async (provider: string) => {
    await applyPatch({ asrProvider: provider || null });
  }, [applyPatch]);

  const setRefinerProvider = useCallback(async (provider: string) => {
    await applyPatch({ refinerProvider: provider || null });
  }, [applyPatch]);

  // BYOK fallback is explicit opt-in: an empty selection clears the override
  // so the primary refiner runs alone (the product default).
  const setRefinerFallbackProvider = useCallback(async (provider: string) => {
    await applyPatch({ refinerProviderChain: provider ? [provider] : null });
  }, [applyPatch]);

  const saveCustomAsr = useCallback(async (
    config: {
      protocol: 'openai-realtime' | 'qwen-realtime';
      websocketUrl: string;
      model: string;
    },
    apiKey?: string,
  ) => {
    return applyPatch({
      customAsr: config,
      ...(apiKey?.trim() ? { customAsrApiKey: apiKey } : {}),
    });
  }, [applyPatch]);

  const clearCustomAsrApiKey = useCallback(async () => {
    await applyPatch({ customAsrApiKey: null });
  }, [applyPatch]);

  const resetToDefault = useCallback(async () => {
    await applyPatch({
      serviceMode: null,
      asrProvider: null,
      customAsr: null,
      customAsrApiKey: null,
      refinerProvider: null,
      refinerModel: null,
      refinerProviderChain: null,
    });
  }, [applyPatch]);

  return {
    ready: result !== null,
    selection: result?.selection ?? null,
    asrProfiles: result?.asrProfiles ?? [],
    refinerProfiles: result?.refinerProfiles ?? [],
    readiness: result?.readiness ?? null,
    customAsrApiKeyConfigured: result?.customAsrApiKeyConfigured ?? false,
    saving,
    setServiceMode,
    setAsrProvider,
    setRefinerProvider,
    setRefinerFallbackProvider,
    saveCustomAsr,
    clearCustomAsrApiKey,
    resetToDefault,
    refresh,
  };
}
