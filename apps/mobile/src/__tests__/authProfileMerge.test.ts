/**
 * authProfileMerge.test.ts — 手机版展示资料映射纯函数单测。
 * 2026-07 产品 /api/user/me 退役后,身份完全以 auth-server membership 为真源:
 * 原"产品资料合并/头像回落产品值"语义随之删除,这里守住 membership 映射与
 * 同账号合并(头像保留、passportId 兜底)的现行为。
 */

import { describe, expect, it } from 'vitest';

import type { AuthMembership } from '@cindy/auth-client';
import type { Catalog } from '@cindy/model-providers';

import {
  defaultMobileProfileModel,
  mapMembershipToMobileUser,
  mergeMembershipWithExisting,
} from '@/auth/profileMerge';

function membership(avatarUrl: string | null): AuthMembership {
  return {
    id: 'm1',
    kind: 'personal',
    role: 'owner',
    displayName: 'Lizi',
    avatarUrl,
    email: 'a@b.c',
    orgId: null,
    orgName: null,
  };
}

const CUSTOM = 'https://oss.example.invalid/cindy/public/avatar/m1/custom.png';

describe('profileMerge(身份即 auth-server membership)', () => {
  it('default model reads catalog metadata and retains the historical fallback', () => {
    const catalog = {
      version: '3',
      providers: [],
      defaults: { 'claude-code': { sessionModel: 'catalog-mobile-model' } },
    } satisfies Catalog;
    expect(defaultMobileProfileModel(catalog)).toBe('catalog-mobile-model');
    expect(defaultMobileProfileModel({ version: '3', providers: [] })).toBe('claude-sonnet-4-6');
  });

  it('membership 映射:displayName / 自助头像 / email;头像未设置 = null(首字母兜底)', () => {
    const user = mapMembershipToMobileUser(membership(CUSTOM), 'pp-1');
    expect(user.name).toBe('Lizi');
    expect(user.avatar).toBe(CUSTOM);
    expect(user.email).toBe('a@b.c');
    expect(user.passportId).toBe('pp-1');
    expect(mapMembershipToMobileUser(membership(null)).avatar).toBeNull();
  });

  it('同账号合并:membership 自助头像优先;未设置时保留既有展示值(不闪首字母)', () => {
    const previous = mapMembershipToMobileUser(membership(CUSTOM));
    const merged = mergeMembershipWithExisting(membership(null), previous);
    expect(merged.avatar).toBe(CUSTOM);
    const overridden = mergeMembershipWithExisting(membership('https://oss.example.invalid/new.png'), previous);
    expect(overridden.avatar).toBe('https://oss.example.invalid/new.png');
  });

  it('换账号不继承旧展示值:直接用新 membership 映射', () => {
    const previous = mapMembershipToMobileUser(membership(CUSTOM));
    const other: AuthMembership = { ...membership(null), id: 'm2' };
    const merged = mergeMembershipWithExisting(other, previous);
    expect(merged.id).toBe('m2');
    expect(merged.avatar).toBeNull();
  });

  it('passportId:新值优先,空串回落既有值', () => {
    const previous = { ...mapMembershipToMobileUser(membership(null)), passportId: 'pp-old' };
    const merged = mergeMembershipWithExisting(membership(null), previous);
    expect(merged.passportId).toBe('pp-old');
    const withFresh = mergeMembershipWithExisting(membership(null), previous, 'pp-new');
    expect(withFresh.passportId).toBe('pp-new');
  });
});
