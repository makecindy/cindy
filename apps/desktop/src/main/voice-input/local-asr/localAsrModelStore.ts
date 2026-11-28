import fs from 'node:fs';
import path from 'node:path';

import type { VoiceLocalAsrModelKind } from '../../../shared/voiceLocalAsr.js';
import type { LocalAsrModelSpec } from './localAsrWorkerProtocol.js';

type StoredLocalAsrConfig = {
  modelDir?: string;
};

type OptionalManifest = {
  kind?: VoiceLocalAsrModelKind;
};

const CONFIG_FILE_NAME = 'voice-local-asr.json';
const DEFAULT_MODELS_SUBDIR = path.join('voice-models', 'asr');

function pickPreferredOnnx(files: string[], matcher: (lower: string) => boolean): string | null {
  const candidates = files.filter((file) => {
    const lower = file.toLowerCase();
    return lower.endsWith('.onnx') && matcher(lower);
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const aInt8 = a.toLowerCase().includes('.int8.onnx') ? 0 : 1;
    const bInt8 = b.toLowerCase().includes('.int8.onnx') ? 0 : 1;
    if (aInt8 !== bInt8) return aInt8 - bInt8;
    return a.localeCompare(b);
  });
  return candidates[0] ?? null;
}

function pickTokensFile(files: string[]): string | null {
  const exact = files.find((file) => file.toLowerCase() === 'tokens.txt');
  if (exact) return exact;
  const suffix = files.find((file) => file.toLowerCase().endsWith('tokens.txt'));
  return suffix ?? null;
}

function readOptionalKindManifest(dirPath: string): VoiceLocalAsrModelKind | null {
  try {
    const raw = fs.readFileSync(path.join(dirPath, 'cindy-asr-model.json'), 'utf8');
    const parsed = JSON.parse(raw) as OptionalManifest;
    if (
      parsed.kind === 'sensevoice' ||
      parsed.kind === 'paraformer' ||
      parsed.kind === 'whisper' ||
      parsed.kind === 'transducer'
    ) {
      return parsed.kind;
    }
  } catch {
    // Optional manifest absent or malformed; fall back to file-layout heuristics.
  }
  return null;
}

function tokensLookLikeSenseVoice(tokensPath: string): boolean {
  try {
    const fd = fs.openSync(tokensPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const sample = buf.subarray(0, read).toString('utf8');
      return (
        sample.includes('<|zh|>') ||
        sample.includes('<|en|>') ||
        sample.includes('<|nospeech|>') ||
        sample.includes('<|NEUTRAL|>') ||
        sample.includes('<|Speech|>')
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function inspectSingleDirectory(dirPath: string): LocalAsrModelSpec | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const tokensFile = pickTokensFile(files);
  if (!tokensFile) return null;
  const tokens = path.join(dirPath, tokensFile);

  const explicitKind = readOptionalKindManifest(dirPath);
  const dirNameLower = path.basename(dirPath).toLowerCase();

  const encoderFile = pickPreferredOnnx(files, (lower) => lower.includes('encoder'));
  const decoderFile = pickPreferredOnnx(files, (lower) => lower.includes('decoder'));
  const joinerFile = pickPreferredOnnx(files, (lower) => lower.includes('joiner'));

  if (encoderFile && decoderFile && joinerFile) {
    return {
      kind: 'transducer',
      modelDir: dirPath,
      tokens,
      encoder: path.join(dirPath, encoderFile),
      decoder: path.join(dirPath, decoderFile),
      joiner: path.join(dirPath, joinerFile),
    };
  }

  if (encoderFile && decoderFile) {
    return {
      kind: 'whisper',
      modelDir: dirPath,
      tokens,
      encoder: path.join(dirPath, encoderFile),
      decoder: path.join(dirPath, decoderFile),
    };
  }

  const singleModelFile =
    pickPreferredOnnx(files, (lower) => lower === 'model.int8.onnx' || lower === 'model.onnx') ??
    pickPreferredOnnx(files, (lower) => lower.includes('sense') || lower.includes('paraformer')) ??
    pickPreferredOnnx(files, () => true);

  if (!singleModelFile) return null;
  const model = path.join(dirPath, singleModelFile);
  const fileLower = singleModelFile.toLowerCase();

  let kind: 'sensevoice' | 'paraformer';
  if (explicitKind === 'sensevoice' || explicitKind === 'paraformer') {
    kind = explicitKind;
  } else if (dirNameLower.includes('sense') || fileLower.includes('sense')) {
    kind = 'sensevoice';
  } else if (dirNameLower.includes('paraformer') || fileLower.includes('paraformer')) {
    kind = 'paraformer';
  } else if (tokensLookLikeSenseVoice(tokens)) {
    kind = 'sensevoice';
  } else {
    kind = 'paraformer';
  }

  return {
    kind,
    modelDir: dirPath,
    tokens,
    model,
  };
}

/**
 * Inspect a local directory for a supported sherpa-onnx offline ASR model layout
 * (SenseVoice, Paraformer, Whisper, or Transducer).
 *
 * Also checks one level deep when a user selects the parent folder of an extracted
 * archive (e.g. `sherpa-onnx-sense-voice-.../` inside a wrapper folder).
 */
export function inspectLocalAsrModelDir(dirPath: string): LocalAsrModelSpec | null {
  const trimmed = dirPath.trim();
  if (!trimmed) return null;
  const resolved = path.resolve(trimmed);
  const direct = inspectSingleDirectory(resolved);
  if (direct) return direct;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return null;
  }
  const subdirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  for (const subdir of subdirs) {
    const nested = inspectSingleDirectory(path.join(resolved, subdir));
    if (nested) return nested;
  }
  return null;
}

export class LocalAsrModelStore {
  constructor(private readonly getUserDataDir: () => string) {}

  private configPath(): string {
    return path.join(this.getUserDataDir(), CONFIG_FILE_NAME);
  }

  private defaultAutoDiscoverDir(): string {
    return path.join(this.getUserDataDir(), DEFAULT_MODELS_SUBDIR);
  }

  readConfiguredDir(): string | null {
    try {
      const raw = fs.readFileSync(this.configPath(), 'utf8');
      const parsed = JSON.parse(raw) as StoredLocalAsrConfig;
      const modelDir = typeof parsed?.modelDir === 'string' ? parsed.modelDir.trim() : '';
      return modelDir || null;
    } catch {
      return null;
    }
  }

  saveConfiguredDir(modelDir: string): void {
    const filePath = this.configPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ modelDir: path.resolve(modelDir) }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
  }

  clearConfiguredDir(): void {
    try {
      fs.rmSync(this.configPath(), { force: true });
    } catch {
      // ignore missing file
    }
  }

  resolveModel(): {
    configuredDir: string | null;
    spec: LocalAsrModelSpec | null;
    invalidConfiguredDir: boolean;
  } {
    const configuredDir = this.readConfiguredDir();
    if (configuredDir) {
      const spec = inspectLocalAsrModelDir(configuredDir);
      return {
        configuredDir,
        spec,
        invalidConfiguredDir: spec === null,
      };
    }
    const autoSpec = inspectLocalAsrModelDir(this.defaultAutoDiscoverDir());
    return {
      configuredDir: null,
      spec: autoSpec,
      invalidConfiguredDir: false,
    };
  }
}
