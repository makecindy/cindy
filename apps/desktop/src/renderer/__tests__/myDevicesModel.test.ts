import { describe, expect, it } from 'vitest';

import {
  canBeControlledPlatform,
  controlToggleState,
  inboundToggleState,
} from '@/components/settings/myDevicesModel';

describe('canBeControlledPlatform（手机不展示「我控制它」）', () => {
  it('桌面平台可被控制', () => {
    expect(canBeControlledPlatform('darwin')).toBe(true);
    expect(canBeControlledPlatform('win32')).toBe(true);
    expect(canBeControlledPlatform('linux')).toBe(true);
  });

  it('手机 / 平板不可被控制', () => {
    expect(canBeControlledPlatform('ios')).toBe(false);
    expect(canBeControlledPlatform('android')).toBe(false);
  });

  it('平台未知 / null(旧记录)按可被控处理(与切换栏 isMobilePlatform 同口径,避免「能连不能管」)', () => {
    expect(canBeControlledPlatform('unknown')).toBe(true);
    expect(canBeControlledPlatform(null)).toBe(true);
  });
});

describe('controlToggleState（我控制它,恒可编辑;对方已拒绝本机时整行不渲染、不走此函数）', () => {
  it('对方开了被控 → 可编辑,无原因', () => {
    expect(controlToggleState({ remoteControlEnabled: true, controlEnabled: true })).toEqual({
      checked: true,
      reason: null,
    });
  });

  it('对方未开启被控 → 仍可编辑(本地偏好独立于对方状态),reason=peer-off 作说明文字', () => {
    expect(controlToggleState({ remoteControlEnabled: false, controlEnabled: true })).toEqual({
      checked: true,
      reason: 'peer-off',
    });
  });

  it('对方未开启被控 + 本机已 opt-out → checked 反映 controlEnabled,reason=peer-off', () => {
    expect(controlToggleState({ remoteControlEnabled: false, controlEnabled: false })).toEqual({
      checked: false,
      reason: 'peer-off',
    });
  });
});

describe('inboundToggleState（允许它控制本机）', () => {
  it('总开关开 + 未拉黑 → 勾选、可切换', () => {
    expect(inboundToggleState(true, false)).toEqual({ checked: true, disabled: false });
  });

  it('总开关开 + 已拉黑 → 不勾选、可切换(可恢复)', () => {
    expect(inboundToggleState(true, true)).toEqual({ checked: false, disabled: false });
  });

  it('总开关关 → 置灰(黑名单值照旧反映)', () => {
    expect(inboundToggleState(false, false)).toEqual({ checked: true, disabled: true });
    expect(inboundToggleState(false, true)).toEqual({ checked: false, disabled: true });
  });
});
