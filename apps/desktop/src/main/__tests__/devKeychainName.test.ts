/**
 * devKeychainName — 隔离 dev 实例的钥匙串条目隔离语义(#871 候选 B 收窄)。
 *
 * 关键不变量:
 *  - 有标记按标记粘住;标记不可读/内容不可识别 = 身份不确定 → abort(静默回退
 *    默认身份会用错钥匙覆盖既有密文)。absent 仅代表确证 ENOENT。
 *  - 无标记且有真实数据(排除标记自身产物)→ 复查标记后判旧沙箱。
 *  - 无标记且为空 → 原子认领;输掉竞态以胜者完整标记为准;认领写失败(非 EEXIST)
 *    同样 abort——并发对手可能恰好认领成功,keep-default 会让同一 profile 双身份。
 *  - 覆写目录的非认领启动 = 观察模式:绝不认领 CindyDev,有标记依标记(不可读/
 *    不可识别同样 abort);空 profile 原子认领默认身份,输家依胜者标记——身份在
 *    两种模式下都原子落定,并发启动不分叉。
 *  - packaged / 无目录覆写的 dev 一律默认名。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ISOLATED_AUTH_LAUNCH_PROOF_FILE,
  isDevProfileFreshnessArtifact,
  isKeychainIdentityMarkerArtifact,
  resolveDevKeychainDecision,
  type KeychainIdentityIo,
  type KeychainMarkerRead,
} from '../devKeychainName.js';

const ABSENT: KeychainMarkerRead = { kind: 'absent' };
const DEV: KeychainMarkerRead = { kind: 'present', value: 'CindyDev\n' };

function io(overrides: Partial<KeychainIdentityIo>): KeychainIdentityIo {
  return {
    readMarker: () => ABSENT,
    claimMarker: () => 'claimed',
    profileHasData: () => false,
    flushProfileDir: () => true,
    ...overrides,
  };
}

const base = { isPackaged: false, isolated: true, hasDirOverride: true };

describe('resolveDevKeychainDecision', () => {
  it('有标记 = CindyDev → 跨重启粘住,不看目录内容', () => {
    expect(
      resolveDevKeychainDecision({
        ...base,
        io: io({ readMarker: () => DEV, profileHasData: () => true }),
      }),
    ).toEqual({ kind: 'rename', appName: 'CindyDev' });
  });

  it('标记不可读(非 ENOENT)→ abort,不得静默回退默认身份(review 反馈 P1 第七轮)', () => {
    // 沙箱可能已有按 CindyDev 主密钥加密的密文;暂时读不出标记时用默认身份写入
    // 会用错钥匙覆盖它们。
    const d = resolveDevKeychainDecision({
      ...base,
      io: io({ readMarker: () => ({ kind: 'unreadable' }) }),
    });
    expect(d.kind).toBe('abort');
  });

  it('标记内容为空、不可识别或缺终止换行(写到一半的前缀)→ abort(身份不确定)', () => {
    // 'Cindy' 无换行 = O_EXCL 回退里 "CindyDev\n" 写到第 5 字节的并发读快照,
    // 也可能是完整默认标记缺了换行——两者读侧无法区分,统一按身份不确定 abort
    // (review 反馈 P1 第十八轮:只 trim 会把该前缀当完整默认身份接受,双身份分裂)。
    // 剥离规则严格到恰好一个末尾换行:多余换行/空白被 trim 洗成合法身份会让
    // 损坏/手改内容的判定不再确定(review 反馈第二十轮)。
    for (const value of [
      '',
      'SomethingElse',
      'Cindy',
      'CindyDev',
      'SomethingElse\n',
      'CindyDev\n\n',
      ' Cindy \n',
      '\n',
    ]) {
      const d = resolveDevKeychainDecision({
        ...base,
        io: io({ readMarker: () => ({ kind: 'present', value }) }),
      });
      expect(d.kind, JSON.stringify(value)).toBe('abort');
      // 不回显原文:reason 只含元数据,不得把标记内容带进 stderr/日志
      // (review 反馈 P2 第二十七轮)。
      if (d.kind === 'abort' && value.trim().length > 0) {
        expect(d.reason).not.toContain(value.trim());
      }
    }
  });

  it('Windows 编辑器手工修复(\r\n 结尾)按恰好一个换行剥离,照常接受', () => {
    expect(
      resolveDevKeychainDecision({
        ...base,
        io: io({ readMarker: () => ({ kind: 'present', value: 'CindyDev\r\n' }) }),
      }),
    ).toEqual({ kind: 'rename', appName: 'CindyDev' });
  });

  it('全新沙箱 → 原子认领成功后改名', () => {
    const claim = vi.fn<KeychainIdentityIo['claimMarker']>(() => 'claimed');
    expect(resolveDevKeychainDecision({ ...base, io: io({ claimMarker: claim }) })).toEqual({
      kind: 'rename',
      appName: 'CindyDev',
    });
    expect(claim).toHaveBeenCalledWith('CindyDev');
  });

  it('认领输掉竞态(EEXIST)→ 以胜者完整标记为准', () => {
    const reads = vi
      .fn<KeychainIdentityIo['readMarker']>()
      .mockReturnValueOnce(ABSENT)
      .mockReturnValueOnce(DEV);
    expect(
      resolveDevKeychainDecision({
        ...base,
        io: io({ readMarker: reads, claimMarker: () => 'exists' }),
      }),
    ).toEqual({ kind: 'rename', appName: 'CindyDev' });
  });

  it('认领竞态后标记消失/不可读 → abort(身份不确定)', () => {
    for (const second of [ABSENT, { kind: 'unreadable' } as const]) {
      const reads = vi
        .fn<KeychainIdentityIo['readMarker']>()
        .mockReturnValueOnce(ABSENT)
        .mockReturnValueOnce(second);
      const d = resolveDevKeychainDecision({
        ...base,
        io: io({ readMarker: reads, claimMarker: () => 'exists' }),
      });
      expect(d.kind, second.kind).toBe('abort');
    }
  });

  it('认领写失败(非 EEXIST)→ abort(并发对手可能已认领成功,keep-default 会双身份)', () => {
    const d = resolveDevKeychainDecision({ ...base, io: io({ claimMarker: () => 'error' }) });
    expect(d.kind).toBe('abort');
  });

  it('无标记且有数据:复查到对手标记 → 与对手一致(并发首启不分叉)', () => {
    const reads = vi
      .fn<KeychainIdentityIo['readMarker']>()
      .mockReturnValueOnce(ABSENT)
      .mockReturnValueOnce(DEV);
    expect(
      resolveDevKeychainDecision({
        ...base,
        io: io({ readMarker: reads, profileHasData: () => true }),
      }),
    ).toEqual({ kind: 'rename', appName: 'CindyDev' });
  });

  it('无标记且有数据,复查确证 absent = 真旧沙箱 → 永久默认名', () => {
    expect(
      resolveDevKeychainDecision({ ...base, io: io({ profileHasData: () => true }) }),
    ).toEqual({ kind: 'keep-default' });
  });

  it('无目录覆写的 dev 与 packaged → 一律默认名,不做任何 IO', () => {
    const reads = vi.fn<KeychainIdentityIo['readMarker']>(() => DEV);
    expect(
      resolveDevKeychainDecision({
        isPackaged: false,
        isolated: false,
        hasDirOverride: false,
        io: io({ readMarker: reads }),
      }),
    ).toEqual({ kind: 'keep-default' });
    expect(
      resolveDevKeychainDecision({
        isPackaged: true,
        isolated: true,
        hasDirOverride: true,
        io: io({ readMarker: reads }),
      }),
    ).toEqual({ kind: 'keep-default' });
    expect(reads).not.toHaveBeenCalled();
  });
});

describe('覆写目录的非认领启动 = 观察模式(review 反馈 P1 第十四/十五轮)', () => {
  // 裸 XDT_USER_DATA_DIR 指向已按 CindyDev 认领的 -dev2 沙箱是受支持形态:
  // 缺隔离旗标不能成为跳过标记、以默认身份打开同一 profile 的理由。
  const observe = { isPackaged: false, isolated: false, hasDirOverride: true };

  it('目录已带 CindyDev 标记 → 依标记以 CindyDev 打开(先 flush 确认)', () => {
    const flush = vi.fn<KeychainIdentityIo['flushProfileDir']>(() => true);
    expect(
      resolveDevKeychainDecision({
        ...observe,
        io: io({ readMarker: () => DEV, flushProfileDir: flush }),
      }),
    ).toEqual({ kind: 'rename', appName: 'CindyDev' });
    expect(flush).toHaveBeenCalled();
  });

  it('标记存在但 flush 失败 / 不可读 / 内容不可识别 → 同样 abort', () => {
    const cases: Array<Partial<KeychainIdentityIo>> = [
      { readMarker: () => DEV, flushProfileDir: () => false },
      { readMarker: () => ({ kind: 'unreadable' }) },
      { readMarker: () => ({ kind: 'present', value: 'SomethingElse' }) },
    ];
    for (const overrides of cases) {
      expect(resolveDevKeychainDecision({ ...observe, io: io(overrides) }).kind).toBe('abort');
    }
  });

  it('空 profile → 原子认领默认身份,不与并发隔离启动分叉(review 反馈 P1 第十五轮)', () => {
    // 若空 profile 直接 keep-default 而不落标记,并发隔离启动可在其后认领 CindyDev,
    // 两个进程对同一 profile 以两种身份写密文。
    const claim = vi.fn<KeychainIdentityIo['claimMarker']>(() => 'claimed');
    expect(
      resolveDevKeychainDecision({ ...observe, io: io({ claimMarker: claim }) }),
    ).toEqual({ kind: 'keep-default' });
    expect(claim).toHaveBeenCalledWith('Cindy');
  });

  it('认领输给并发隔离启动(EEXIST)→ 依胜者标记以 CindyDev 打开', () => {
    const reads = vi
      .fn<KeychainIdentityIo['readMarker']>()
      .mockReturnValueOnce(ABSENT)
      .mockReturnValueOnce(DEV);
    expect(
      resolveDevKeychainDecision({
        ...observe,
        io: io({ readMarker: reads, claimMarker: () => 'exists' }),
      }),
    ).toEqual({ kind: 'rename', appName: 'CindyDev' });
  });

  it('认领写失败(非 EEXIST)→ abort;有数据无标记的外来目录 → 默认名且不认领', () => {
    expect(
      resolveDevKeychainDecision({ ...observe, io: io({ claimMarker: () => 'error' }) }).kind,
    ).toBe('abort');
    const claim = vi.fn<KeychainIdentityIo['claimMarker']>(() => 'claimed');
    expect(
      resolveDevKeychainDecision({
        ...observe,
        io: io({ claimMarker: claim, profileHasData: () => true }),
      }),
    ).toEqual({ kind: 'keep-default' });
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('默认身份标记(词表第二项,review 反馈 P1 第十五轮)', () => {
  it('隔离启动打开已按默认身份落定的 profile → 依标记保持默认名(先 flush 确认)', () => {
    const flush = vi.fn<KeychainIdentityIo['flushProfileDir']>(() => true);
    expect(
      resolveDevKeychainDecision({
        ...base,
        io: io({ readMarker: () => ({ kind: 'present', value: 'Cindy\n' }), flushProfileDir: flush }),
      }),
    ).toEqual({ kind: 'keep-default' });
    expect(flush).toHaveBeenCalled();
  });

  it('隔离启动接受默认身份标记但 flush 失败 → 同样 abort(统一不变量)', () => {
    expect(
      resolveDevKeychainDecision({
        ...base,
        io: io({
          readMarker: () => ({ kind: 'present', value: 'Cindy\n' }),
          flushProfileDir: () => false,
        }),
      }).kind,
    ).toBe('abort');
  });
});

describe('接受观察到的标记前必须持久化确认(review 反馈 P1 第十三轮)', () => {
  it('初读命中标记但 flush 失败 → abort,不得以未持久化的身份写入', () => {
    const d = resolveDevKeychainDecision({
      ...base,
      io: io({ readMarker: () => DEV, flushProfileDir: () => false }),
    });
    expect(d.kind).toBe('abort');
  });

  it('有数据复查命中 / 认领竞态读到胜者标记,flush 失败同样 abort', () => {
    const recheckReads = vi
      .fn<KeychainIdentityIo['readMarker']>()
      .mockReturnValueOnce(ABSENT)
      .mockReturnValueOnce(DEV);
    expect(
      resolveDevKeychainDecision({
        ...base,
        io: io({
          readMarker: recheckReads,
          profileHasData: () => true,
          flushProfileDir: () => false,
        }),
      }).kind,
    ).toBe('abort');
    const raceReads = vi
      .fn<KeychainIdentityIo['readMarker']>()
      .mockReturnValueOnce(ABSENT)
      .mockReturnValueOnce(DEV);
    expect(
      resolveDevKeychainDecision({
        ...base,
        io: io({
          readMarker: raceReads,
          claimMarker: () => 'exists',
          flushProfileDir: () => false,
        }),
      }).kind,
    ).toBe('abort');
  });
});

describe('isKeychainIdentityMarkerArtifact', () => {
  it('标记文件与 .tmp 半成品是机制自身产物,不构成「旧沙箱证据」', () => {
    expect(isKeychainIdentityMarkerArtifact('keychain-identity')).toBe(true);
    expect(isKeychainIdentityMarkerArtifact('keychain-identity.12345.tmp')).toBe(true);
    expect(
      isKeychainIdentityMarkerArtifact(
        'keychain-identity.12345-8b3f2c1a-9d4e-4f6a-b7c8-0e1d2f3a4b5c.tmp',
      ),
    ).toBe(true);
    expect(isKeychainIdentityMarkerArtifact('cindy-user1.db')).toBe(false);
    expect(isKeychainIdentityMarkerArtifact('safe-storage')).toBe(false);
    expect(isKeychainIdentityMarkerArtifact('keychain-identity-notes.txt')).toBe(false);
  });

  it('launch proof 与原子临时文件不构成 profile 存量数据', () => {
    expect(isDevProfileFreshnessArtifact(ISOLATED_AUTH_LAUNCH_PROOF_FILE)).toBe(true);
    expect(
      isDevProfileFreshnessArtifact(`${ISOLATED_AUTH_LAUNCH_PROOF_FILE}.123-${'a'.repeat(64)}.tmp`),
    ).toBe(true);
    expect(isDevProfileFreshnessArtifact(`${ISOLATED_AUTH_LAUNCH_PROOF_FILE}.notes`)).toBe(false);
  });
});
