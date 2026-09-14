import { afterEach, describe, expect, it } from 'vitest';
import {
  buildComposerPaletteCacheKey,
  evictComposerPaletteCacheForDevice,
  readAtResourceScanCache,
  readSlashCommandCache,
  resetComposerPaletteCache,
  writeAtResourceScanCache,
  writeSlashCommandCache,
} from '@/session/composerPaletteCache';
import type { MobileAtResourceItem, MobileSlashCommand } from '@/device-link/mobileMakerTransport';

const item = (relPath: string): MobileAtResourceItem => ({ type: 'file', name: relPath, relPath });
const command = (name: string): MobileSlashCommand => ({ kind: 'agent-builtin', name, description: name });

describe('composerPaletteCache eviction', () => {
  afterEach(() => {
    resetComposerPaletteCache();
  });

  it('evictComposerPaletteCacheForDevice 清掉该设备全部 @ / slash 条目,不误伤他机(分隔符回归)', () => {
    // 回归背景(codex review R13):key 构造曾用裸 NUL 字节分隔而驱逐前缀误用空格,
    // startsWith 永不命中——设备撤销/重连后旧 @ 资源与 slash 列表一直陈化。
    // workingDir 刻意带空格:空格分隔的 key 口径下这类路径还会产生歧义。
    const keyA1 = buildComposerPaletteCacheKey('dev-a', 'cc', '/repo/my project');
    const keyA2 = buildComposerPaletteCacheKey('dev-a', 'codex', '/repo/other');
    const keyB = buildComposerPaletteCacheKey('dev-b', 'cc', '/repo/my project');
    writeAtResourceScanCache(keyA1, { items: [item('a1.ts')], truncated: false });
    writeAtResourceScanCache(keyB, { items: [item('b.ts')], truncated: false });
    writeSlashCommandCache(keyA2, [command('/deploy')]);
    writeSlashCommandCache(keyB, [command('/review')]);

    evictComposerPaletteCacheForDevice('dev-a');

    expect(readAtResourceScanCache(keyA1)).toBeNull();
    expect(readSlashCommandCache(keyA2)).toBeNull();
    expect(readAtResourceScanCache(keyB)?.result.items[0]?.relPath).toBe('b.ts');
    expect(readSlashCommandCache(keyB)?.[0]?.name).toBe('/review');
  });

  it('key 用 \\u0000 分隔:构造与驱逐前缀口径一致,不同设备/agent/目录互不冲突', () => {
    const key = buildComposerPaletteCacheKey('dev-a', 'cc', '/w');
    expect(key).toBe('dev-a\u0000cc\u0000/w\u0000');
    expect(key.startsWith('dev-a\u0000')).toBe(true);
    // 前缀是设备 id + 分隔符:同前缀字符串的另一设备 id(如 dev-a2)不会被误驱逐。
    const other = buildComposerPaletteCacheKey('dev-a2', 'cc', '/w');
    writeSlashCommandCache(other, [command('/keep')]);
    evictComposerPaletteCacheForDevice('dev-a');
    expect(readSlashCommandCache(other)?.[0]?.name).toBe('/keep');
  });

  it('keeps live session slash snapshots separate from preview and sibling tasks', () => {
    const preview = buildComposerPaletteCacheKey('dev-a', 'pi', '/repo');
    const sessionOne = buildComposerPaletteCacheKey('dev-a', 'pi', '/repo', 'session-one');
    const sessionTwo = buildComposerPaletteCacheKey('dev-a', 'pi', '/repo', 'session-two');

    writeSlashCommandCache(preview, [command('/preview')]);
    writeSlashCommandCache(sessionOne, [command('/one')]);
    writeSlashCommandCache(sessionTwo, [command('/two')]);

    expect(readSlashCommandCache(preview)?.[0]?.name).toBe('/preview');
    expect(readSlashCommandCache(sessionOne)?.[0]?.name).toBe('/one');
    expect(readSlashCommandCache(sessionTwo)?.[0]?.name).toBe('/two');
  });
});
