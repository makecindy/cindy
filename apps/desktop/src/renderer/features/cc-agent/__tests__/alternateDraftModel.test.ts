import { beforeEach, describe, expect, it } from 'vitest';
import {
  alternateDraftModelFor,
  forgetRemoteAlternateDraftModel,
  setAlternateDraftModel,
  type AlternateDraftModel,
} from '../alternateDraftModel';

// Unit regression: restore the same unfinished draft after its page is unmounted.
// The previous component-local state lost the selected alternate during navigation.
describe('alternate draft selection lifetime', () => {
  beforeEach(() => forgetRemoteAlternateDraftModel());

  it('restores the selection for its owner and draft, and clears it on completion', () => {
    const alternate: AlternateDraftModel = {
      ownerGeneration: 12, pageKey: 'draft-page', vendor: 'pi', prefs: { model: 'auto', providerId: 'xd', effort: 'high' },
      fast: false, favoriteUid: null,
    };
    setAlternateDraftModel('draft-a', alternate);
    expect(alternateDraftModelFor('draft-a', 12)).toEqual(alternate);
    expect(alternateDraftModelFor('draft-b', 12)).toBeNull();
    expect(alternateDraftModelFor('draft-a', 13)).toBeNull();
    setAlternateDraftModel('draft-a', null);
    expect(alternateDraftModelFor('draft-a', 12)).toBeNull();
  });

  // 测试价值：经 setAlternateDraftModel / alternateDraftModelFor(新建页挂载时取替代模型的入口)，观察发送完成
  // 清掉草稿后下一次新建拿到的替代模型。依据：2026-11-26 用户裁决，保存的默认用不了时选的远程模型要像正常选的
  // 远程模型一样沿用(model-selector-unified.md)。缺口：上一例只覆盖本机替代在完成后清空。最小失败输入：
  // 远程替代 → 完成清空 → 再取，修复前为 null。tier：unit(纯内存)。
  it('offers the last remote alternate to the next draft of the same owner until another model is chosen', () => {
    const remote: AlternateDraftModel = {
      ownerGeneration: 12, pageKey: 'draft-page', vendor: 'cc', prefs: { model: 'claude-opus-5-5', providerId: 'anthropic', effort: 'xhigh' },
      fast: false, favoriteUid: null, agentDevice: { deviceId: 'mac-mini', name: 'Mac Mini' },
    };
    setAlternateDraftModel('draft-a', remote);
    setAlternateDraftModel('draft-a', null);
    expect(alternateDraftModelFor('draft-a', 12)).toEqual(remote);
    expect(alternateDraftModelFor('draft-a', 13)).toBeNull();
    // 改选本机模型作为替代，或明确选了别的模型，之后都不再沿用远程那一个。
    setAlternateDraftModel('draft-a', { ...remote, agentDevice: null, vendor: 'pi' });
    setAlternateDraftModel('draft-a', null);
    expect(alternateDraftModelFor('draft-a', 12)).toBeNull();
    setAlternateDraftModel('draft-a', remote);
    forgetRemoteAlternateDraftModel();
    setAlternateDraftModel('draft-a', null);
    expect(alternateDraftModelFor('draft-a', 12)).toBeNull();
  });
});
