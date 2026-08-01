import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-import-local-skill-test-'));

function removeTestRoot(): void {
  fs.rmSync(TEST_ROOT, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 20,
  });
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => path.join(TEST_ROOT, 'userData')),
  },
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../authManager', () => ({
  getCurrentUserId: vi.fn(() => 'user-1'),
}));

vi.mock('../registry', () => ({
  registryService: {
    addInstall: vi.fn(),
  },
}));

vi.mock('../folderHash', () => ({
  computeFolderHash: vi.fn(async () => 'folder-hash'),
}));

vi.mock('../../maker-host/shared-global-skills.js', () => ({
  prepareSharedGlobalSkillLinks: vi.fn(async () => ({ warnings: [] })),
  prepareSharedProjectSkillLinks: vi.fn(async () => ({ warnings: [] })),
  projectWorkingDirFromSkillPath: vi.fn(() => null),
}));

vi.mock('../installService', () => ({
  ensureSymlinkToShared: vi.fn(async () => undefined),
}));

afterAll(() => {
  removeTestRoot();
});

async function writeZip(files: Record<string, string | Buffer>): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const filePath = path.join(TEST_ROOT, `pkg-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
  await fs.promises.writeFile(filePath, buf);
  return filePath;
}

describe('importLocalSkill zip / installPath guards', () => {
  it('inspect rejects an oversized SKILL.md before full-budget inflate', async () => {
    const { inspectLocalSkill } = await import('../importLocalSkill');
    const huge = `---
name: huge-skill
description: too large
---

${'x'.repeat(2 * 1024 * 1024 + 100)}
`;
    const zipPath = await writeZip({ 'SKILL.md': huge });
    const result = await inspectLocalSkill({ filePath: zipPath });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe('EXTRACT_FAILED');
      expect(result.message).toMatch(/SKILL\.md|上限/);
    }
  });

  it('import rejects relative installPath and non-skill roots', async () => {
    const { importLocalSkill } = await import('../importLocalSkill');
    const zipPath = await writeZip({
      'SKILL.md': `---
name: demo-skill
description: A demo skill
---
`,
    });

    const relative = await importLocalSkill({
      filePath: zipPath,
      installPath: 'relative/demo-skill',
    });
    expect(relative.success).toBe(false);
    if (!relative.success) {
      expect(relative.message).toMatch(/绝对路径/);
    }

    const outside = await importLocalSkill({
      filePath: zipPath,
      installPath: path.join(TEST_ROOT, 'demo-skill'),
    });
    expect(outside.success).toBe(false);
    if (!outside.success) {
      expect(outside.message).toMatch(/\.agents\/skills|\.claude\/skills/);
    }
  });
});
