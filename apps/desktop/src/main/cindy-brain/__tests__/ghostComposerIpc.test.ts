import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { InstalledGhost } from '../../../shared/ghost';
import {
  createGhostComposerListHandler,
  MAX_REMOTE_COMPOSER_CATALOG_BYTES,
} from '../ghostComposerIpc';
import { ghostComposerListSchema } from '../../../shared/ghostComposer';
import { expandGhostCommand } from '../../../renderer/cindy-brain/ghostCommand';

const mocks = vi.hoisted(() => ({ context: vi.fn(), trusted: vi.fn() }));
vi.mock('../../device-link/invoke-context', () => ({ getDeviceLinkInvokeContext: mocks.context }));
vi.mock('../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: mocks.trusted,
}));

const ghost = (id: string): InstalledGhost => ({
  manifest: {
    schemaVersion: 2,
    id,
    name: id,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    command: id,
    tools: [{ name: 'draw', description: 'Draw', parameters: { type: 'object' } }],
  },
  dir: '/private/install/path',
  enabled: true,
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
});
const event = {} as IpcMainInvokeEvent;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue(null);
});

describe('remote composer catalog boundary', () => {
  it('projects public command data with host-side directory disablement', () => {
    const list = vi.fn(() => [ghost('art'), ghost('cindy-mivo'), ghost('xd-mivo')]);
    const disabledIds = vi.fn(() => ['art']);
    mocks.context.mockReturnValue({ channel: 'ghosts:composer-list' });
    const result = createGhostComposerListHandler({ list, disabledIds })(event, '/host/project');
    expect(result.map((item) => item.manifest.id)).toEqual(['art', 'xd-mivo']);
    expect(result[0].enabled).toBe(false);
    expect(disabledIds).toHaveBeenCalledWith('/host/project');
    expect(ghostComposerListSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private|approval|revision|main.js/);
    const received = ghostComposerListSchema.parse(JSON.parse(JSON.stringify(result)));
    expect(expandGhostCommand('$xd-mivo draw', received)).toContain('ghost_call');
    expect(expandGhostCommand('$art draw', received)).toBe('$art draw');
    expect(mocks.trusted).not.toHaveBeenCalled();
  });

  it('validates local senders and rejects shared-task or mismatched invoke contexts', () => {
    const list = vi.fn(() => [ghost('art')]);
    const handler = createGhostComposerListHandler({ list, disabledIds: () => [] });
    handler(event);
    expect(mocks.trusted).toHaveBeenCalledWith(event);
    list.mockClear();
    for (const context of [
      { channel: 'wrong' },
      { channel: 'ghosts:composer-list', sharedTask: {} },
    ]) {
      mocks.context.mockReturnValue(context);
      expect(() => handler(event)).toThrow();
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('bounds large remote icons without losing menu entries or changing local data', () => {
    const ghosts = Array.from({ length: 9 }, (_, i) => ({
      ...ghost(`art-${i}`),
      iconDataUrl: `data:image/png;base64,${'A'.repeat(512 * 1024)}`,
    }));
    const handler = createGhostComposerListHandler({ list: () => ghosts, disabledIds: () => [] });
    const local = handler(event);
    expect(Buffer.byteLength(JSON.stringify(local), 'utf8')).toBeGreaterThan(4 * 1024 * 1024);
    mocks.context.mockReturnValue({ channel: 'ghosts:composer-list' });
    const remote = handler(event);
    expect(Buffer.byteLength(JSON.stringify(remote), 'utf8'))
      .toBeLessThanOrEqual(MAX_REMOTE_COMPOSER_CATALOG_BYTES);
    expect(remote.map((entry) => entry.manifest.id))
      .toEqual(ghosts.map((entry) => entry.manifest.id));
    expect(remote.every((entry) => entry.manifest.tools?.[0].name === 'draw')).toBe(true);
    expect(remote.some((entry) => entry.iconDataUrl)).toBe(true);
    expect(remote.some((entry) => !entry.iconDataUrl)).toBe(true);
    expect(local.every((entry) => entry.iconDataUrl === ghosts[0].iconDataUrl)).toBe(true);
    expect(ghostComposerListSchema.safeParse(remote).success).toBe(true);
  });

  it('counts UTF-8 and JSON escapes and falls back to discovery for oversized schemas', () => {
    const large = ghost('large');
    large.manifest.tools![0].parameters = { description: '中文"\\'.repeat(150_000) };
    const small = { ...ghost('small'), iconDataUrl: 'data:image/png;base64,AA==' };
    mocks.context.mockReturnValue({ channel: 'ghosts:composer-list' });
    const remote = createGhostComposerListHandler({
      list: () => [large, small], disabledIds: () => [],
    })(event);
    expect(Buffer.byteLength(JSON.stringify(remote), 'utf8'))
      .toBeLessThanOrEqual(MAX_REMOTE_COMPOSER_CATALOG_BYTES);
    expect(remote[0].manifest.tools).toBeUndefined();
    expect(remote[1].manifest.tools).toEqual(small.manifest.tools);
    expect(remote[1].iconDataUrl).toBe(small.iconDataUrl);
    expect(expandGhostCommand('$large draw', remote)).toContain('ghost_list');
    expect(expandGhostCommand('$small draw', remote)).toContain('ghost_call');
    expect(large.manifest.tools![0].parameters).toBeDefined();
  });

  it('accepts an exact UTF-8 budget and omits the optional field once it exceeds it', () => {
    const item = ghost('boundary');
    delete item.manifest.tools;
    mocks.context.mockReturnValue({ channel: 'ghosts:composer-list' });
    const handler = createGhostComposerListHandler({ list: () => [item], disabledIds: () => [] });
    const baseBytes = Buffer.byteLength(JSON.stringify(handler(event)), 'utf8');
    const fieldBytes = Buffer.byteLength(JSON.stringify({ iconDataUrl: '' }), 'utf8') - 1;
    const remaining = MAX_REMOTE_COMPOSER_CATALOG_BYTES - baseBytes - fieldBytes;
    item.iconDataUrl = '中'.repeat(Math.floor(remaining / 3)) + 'A'.repeat(remaining % 3);
    expect(Buffer.byteLength(JSON.stringify(handler(event)), 'utf8'))
      .toBe(MAX_REMOTE_COMPOSER_CATALOG_BYTES);
    item.iconDataUrl += '\\';
    expect(handler(event)[0].iconDataUrl).toBeUndefined();
  });

  it('rejects oversized required metadata instead of silently dropping plugins', () => {
    const large = ghost('large');
    large.manifest.name = '中'.repeat(MAX_REMOTE_COMPOSER_CATALOG_BYTES / 2);
    mocks.context.mockReturnValue({ channel: 'ghosts:composer-list' });
    expect(() => createGhostComposerListHandler({ list: () => [large], disabledIds: () => [] })(event))
      .toThrow('Plugin catalog metadata exceeds the response size limit');
  });

  it.each([null, {}, 42, 'bad\0path', 'x'.repeat(32_769)])(
    'rejects invalid directory arguments',
    (workingDir) => {
      const list = vi.fn(() => []);
      const handler = createGhostComposerListHandler({ list, disabledIds: () => [] });
      expect(() => handler(event, workingDir)).toThrow();
      expect(list).not.toHaveBeenCalled();
    },
  );
});
