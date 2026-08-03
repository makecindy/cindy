import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GHOST_ICON_MAX_BYTES } from '../../../shared/ghost.js';
import { convertForgeIconFile } from '../forgeIconConversionProcess.js';

let workDir: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-forge-icon-test-'));
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

describe('convertForgeIconFile', () => {
  it('真实 Sharp 路径输出 1024×1024 且满足安装器字节上限', async () => {
    const input = path.join(workDir, 'input.png');
    await sharp({
      create: {
        width: 64,
        height: 32,
        channels: 4,
        background: { r: 20, g: 120, b: 200, alpha: 1 },
      },
    })
      .png()
      .toFile(input);

    const output = await convertForgeIconFile(input, 5);
    const metadata = await sharp(output).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1024);
    expect(metadata.height).toBe(1024);
    expect(output.byteLength).toBeLessThanOrEqual(GHOST_ICON_MAX_BYTES);
  });
});
