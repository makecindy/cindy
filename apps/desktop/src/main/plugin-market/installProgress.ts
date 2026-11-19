/**
 * Progress for one user-started market install or update, reported to the window that asked.
 *
 * Display only. It never gates, retries or reorders the install transaction, and a failing
 * listener cannot fail an install.
 * Shape and phases: shared/downloadProgress.ts; rules: docs/dev-rules/verified-downloads.md.
 */
import type { DownloadProgress } from '../../shared/downloadProgress.js';
import type { PluginMarketInstallProgress } from '../../shared/pluginMarket.js';
import type { GhostInstallConsentPrompt } from '../cindy-brain/ghostInstallConsent.js';
import { createDownloadProgressReporter, type DownloadOptions } from '../downloader/index.js';

export interface PluginInstallProgress {
  /** Spread into the verified package download. */
  readonly callbacks: Pick<DownloadOptions, 'onProgress' | 'onRetry' | 'onVerifying'>;
  /** The package size, known once the release is resolved, so the amount shown is exact. */
  expect(totalBytes: number): void;
  /** The same prompt, reported as waiting for the user while it is open. */
  consentPrompt(prompt: GhostInstallConsentPrompt): GhostInstallConsentPrompt;
  /** The verified package is about to replace or create the installation. */
  installing(): void;
  settle(outcome: 'completed' | 'failed' | 'cancelled'): void;
}

export function createPluginInstallProgress(
  pluginId: string,
  emit: (progress: PluginMarketInstallProgress) => void,
): PluginInstallProgress {
  let awaitingConsent = false;
  const send = (download: DownloadProgress) => {
    try {
      emit({ pluginId, download, ...(awaitingConsent ? { awaitingConsent: true } : {}) });
    } catch {
      /* Display only: a listener error must not fail the install. */
    }
  };
  const reporter = createDownloadProgressReporter({ emit: send });
  const setAwaitingConsent = (next: boolean) => {
    awaitingConsent = next;
    send(reporter.snapshot());
  };
  return {
    callbacks: reporter.callbacks,
    expect: (totalBytes) => reporter.reset('preparing', totalBytes),
    consentPrompt(prompt) {
      const reported: GhostInstallConsentPrompt = async (request) => {
        setAwaitingConsent(true);
        try {
          return await prompt(request);
        } finally {
          setAwaitingConsent(false);
        }
      };
      // The negotiated capability flag travels with the prompt; keep it exactly as given.
      if (prompt.uiCapabilityApproval !== undefined) {
        reported.uiCapabilityApproval = prompt.uiCapabilityApproval;
      }
      return reported;
    },
    installing: () => reporter.setPhase('installing'),
    settle: (outcome) => reporter.setPhase(outcome),
  };
}
