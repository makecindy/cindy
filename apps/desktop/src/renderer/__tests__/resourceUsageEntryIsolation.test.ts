import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(__dirname, '..');

describe('resource usage renderer entry isolation', () => {
  it('keeps the shared index as a minimal dynamic dispatcher', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'index.tsx'), 'utf8');

    expect(source).toContain("import('./resource-usage-entry')");
    expect(source).toContain("import('./main-entry')");
    expect(source).not.toContain('@google/model-viewer');
    expect(source).not.toContain('syncVoiceInputGlobalShortcut');
    expect(source).not.toContain('bootstrapChatEmbeddingFromMain');
  });

  it('keeps main-only startup work out of the resource entry', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'resource-usage-entry.tsx'), 'utf8');

    expect(source).toContain('ResourceUsageWindowRoot');
    expect(source).toContain('TopLevelErrorBoundary');
    expect(source).not.toContain('@google/model-viewer');
    expect(source).not.toContain('syncVoiceInputGlobalShortcut');
    expect(source).not.toContain('bootstrapChatEmbeddingFromMain');
    expect(source).not.toContain('bootstrapLspModeFromMain');
    expect(source).not.toContain('bootstrapGitSafetySettingsFromMain');
  });
});
