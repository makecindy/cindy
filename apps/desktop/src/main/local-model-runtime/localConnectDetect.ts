import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  LITELLM_OPENAI_BASE_URL,
  LLAMACPP_OPENAI_BASE_URL,
  LMSTUDIO_OPENAI_BASE_URL,
  LOCAL_ADVANCED_PRESET_IDS,
  LOCAL_CONNECT_PRESET_IDS,
  VLLM_OPENAI_BASE_URL,
} from '../../shared/localModelRuntime.js';

const PROBE_TIMEOUT_MS = 400;

export const LOCAL_PRESET_MODELS_URLS: Record<string, string> = {
  lmstudio: `${LMSTUDIO_OPENAI_BASE_URL}/models`,
  llamacpp: `${LLAMACPP_OPENAI_BASE_URL}/models`,
  vllm: `${VLLM_OPENAI_BASE_URL}/models`,
  litellm: `${LITELLM_OPENAI_BASE_URL}/models`,
};

export function lmStudioInstallPaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin') return ['/Applications/LM Studio.app'];
  if (platform === 'win32' && env.LOCALAPPDATA) {
    return [path.join(env.LOCALAPPDATA, 'Programs', 'LM Studio', 'LM Studio.exe')];
  }
  return [];
}

export async function defaultProbeOpenAiModels(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      return false;
    }
    if (!response.ok) return false;
    const body = (await response.json()) as { data?: unknown };
    return Array.isArray(body.data);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function detectLocalConnectPresets(opts: {
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  appExists?: (filePath: string) => boolean;
  probe?: (url: string) => Promise<boolean>;
}): Promise<string[]> {
  const appExists = opts.appExists ?? existsSync;
  const probe = opts.probe ?? defaultProbeOpenAiModels;
  const found = new Set<string>();

  if (lmStudioInstallPaths(opts.platform, opts.env ?? process.env).some((filePath) => appExists(filePath))) {
    found.add('lmstudio');
  }

  const ids = [...LOCAL_CONNECT_PRESET_IDS, ...LOCAL_ADVANCED_PRESET_IDS];
  await Promise.all(
    ids.map(async (id) => {
      const url = LOCAL_PRESET_MODELS_URLS[id];
      if (!url) return;
      if (await probe(url)) found.add(id);
    }),
  );
  return ids.filter((id) => found.has(id));
}
