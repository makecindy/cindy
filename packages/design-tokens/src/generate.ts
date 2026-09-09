import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildLayers } from './build-layers.ts';
import { classifySnapshot, stableStringify } from './classify.ts';
import {
  classificationPath,
  componentPath,
  findRepoRoot,
  referencePath,
  semanticPath,
} from './paths.ts';
import { readSnapshot, snapshotById } from './snapshot.ts';

export function buildShadowLayerFiles(repoRoot = findRepoRoot()) {
  const snapshot = readSnapshot(repoRoot);
  if (snapshot.colors.length !== snapshot.count) {
    throw new Error(
      `快照 count=${snapshot.count} 与 colors.length=${snapshot.colors.length} 不一致`,
    );
  }
  const classification = classifySnapshot(snapshot.colors, snapshot.source);
  const layers = buildLayers(snapshotById(snapshot));
  return {
    classification,
    layers,
    files: [
      { path: classificationPath(repoRoot), body: stableStringify(classification) },
      { path: referencePath(repoRoot), body: stableStringify(layers.reference) },
      { path: semanticPath(repoRoot), body: stableStringify(layers.semantic) },
      { path: componentPath(repoRoot), body: stableStringify(layers.component) },
    ],
  };
}

export function writeShadowLayerFiles(
  files: Array<{ path: string; body: string }>,
): void {
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.body, 'utf8');
  }
}

export function generateShadowLayer(repoRoot = findRepoRoot()) {
  const built = buildShadowLayerFiles(repoRoot);
  writeShadowLayerFiles(built.files);
  return built;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('generate.ts') || process.argv[1].endsWith('generate.js'));

if (isMain) {
  generateShadowLayer();
}
