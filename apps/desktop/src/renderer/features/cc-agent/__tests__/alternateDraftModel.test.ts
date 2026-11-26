import { beforeEach, describe, expect, it } from 'vitest';
import {
  alternateDraftModelFor,
  forgetRemoteAlternateDraftModel,
  setAlternateDraftModel,
  type AlternateDraftModel,
} from '../alternateDraftModel';
import { NEW_MAKER_DRAFT_KEY } from '../newMakerDraftKeys';

const remote: AlternateDraftModel = {
  ownerGeneration: 12, pageKey: 'draft-page', vendor: 'cc',
  prefs: { model: 'claude-opus-5-5', providerId: 'anthropic', effort: 'xhigh' },
  fast: false, favoriteUid: null, agentDevice: { deviceId: 'example-device', name: 'Example computer' },
};

// Unit regression: restore the same unfinished draft after its page is unmounted.
describe('alternate draft selection lifetime', () => {
  beforeEach(() => {
    setAlternateDraftModel(NEW_MAKER_DRAFT_KEY, null, true);
    forgetRemoteAlternateDraftModel(NEW_MAKER_DRAFT_KEY, true);
  });

  it('restores the selection for its owner and draft, and clears it on completion', () => {
    const alternate: AlternateDraftModel = {
      ownerGeneration: 12, pageKey: 'draft-page', vendor: 'pi', prefs: { model: 'auto', providerId: 'xd', effort: 'high' },
      fast: false, favoriteUid: null,
    };
    setAlternateDraftModel('draft-a', alternate, true);
    expect(alternateDraftModelFor('draft-a', 12, true)).toEqual(alternate);
    expect(alternateDraftModelFor('draft-b', 12, true)).toBeNull();
    expect(alternateDraftModelFor('draft-a', 13, true)).toBeNull();
    setAlternateDraftModel('draft-a', null, true);
    expect(alternateDraftModelFor('draft-a', 12, true)).toBeNull();
  });

  // Unit: 新建页的内存读写入口。既有用例只覆盖本机替代清空。按模型选择规则，发送完成
  // 清掉草稿后，同账号再新建应沿用远程替代。最小输入为远程替代 → 清草稿 → 重新读取。
  it('offers the last remote alternate to the next draft of the same owner until another model is chosen', () => {
    setAlternateDraftModel(NEW_MAKER_DRAFT_KEY, remote, true);
    setAlternateDraftModel(NEW_MAKER_DRAFT_KEY, null, true);
    expect(alternateDraftModelFor(NEW_MAKER_DRAFT_KEY, 12, true)).toEqual(remote);
    expect(alternateDraftModelFor(NEW_MAKER_DRAFT_KEY, 13, true)).toBeNull();
    setAlternateDraftModel(NEW_MAKER_DRAFT_KEY, { ...remote, agentDevice: null, vendor: 'pi' }, true);
    setAlternateDraftModel(NEW_MAKER_DRAFT_KEY, null, true);
    expect(alternateDraftModelFor(NEW_MAKER_DRAFT_KEY, 12, true)).toBeNull();
    setAlternateDraftModel(NEW_MAKER_DRAFT_KEY, remote, true);
    forgetRemoteAlternateDraftModel(NEW_MAKER_DRAFT_KEY, true);
    setAlternateDraftModel(NEW_MAKER_DRAFT_KEY, null, true);
    expect(alternateDraftModelFor(NEW_MAKER_DRAFT_KEY, 12, true)).toBeNull();
  });

  // Unit: 控制其他电脑或恢复失败任务时，使用同一生产入口改选模型。
  // 最小输入为记住本机新建页的远程替代 → 另一个草稿改选 → 回到本机读取。
  // 首版会把本机记忆带进其他草稿，且其他草稿改选会清掉这份记忆。
  it.each([
    [NEW_MAKER_DRAFT_KEY, false],
    ['remote-create-draft-123', false],
    ['remote-create-draft-123', true],
  ])('isolates the local new-task selection from draft %s (local target: %s)', (otherKey, isLocalDraft) => {
    setAlternateDraftModel(NEW_MAKER_DRAFT_KEY, remote, true);
    setAlternateDraftModel(NEW_MAKER_DRAFT_KEY, null, true);

    expect(alternateDraftModelFor(otherKey, 12, isLocalDraft)).toBeNull();
    setAlternateDraftModel(otherKey, { ...remote, agentDevice: null }, isLocalDraft);
    forgetRemoteAlternateDraftModel(otherKey, isLocalDraft);
    setAlternateDraftModel(otherKey, null, isLocalDraft);
    expect(alternateDraftModelFor(NEW_MAKER_DRAFT_KEY, 12, true)).toEqual(remote);
  });
});
