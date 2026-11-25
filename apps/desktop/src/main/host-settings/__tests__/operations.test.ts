import { describe, expect, it, vi } from 'vitest';
import { HostSettingsError, SettingsOperationJournal } from '../operations.js';

describe('settings operation receipts', () => {
  it('converges duplicates and rejects changed intent/caller/owner', async () => {
    const journal = new SettingsOperationJournal();
    const operationId = journal.issue('owner:1', 'caller', 'appearance', 'revision');
    const perform = vi.fn(async () => ({ operationId, domain: 'appearance', status: 'saved' as const, saved: true, application: 'applied' as const }));
    const args = { operationId, owner: 'owner:1', caller: 'caller', domain: 'appearance', revision: 'revision', normalizedChange: { set: { uiSize: 16 } }, assertCurrent: vi.fn(), perform };
    const [first, duplicate] = await Promise.all([journal.execute(args), journal.execute(args)]);
    expect(first).toEqual(duplicate);
    expect(perform).toHaveBeenCalledTimes(1);
    await expect(journal.execute({ ...args, normalizedChange: { set: { uiSize: 18 } } })).rejects.toMatchObject({ code: 'OPERATION_MISMATCH' });
    await expect(journal.execute({ ...args, owner: 'owner:2' })).rejects.toMatchObject({ code: 'OPERATION_MISMATCH' });
    expect(journal.get(operationId, 'owner:1', 'another-caller')).toEqual({ status: 'unknown' });
  });

  it('never replays expired, evicted or restarted IDs', async () => {
    let now = 0;
    const journal = new SettingsOperationJournal(() => now, 2, 100);
    const operationId = journal.issue('a', 'c', 'd', 'r');
    now = 101;
    const perform = vi.fn();
    const args = { operationId, owner: 'a', caller: 'c', domain: 'd', revision: 'r', normalizedChange: {}, assertCurrent: () => {}, perform };
    await expect(journal.execute(args)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await expect(new SettingsOperationJournal().execute(args)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(perform).not.toHaveBeenCalled();
  });

  it('容量不足不会驱逐正在确认或保存的请求，超时后仍保留在途结果', async () => {
    let now = 0;
    const journal = new SettingsOperationJournal(() => now, 1, 100);
    const operationId = journal.issue('o', 'c', 'd', 'r');
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const perform = vi.fn(async () => { await gate; return { operationId, domain: 'd', status: 'saved' as const, saved: true, application: 'applied' as const }; });
    const args = { operationId, owner: 'o', caller: 'c', domain: 'd', revision: 'r', normalizedChange: {}, assertCurrent: () => {}, perform };
    const first = journal.execute(args);
    now = 101;
    expect(journal.get(operationId, 'o', 'c')).toEqual({ status: 'pending' });
    expect(() => journal.issue('other', 'c', 'd', 'r')).toThrow('BUSY');
    const duplicate = journal.execute(args);
    finish();
    expect(await first).toEqual(await duplicate); expect(perform).toHaveBeenCalledOnce();
    expect(journal.get(operationId, 'o', 'c')).toEqual({ status: 'unknown' });
  });

  it('已驱逐但尚未执行的 ID 不能重新触发写入', async () => {
    const journal = new SettingsOperationJournal(Date.now, 1);
    const old = journal.issue('o', 'c', 'd', 'r');
    journal.issue('o', 'c', 'd', 'r');
    const perform = vi.fn();
    await expect(journal.execute({ operationId: old, owner: 'o', caller: 'c', domain: 'd', revision: 'r', normalizedChange: {}, assertCurrent: () => {}, perform })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(perform).not.toHaveBeenCalled();
  });

  it('已保存回执也要求当前调用身份，不能靠旧 ID 绕过代次检查', async () => {
    const journal = new SettingsOperationJournal();
    const operationId = journal.issue('o', 'c', 'd', 'r');
    const perform = vi.fn(async () => ({ operationId, domain: 'd', status: 'saved' as const, saved: true, application: 'applied' as const }));
    const args = { operationId, owner: 'o', caller: 'c', domain: 'd', revision: 'r', normalizedChange: {}, assertCurrent: () => {}, perform };
    await journal.execute(args);
    await expect(journal.execute({ ...args, assertCurrent: () => { throw new HostSettingsError('OWNER_CHANGED'); } })).rejects.toMatchObject({ code: 'OWNER_CHANGED' });
    for (const mismatch of [{ caller: 'other' }, { domain: 'other' }, { revision: 'other' }]) {
      await expect(journal.execute({ ...args, ...mismatch })).rejects.toMatchObject({ code: 'OPERATION_MISMATCH' });
    }
    expect(perform).toHaveBeenCalledOnce();
  });

  it('失败回执不带正文或原始错误，再次查询也不执行原操作', async () => {
    const journal = new SettingsOperationJournal();
    const operationId = journal.issue('o', 'c', 'personalization', 'r');
    const perform = vi.fn(async () => { throw new Error('私密正文与内部路径'); });
    const args = { operationId, owner: 'o', caller: 'c', domain: 'personalization', revision: 'r', normalizedChange: { userPrompt: '私密正文' }, assertCurrent: () => {}, perform };
    const receipt = await journal.execute(args);
    expect(receipt).toMatchObject({ saved: false, code: 'SAVE_FAILED' });
    expect(JSON.stringify(receipt)).not.toContain('私密');
    expect(journal.get(operationId, 'o', 'c')).toEqual(receipt);
    await journal.execute(args); expect(perform).toHaveBeenCalledOnce();
  });
});
