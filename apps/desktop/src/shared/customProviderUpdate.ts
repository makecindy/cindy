export type CodexImageGenerationRestartPolicy = 'interrupt';

export interface CustomProviderUpdateOptions {
  source?: 'manual-settings';
  codexImageGenerationRestartPolicy?: CodexImageGenerationRestartPolicy;
}

export type CustomProviderUpdateResult =
  | { ok: true }
  | {
      ok: false;
      confirmationRequired: 'codex-image-generation-reload';
      busyCount: number;
    };
