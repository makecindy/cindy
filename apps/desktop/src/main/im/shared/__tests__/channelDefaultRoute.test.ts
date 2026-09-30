import { describe, expect, it } from 'vitest';

import { IM_DEFAULT_SETTINGS, type ImDefaultSettings } from '../../../../shared/imDefaultSettings';
import {
  buildImDefaultRouteRecord,
  buildImManualRouteOverrideRecord,
  decideImDefaultRoute,
  fingerprintImDefaultSettings,
  imDefaultRouteMayNeedSync,
  parseImDefaultRouteRecord,
  sameImDefaultRoute,
  type ImDefaultRoute,
  type ImDefaultRouteRecord,
} from '../channelDefaultRoute';

const OLD: ImDefaultRoute = { agentKind: 'claude-code', model: 'claude-opus-4-8', providerId: null, effort: 'xhigh' };
const NEW: ImDefaultRoute = { agentKind: 'codex', model: 'gpt-5.5', providerId: 'openai', effort: 'high' };
const PICKED: ImDefaultRoute = { agentKind: 'claude-code', model: 'claude-sonnet-5', providerId: 'xd', effort: 'high' };

function record(overrides: Partial<ImDefaultRouteRecord> = {}): ImDefaultRouteRecord {
  return { v: 1, fp: 'fp-old', route: OLD, ...overrides };
}

function settings(patch: Partial<ImDefaultSettings> = {}): ImDefaultSettings {
  return { ...structuredClone(IM_DEFAULT_SETTINGS), ...patch };
}

describe('fingerprintImDefaultSettings', () => {
  it('changes with any engine route setting but not with permission modes', () => {
    const base = settings();
    const fp = fingerprintImDefaultSettings(base);
    expect(fingerprintImDefaultSettings(settings({ permissionMode: 'bypassPermissions' }))).toBe(fp);
    expect(fingerprintImDefaultSettings(settings({ groupPermissionMode: 'ask' }))).toBe(fp);
    expect(fingerprintImDefaultSettings(settings({ agentKind: 'codex' }))).not.toBe(fp);
    // 选定引擎之外的设置也算: 选定引擎的模型全被停用时会回落到别的引擎。
    const pi = structuredClone(base);
    pi.agents.pi.model = 'other-model';
    expect(fingerprintImDefaultSettings(pi)).not.toBe(fp);
    const effort = structuredClone(base);
    effort.agents[base.agentKind].effort = 'low';
    expect(fingerprintImDefaultSettings(effort)).not.toBe(fp);
  });
});

describe('im default route record', () => {
  it('round-trips and rejects malformed records', () => {
    const json = buildImDefaultRouteRecord('fp', OLD, { route: NEW, fp: 'fp-new' });
    expect(parseImDefaultRouteRecord(json)).toEqual({ v: 1, fp: 'fp', route: OLD, pendingRoute: NEW, pendingFp: 'fp-new' });
    expect(
      parseImDefaultRouteRecord(buildImDefaultRouteRecord('fp', OLD, { route: NEW, fp: 'fp-new', rev: 7 })),
    ).toEqual({ v: 1, fp: 'fp', route: OLD, pendingRoute: NEW, pendingFp: 'fp-new', pendingRev: 7 });
    expect(parseImDefaultRouteRecord(buildImDefaultRouteRecord('fp', OLD))).toEqual({ v: 1, fp: 'fp', route: OLD });
    expect(parseImDefaultRouteRecord(buildImManualRouteOverrideRecord(OLD))).toEqual({
      v: 1,
      fp: '',
      route: OLD,
      manual: true,
    });
    expect(parseImDefaultRouteRecord(null)).toBeNull();
    expect(parseImDefaultRouteRecord('not json')).toBeNull();
    expect(parseImDefaultRouteRecord(JSON.stringify({ v: 2, fp: 'fp', route: OLD }))).toBeNull();
    expect(parseImDefaultRouteRecord(JSON.stringify({ v: 1, fp: 'fp', route: { ...OLD, agentKind: 'x' } }))).toBeNull();
    expect(parseImDefaultRouteRecord(JSON.stringify({ v: 1, fp: 'fp', route: OLD, pendingRoute: {} }))).toBeNull();
  });

  it('only resolves new defaults when the settings fingerprint moved', () => {
    expect(imDefaultRouteMayNeedSync(null, 'fp-new')).toBe(false);
    expect(imDefaultRouteMayNeedSync(record(), 'fp-old')).toBe(false);
    expect(imDefaultRouteMayNeedSync(record(), 'fp-new')).toBe(true);
  });
});

describe('sameImDefaultRoute', () => {
  it('treats an implicit provider and its pinned source as the same route', () => {
    const pinned = { ...OLD, providerId: 'xd' };
    expect(sameImDefaultRoute(OLD, pinned)).toBe(false);
    expect(sameImDefaultRoute(OLD, pinned, (route) => route.providerId ?? 'xd')).toBe(true);
    expect(sameImDefaultRoute(OLD, { ...OLD, effort: 'low' }, (route) => route.providerId ?? 'xd')).toBe(false);
  });
});

describe('decideImDefaultRoute', () => {
  const decide = (input: Omit<Parameters<typeof decideImDefaultRoute>[0], 'targetFp'> & { targetFp?: string }) =>
    decideImDefaultRoute({ targetFp: 'fp-new', ...input });

  it('switches a task that still runs the recorded default', () => {
    expect(decide({ record: record(), current: OLD, target: NEW })).toEqual({ kind: 'switch' });
  });

  it('keeps a task the user changed (applied pick)', () => {
    expect(decide({ record: record(), current: PICKED, target: NEW })).toEqual({ kind: 'manual' });
  });

  it('keeps a task whose user pick is still pending', () => {
    expect(
      decide({ record: record(), current: OLD, target: NEW, pendingIntent: PICKED }),
    ).toEqual({ kind: 'manual' });
  });

  it('adopts the record when the task still runs the recorded route', () => {
    expect(decide({ record: record(), current: OLD, target: OLD })).toEqual({ kind: 'adopt' });
  });

  it('adopts the record when its own pending target already landed on the task', () => {
    // 发送路径替本功能应用了意图、记录还没跟上: 仍是跟随中的任务, 只补指纹。
    expect(
      decide({ record: record({ pendingRoute: NEW, pendingFp: 'fp-older' }), current: NEW, target: NEW }),
    ).toEqual({ kind: 'adopt' });
  });

  it('does not adopt a manual pick that happens to equal the new default', () => {
    // 用户单独改成 NEW、默认随后也改到 NEW: 不能洗成跟随, 否则下次默认变化会盖掉用户的选择
    // (chatgpt-codex-connector P2, PR #5155)。
    expect(decide({ record: record(), current: NEW, target: NEW })).toEqual({ kind: 'manual' });
  });

  it('never follows again once the task carries a manual override marker', () => {
    // 同值重选在路由值上无痕, 选择落地时立墓碑; 此后无论默认怎么变都不跟随
    // (greptile P1 补充, PR #5155)。
    const tombstoned = { ...record(), manual: true as const };
    expect(decide({ record: tombstoned, current: OLD, target: NEW })).toEqual({ kind: 'manual' });
    expect(decide({ record: tombstoned, current: OLD, target: OLD })).toEqual({ kind: 'manual' });
    expect(decide({ record: tombstoned, current: NEW, target: NEW })).toEqual({ kind: 'manual' });
  });

  it('does not re-register its own pending switch to the same target', () => {
    expect(
      decide({
        record: record({ pendingRoute: NEW }),
        current: OLD,
        target: NEW,
        pendingIntent: NEW,
      }),
    ).toEqual({ kind: 'staged' });
  });

  it('treats a user re-pick of the same route as a manual choice', () => {
    // 自动切换未生效时用户又明确挑了同一模型/来源: 意图被顶掉但值一模一样,
    // 只靠路由值会误认成自己的意图(greptile P1, PR #5155)。注册修订号每次
    // set/clear 都推进, 对不上就按用户选择对待, 并清掉过时的待生效声称。
    expect(
      decide({
        record: record({ pendingRoute: NEW, pendingFp: 'fp-new', pendingRev: 3 }),
        current: OLD,
        target: NEW,
        pendingIntent: NEW,
        pendingRev: 4,
      }),
    ).toEqual({ kind: 'manual', clearStalePending: true });
  });

  it('recognizes its own staged switch by registration revision', () => {
    expect(
      decide({
        record: record({ pendingRoute: NEW, pendingFp: 'fp-new', pendingRev: 3 }),
        current: OLD,
        target: NEW,
        pendingIntent: NEW,
        pendingRev: 3,
      }),
    ).toEqual({ kind: 'staged' });
  });

  it('recognizes its own staged switch by fingerprint even after a provider re-route', () => {
    const rerouted: ImDefaultRoute = { ...NEW, providerId: 'openai-copy' };
    expect(
      decide({
        record: record({ pendingRoute: rerouted, pendingFp: 'fp-new' }),
        current: OLD,
        target: NEW,
        pendingIntent: rerouted,
      }),
    ).toEqual({ kind: 'staged' });
    expect(
      decide({
        record: record({ pendingRoute: rerouted, pendingFp: 'fp-older' }),
        current: OLD,
        target: NEW,
        pendingIntent: rerouted,
      }),
    ).toEqual({ kind: 'switch' });
  });

  it('re-targets its own pending switch when the default changed again', () => {
    const newer: ImDefaultRoute = { ...NEW, model: 'gpt-5.6' };
    expect(
      decide({
        record: record({ pendingRoute: NEW }),
        current: OLD,
        target: newer,
        pendingIntent: NEW,
      }),
    ).toEqual({ kind: 'switch' });
  });

  it('drops its own stale pending switch when the default moved back', () => {
    expect(
      decide({
        record: record({ pendingRoute: NEW }),
        current: OLD,
        target: OLD,
        pendingIntent: NEW,
      }),
    ).toEqual({ kind: 'adopt', cancelPendingIntent: true });
  });

  it('keeps following after its pending switch was lost (restart) or already applied', () => {
    const newer: ImDefaultRoute = { ...NEW, model: 'gpt-5.6' };
    // 意图丢失: 任务仍在记录的旧路由上。
    expect(
      decide({ record: record({ pendingRoute: NEW }), current: OLD, target: newer }),
    ).toEqual({ kind: 'switch' });
    // 意图已被发送路径应用, 记录尚未更新, 默认又变了。
    expect(
      decide({ record: record({ pendingRoute: NEW }), current: NEW, target: newer }),
    ).toEqual({ kind: 'switch' });
  });

  it('compares providers through the normalizer', () => {
    const pinnedOld = { ...OLD, providerId: 'xd' };
    const normalizeProvider = (route: ImDefaultRoute) => route.providerId ?? 'xd';
    expect(decide({ record: record(), current: pinnedOld, target: NEW })).toEqual({ kind: 'manual' });
    expect(
      decide({ record: record(), current: pinnedOld, target: NEW, normalizeProvider }),
    ).toEqual({ kind: 'switch' });
  });
});
