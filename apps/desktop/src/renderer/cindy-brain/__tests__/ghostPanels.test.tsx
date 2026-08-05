// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import {
  __resetGhostPanelBubbleStateForTest,
  getGhostPanelBubbleState,
  minimizeGhostPanel,
} from '../../lib/ghostPanelBubbleState';
import { __resetPanelRegistryForTest, hasPanelKind, listPanelKinds } from '../../panels/registry';
import {
  __resetGhostPanelsForTest,
  pickGhostPanelMediaUri,
  syncGhostPanelRegistrations,
} from '../ghostPanels';

/** 造一个已装意识(panel 可覆写/置空;enabled 默认 true)。 */
function ghost(id: string, panel?: GhostManifest['panel'] | null, enabled = true): InstalledGhost {
  const manifest: GhostManifest = {
    schemaVersion: 2,
    id,
    name: `${id} 意识`,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: panel === null ? ['tool'] : ['panel'],
    ...(panel === null ? {} : { panel: panel ?? { title: id, html: 'panel.html' } }),
  };
  return { manifest, dir: `/fake/${id}`, enabled };
}

afterEach(() => {
  __resetPanelRegistryForTest();
  __resetGhostPanelsForTest();
  __resetGhostPanelBubbleStateForTest();
});

describe('syncGhostPanelRegistrations · 注册表与已装清单对齐', () => {
  it('装入的意识面板进注册表;无面板声明的意识不进', () => {
    syncGhostPanelRegistrations([ghost('hello'), ghost('toolonly', null)]);
    expect(hasPanelKind('ghost:hello')).toBe(true);
    expect(hasPanelKind('ghost:toolonly')).toBe(false);
  });

  it('卸下(清单里消失)→ 注销;其余不动', () => {
    syncGhostPanelRegistrations([ghost('a'), ghost('b')]);
    expect(hasPanelKind('ghost:a')).toBe(true);
    syncGhostPanelRegistrations([ghost('b')]);
    expect(hasPanelKind('ghost:a')).toBe(false);
    expect(hasPanelKind('ghost:b')).toBe(true);
  });

  it('清单没变 → 不重注册(组件身份稳定,不触发重挂载)', () => {
    syncGhostPanelRegistrations([ghost('a')]);
    const before = listPanelKinds().length;
    syncGhostPanelRegistrations([ghost('a')]);
    expect(listPanelKinds().length).toBe(before);
  });

  it('全卸光 → 注册表回空', () => {
    syncGhostPanelRegistrations([ghost('a'), ghost('b')]);
    syncGhostPanelRegistrations([]);
    expect(hasPanelKind('ghost:a')).toBe(false);
    expect(hasPanelKind('ghost:b')).toBe(false);
  });

  it('同步时对齐气泡状态:卸载删条目、停用强制还原(不留死角)', () => {
    minimizeGhostPanel('gone');
    minimizeGhostPanel('disabled');
    syncGhostPanelRegistrations([ghost('disabled', undefined, false)]);
    const bubbles = getGhostPanelBubbleState();
    expect(bubbles.gone).toBeUndefined();
    expect(bubbles.disabled?.minimized).not.toBe(true);
  });

  it('同步时对齐气泡状态:卸载删条目、停用强制还原(不留死角)', () => {
    minimizeGhostPanel('gone');
    minimizeGhostPanel('disabled');
    syncGhostPanelRegistrations([ghost('disabled', undefined, false)]);
    const bubbles = getGhostPanelBubbleState();
    expect(bubbles.gone).toBeUndefined();
    expect(bubbles.disabled?.minimized).not.toBe(true);
  });
});

describe('pickGhostPanelMediaUri · 右键命中参数挑媒体地址', () => {
  const HASH = 'a'.repeat(64);
  const MEDIA = `cindy-ghost://art/media/${HASH}.png`;
  const PREVIEW = `cindy-ghost://art/preview/${HASH}.mp4`;

  it('srcURL 优先(直接右键在 img/video 上);linkURL 兜底(视频缩略命中外层 <a>)', () => {
    expect(pickGhostPanelMediaUri({ srcURL: MEDIA, linkURL: PREVIEW }, 'art')).toBe(MEDIA);
    expect(pickGhostPanelMediaUri({ srcURL: '', linkURL: PREVIEW }, 'art')).toBe(PREVIEW);
  });

  it('非媒体 cell(普通元素/外部地址)返回 null,不弹菜单', () => {
    expect(pickGhostPanelMediaUri({}, 'art')).toBeNull();
    expect(pickGhostPanelMediaUri({ srcURL: 'https://evil.example/x.png' }, 'art')).toBeNull();
    expect(pickGhostPanelMediaUri({ linkURL: `cindy-ghost://art/gallery` }, 'art')).toBeNull();
  });

  it('只认本面板意识 id 前缀,别的意识地址不弹', () => {
    expect(pickGhostPanelMediaUri({ srcURL: MEDIA }, 'other')).toBeNull();
  });

  it('多级路径 / query 形状拒绝(严校验仍在 main 闸,这里是粗筛)', () => {
    expect(pickGhostPanelMediaUri({ srcURL: `cindy-ghost://art/media/../${HASH}.png` }, 'art')).toBeNull();
    expect(pickGhostPanelMediaUri({ srcURL: `${MEDIA}?x=1` }, 'art')).toBeNull();
  });
});

describe('syncGhostPanelRegistrations · 停用即休眠', () => {
  it('停用的意识不注册面板;重新启用后同一条对齐路径复活', () => {
    syncGhostPanelRegistrations([ghost('a', undefined, false)]);
    expect(hasPanelKind('ghost:a')).toBe(false);
    syncGhostPanelRegistrations([ghost('a', undefined, true)]);
    expect(hasPanelKind('ghost:a')).toBe(true);
  });

  it('运行中停用 → 已注册的面板被注销', () => {
    syncGhostPanelRegistrations([ghost('a')]);
    expect(hasPanelKind('ghost:a')).toBe(true);
    syncGhostPanelRegistrations([ghost('a', undefined, false)]);
    expect(hasPanelKind('ghost:a')).toBe(false);
  });
});
