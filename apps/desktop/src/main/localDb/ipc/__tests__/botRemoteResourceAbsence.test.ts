import { describe, expect, it } from 'vitest';
import { createIpcError } from '../../../../shared/ipc-errors.js';
import { collectPresentBotRemoteResourceSources } from '../botRemoteResourceAbsence.js';

describe('collectPresentBotRemoteResourceSources', () => {
  it('keeps the companions still present when one disappears during the read', async () => {
    const seen: string[] = [];
    const sources = await collectPresentBotRemoteResourceSources(['keep', 'gone'], async (id) => {
      seen.push(id);
      if (id === 'gone') throw createIpcError('NOT_FOUND', 'Bot 不存在');
      return { id };
    }, () => seen.push('check'));
    expect(sources).toEqual([{ id: 'keep' }]);
    expect(seen).toEqual(['check', 'keep', 'check', 'gone']);
  });

  it('does not hide a roster failure that is not a missing companion', async () => {
    await expect(collectPresentBotRemoteResourceSources(['keep'], async () => {
      throw createIpcError('INTERNAL', 'database unavailable');
    })).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
