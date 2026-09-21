import { useCallback, useEffect, useState } from 'react';
import type { VoiceInputTerminalOutcome as VoiceInputUsageOutcome } from '@cindy/voice-input-core';
import {
  DEFAULT_VOICE_INPUT_PROVIDER_KIND,
  estimateVoiceInputAsrCostUsd,
  isVoiceInputProviderKind,
  type VoiceInputProviderKind,
} from '../../shared/voiceInputAsrProfiles';
import {
  DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND,
  estimateVoiceInputRefinerCostUsd,
  getVoiceInputRefinerProfile,
  isVoiceInputRefinerProviderKind,
  type VoiceInputRefinerProviderKind,
} from '../../shared/voiceInputRefinerProfiles';

export interface VoiceInputUsageStats {
  totalAudioMs: number;
  asrAudioMsByProvider: Partial<Record<VoiceInputProviderKind, number>>;
  sessionCount: number;
  noSpeechSessionCount: number;
  failedSessionCount: number;
  lastRecordedAt: number | null;
  refinementPromptTokens: number;
  refinementCachedTokens: number;
  refinementCompletionTokens: number;
  refinementTokensByProvider: Partial<Record<VoiceInputRefinerProviderKind, VoiceInputRefinementTokenDelta>>;
  refinementCount: number;
}

export interface VoiceInputCostBreakdown {
  asrUsd: number;
  refineUsd: number;
  totalUsd: number;
}

export interface VoiceInputRefinementTokenDelta {
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  refinerProvider?: string;
}

export type { VoiceInputUsageOutcome };

const STORAGE_KEY = 'voiceInput.usageStats.v1';
const CHANGE_EVENT = 'voice-input-usage-stats-change';

const DEFAULT_STATS: VoiceInputUsageStats = {
  totalAudioMs: 0,
  asrAudioMsByProvider: {},
  sessionCount: 0,
  noSpeechSessionCount: 0,
  failedSessionCount: 0,
  lastRecordedAt: null,
  refinementPromptTokens: 0,
  refinementCachedTokens: 0,
  refinementCompletionTokens: 0,
  refinementTokensByProvider: {},
  refinementCount: 0,
};

function readNonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeStats(raw: unknown): VoiceInputUsageStats {
  if (!raw || typeof raw !== 'object') return DEFAULT_STATS;
  const candidate = raw as Partial<VoiceInputUsageStats>;
  const lastRecordedAt = Number(candidate.lastRecordedAt);
  const asrAudioMsByProvider: Partial<Record<VoiceInputProviderKind, number>> = {};
  if (candidate.asrAudioMsByProvider && typeof candidate.asrAudioMsByProvider === 'object') {
    for (const [provider, audioMs] of Object.entries(candidate.asrAudioMsByProvider)) {
      if (!isVoiceInputProviderKind(provider)) continue;
      const normalizedAudioMs = readNonNegative(audioMs);
      if (normalizedAudioMs > 0) asrAudioMsByProvider[provider] = normalizedAudioMs;
    }
  }
  const refinementTokensByProvider: Partial<Record<VoiceInputRefinerProviderKind, VoiceInputRefinementTokenDelta>> = {};
  if (candidate.refinementTokensByProvider && typeof candidate.refinementTokensByProvider === 'object') {
    for (const [provider, usage] of Object.entries(candidate.refinementTokensByProvider)) {
      if (!isVoiceInputRefinerProviderKind(provider) || !usage || typeof usage !== 'object') continue;
      const normalizedUsage = {
        promptTokens: Math.floor(readNonNegative((usage as VoiceInputRefinementTokenDelta).promptTokens)),
        cachedTokens: Math.floor(readNonNegative((usage as VoiceInputRefinementTokenDelta).cachedTokens)),
        completionTokens: Math.floor(readNonNegative((usage as VoiceInputRefinementTokenDelta).completionTokens)),
      };
      if (
        normalizedUsage.promptTokens > 0
        || normalizedUsage.cachedTokens > 0
        || normalizedUsage.completionTokens > 0
      ) {
        refinementTokensByProvider[provider] = normalizedUsage;
      }
    }
  }
  return {
    totalAudioMs: readNonNegative(candidate.totalAudioMs),
    asrAudioMsByProvider,
    sessionCount: Math.floor(readNonNegative(candidate.sessionCount)),
    noSpeechSessionCount: Math.floor(readNonNegative(candidate.noSpeechSessionCount)),
    failedSessionCount: Math.floor(readNonNegative(candidate.failedSessionCount)),
    lastRecordedAt: Number.isFinite(lastRecordedAt) && lastRecordedAt > 0 ? lastRecordedAt : null,
    refinementPromptTokens: Math.floor(readNonNegative(candidate.refinementPromptTokens)),
    refinementCachedTokens: Math.floor(readNonNegative(candidate.refinementCachedTokens)),
    refinementCompletionTokens: Math.floor(readNonNegative(candidate.refinementCompletionTokens)),
    refinementTokensByProvider,
    refinementCount: Math.floor(readNonNegative(candidate.refinementCount)),
  };
}

export function getVoiceInputUsageStats(): VoiceInputUsageStats {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATS;
    return normalizeStats(JSON.parse(raw));
  } catch {
    return DEFAULT_STATS;
  }
}

function writeVoiceInputUsageStats(next: VoiceInputUsageStats): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Keep in-memory updates working even if localStorage is unavailable.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function getCurrentVoiceInputProviderKind(): VoiceInputProviderKind {
  try {
    const provider = window.electronAPI?.voiceInput?.getReadinessCached?.()?.provider;
    return provider && isVoiceInputProviderKind(provider)
      ? provider
      : DEFAULT_VOICE_INPUT_PROVIDER_KIND;
  } catch {
    return DEFAULT_VOICE_INPUT_PROVIDER_KIND;
  }
}

function estimateAsrUsd(stats: Pick<VoiceInputUsageStats, 'totalAudioMs' | 'asrAudioMsByProvider'>): number {
  let hasProviderBreakdown = false;
  let totalUsd = 0;
  let accountedAudioMs = 0;
  for (const [provider, audioMs] of Object.entries(stats.asrAudioMsByProvider)) {
    if (!isVoiceInputProviderKind(provider)) continue;
    const normalizedAudioMs = readNonNegative(audioMs);
    if (normalizedAudioMs <= 0) continue;
    hasProviderBreakdown = true;
    totalUsd += estimateVoiceInputAsrCostUsd(provider, normalizedAudioMs);
    accountedAudioMs += normalizedAudioMs;
  }
  if (hasProviderBreakdown) {
    const unbucketedAudioMs = Math.max(0, readNonNegative(stats.totalAudioMs) - accountedAudioMs);
    return totalUsd + estimateVoiceInputAsrCostUsd(DEFAULT_VOICE_INPUT_PROVIDER_KIND, unbucketedAudioMs);
  }
  return estimateVoiceInputAsrCostUsd(DEFAULT_VOICE_INPUT_PROVIDER_KIND, stats.totalAudioMs);
}

function addTokenUsage(a: VoiceInputRefinementTokenDelta, b: VoiceInputRefinementTokenDelta): VoiceInputRefinementTokenDelta {
  return {
    promptTokens: readNonNegative(a.promptTokens) + readNonNegative(b.promptTokens),
    cachedTokens: readNonNegative(a.cachedTokens) + readNonNegative(b.cachedTokens),
    completionTokens: readNonNegative(a.completionTokens) + readNonNegative(b.completionTokens),
  };
}

function subtractTokenUsage(a: VoiceInputRefinementTokenDelta, b: VoiceInputRefinementTokenDelta): VoiceInputRefinementTokenDelta {
  return {
    promptTokens: Math.max(0, readNonNegative(a.promptTokens) - readNonNegative(b.promptTokens)),
    cachedTokens: Math.max(0, readNonNegative(a.cachedTokens) - readNonNegative(b.cachedTokens)),
    completionTokens: Math.max(0, readNonNegative(a.completionTokens) - readNonNegative(b.completionTokens)),
  };
}

function estimateRefineUsd(
  stats: Pick<
    VoiceInputUsageStats,
    'refinementPromptTokens'
    | 'refinementCachedTokens'
    | 'refinementCompletionTokens'
    | 'refinementTokensByProvider'
  >,
): number {
  const aggregateUsage = {
    promptTokens: stats.refinementPromptTokens,
    cachedTokens: stats.refinementCachedTokens,
    completionTokens: stats.refinementCompletionTokens,
  };
  let accountedUsage: VoiceInputRefinementTokenDelta = {};
  let totalUsd = 0;
  for (const [provider, usage] of Object.entries(stats.refinementTokensByProvider)) {
    if (!usage || !isVoiceInputRefinerProviderKind(provider)) continue;
    totalUsd += estimateVoiceInputRefinerCostUsd(getVoiceInputRefinerProfile(provider), usage);
    accountedUsage = addTokenUsage(accountedUsage, usage);
  }
  const legacyUnbucketedUsage = subtractTokenUsage(aggregateUsage, accountedUsage);
  return totalUsd + estimateVoiceInputRefinerCostUsd(
    getVoiceInputRefinerProfile(DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND),
    legacyUnbucketedUsage,
  );
}

export function estimateVoiceInputCostBreakdown(stats: VoiceInputUsageStats): VoiceInputCostBreakdown {
  const asrUsd = estimateAsrUsd(stats);
  const refineUsd = estimateRefineUsd(stats);
  return {
    asrUsd,
    refineUsd,
    totalUsd: asrUsd + refineUsd,
  };
}

export function recordVoiceInputUsage(
  audioMs: number,
  outcome: VoiceInputUsageOutcome = 'success',
): void {
  if (!Number.isFinite(audioMs) || audioMs <= 0) return;
  const current = getVoiceInputUsageStats();
  const provider = getCurrentVoiceInputProviderKind();
  writeVoiceInputUsageStats({
    ...current,
    totalAudioMs: current.totalAudioMs + audioMs,
    asrAudioMsByProvider: {
      ...current.asrAudioMsByProvider,
      [provider]: (current.asrAudioMsByProvider[provider] ?? 0) + audioMs,
    },
    sessionCount: current.sessionCount + 1,
    noSpeechSessionCount: current.noSpeechSessionCount + (outcome === 'no_speech' ? 1 : 0),
    failedSessionCount: current.failedSessionCount + (outcome === 'failed' ? 1 : 0),
    lastRecordedAt: Date.now(),
  });
}

export function recordVoiceInputRefinementUsage(delta: VoiceInputRefinementTokenDelta): void {
  const promptTokens = readNonNegative(delta.promptTokens);
  const cachedTokens = readNonNegative(delta.cachedTokens);
  const completionTokens = readNonNegative(delta.completionTokens);
  if (promptTokens === 0 && cachedTokens === 0 && completionTokens === 0) return;
  const current = getVoiceInputUsageStats();
  const refinerProvider = delta.refinerProvider && isVoiceInputRefinerProviderKind(delta.refinerProvider)
    ? delta.refinerProvider
    : DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND;
  const previousProviderUsage = current.refinementTokensByProvider[refinerProvider] ?? {};
  const providerUsage = addTokenUsage(previousProviderUsage, { promptTokens, cachedTokens, completionTokens });
  writeVoiceInputUsageStats({
    ...current,
    refinementPromptTokens: current.refinementPromptTokens + promptTokens,
    refinementCachedTokens: current.refinementCachedTokens + cachedTokens,
    refinementCompletionTokens: current.refinementCompletionTokens + completionTokens,
    refinementTokensByProvider: {
      ...current.refinementTokensByProvider,
      [refinerProvider]: providerUsage,
    },
    refinementCount: current.refinementCount + 1,
  });
}

export function resetVoiceInputUsageStats(): void {
  writeVoiceInputUsageStats(DEFAULT_STATS);
}

export function useVoiceInputUsageStats(): {
  stats: VoiceInputUsageStats;
  cost: VoiceInputCostBreakdown;
  reset: () => void;
} {
  const [stats, setStats] = useState<VoiceInputUsageStats>(getVoiceInputUsageStats);

  const syncFromStorage = useCallback(() => {
    setStats(getVoiceInputUsageStats());
  }, []);

  const reset = useCallback(() => {
    resetVoiceInputUsageStats();
    setStats(DEFAULT_STATS);
  }, []);

  useEffect(() => {
    const storageHandler = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      syncFromStorage();
    };
    window.addEventListener('storage', storageHandler);
    window.addEventListener(CHANGE_EVENT, syncFromStorage);
    return () => {
      window.removeEventListener('storage', storageHandler);
      window.removeEventListener(CHANGE_EVENT, syncFromStorage);
    };
  }, [syncFromStorage]);

  return {
    stats,
    cost: estimateVoiceInputCostBreakdown(stats),
    reset,
  };
}
