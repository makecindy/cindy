import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const userDataDir = '/tmp/native-provider-auth-binding-test';
const session = { dataOwnerId: 'owner-a' as string | null, boundaryPending: false };

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({
    mode: session.dataOwnerId ? 'cloud' : 'signed-out',
    dataOwnerId: session.dataOwnerId,
    generation: 1,
  }),
  isAppSessionBoundaryPending: () => session.boundaryPending,
}));

import {
  bindNativeProviderAuth,
  claimDetectedNativeProviderAuth,
  isNativeProviderAuthBound,
  isNativeProviderAuthSelfAuthorized,
  migrateLegacyNativeProviderAuthBindings,
  unbindNativeProviderAuth,
} from '../nativeProviderAuthBinding.js';

const bindingFile = path.join(userDataDir, 'native-provider-auth.json');

afterEach(() => {
  session.dataOwnerId = 'owner-a';
  session.boundaryPending = false;
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('native provider auth legacy binding', () => {
  it('claims available legacy credentials for the first owner only', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', {
      anthropic: true,
      openai: false,
    });

    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    session.dataOwnerId = 'owner-b';
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      anthropic: 'owner-a',
      legacyClaimOwner: 'owner-a',
    });
  });

  it('does not reclaim a legacy credential after logout', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', { xai: true });
    unbindNativeProviderAuth('xai');
    session.dataOwnerId = 'owner-b';
    migrateLegacyNativeProviderAuthBindings('owner-b', { xai: true });

    expect(isNativeProviderAuthBound('xai')).toBe(false);
  });
});

describe('claimDetectedNativeProviderAuth', () => {
  it('repairs the binding when the one-shot migration consumed the claim before the credential appeared', () => {
    // 复现主 bug:legacy 迁移在 reconcile 硬链建立之前跑掉,openai 名额以 false 被消费。
    migrateLegacyNativeProviderAuthBindings('owner-a', { openai: false });
    expect(isNativeProviderAuthBound('openai')).toBe(false);

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(isNativeProviderAuthBound('openai')).toBe(true);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      openai: 'owner-a',
      legacyClaimOwner: 'owner-a',
    });
  });

  it('claims for the current owner when no legacy claim ever ran (local mode path)', () => {
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({ openai: 'owner-a' });
  });

  it('stays fail-closed for an account that did not win the legacy claim', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', {});
    session.dataOwnerId = 'owner-b';

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
    expect(isNativeProviderAuthBound('openai')).toBe(false);
  });

  it('never overwrites a binding held by another owner', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', { openai: true });
    session.dataOwnerId = 'owner-b';

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
    session.dataOwnerId = 'owner-a';
    expect(isNativeProviderAuthBound('openai')).toBe(true);
  });

  it('writes nothing without a committed owner or without a credential', () => {
    session.dataOwnerId = null;
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);

    session.dataOwnerId = 'owner-a';
    expect(claimDetectedNativeProviderAuth('openai', () => false)).toBe(false);
    expect(fs.existsSync(bindingFile)).toBe(false);
  });

  it('writes nothing while a session boundary is in flight', () => {
    // owner 正在被换掉:此刻写入等于把上一个账号的凭证交给下一个账号。
    session.boundaryPending = true;
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(fs.existsSync(bindingFile)).toBe(false);

    session.boundaryPending = false;
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
  });

  it('claims anthropic and xai on the same terms as openai', () => {
    // 三家 native provider 共用一套认领口径:凭证在场 + 名额未被占 → 绑给当前 owner。
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
    expect(claimDetectedNativeProviderAuth('xai', () => true)).toBe(true);
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    expect(isNativeProviderAuthBound('xai')).toBe(true);

    session.dataOwnerId = 'owner-b';
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
  });

  it('显式登出留下的撤销标记挡住自动认领(凭证删除失败也不会被绑回来)', () => {
    // 登出会先删凭证再解绑,但删除是 best-effort 的;删失败时 slot 已空、凭证还在,
    // 没有标记就会在下一次读连接态时被认领回来,等于悄悄撤销用户刚做的登出。
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
    unbindNativeProviderAuth('anthropic', { revoked: true });

    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      revoked: { anthropic: 'owner-a' },
    });
  });

  it('撤销标记跨 owner 依然有效 —— 残留凭证仍属于登出的那个账号', () => {
    // 按 owner 比对会给下一个账号开继承别人凭证的口子:凭证在共享的系统 keychain / CLI
    // 里,换个 owner 它还是 A 的凭证(PR #548 review)。
    unbindNativeProviderAuth('anthropic', { revoked: true });
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);

    session.dataOwnerId = 'owner-b';
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
  });

  it('一次性 legacy 迁移同样尊重撤销标记', () => {
    unbindNativeProviderAuth('anthropic', { revoked: true });
    session.dataOwnerId = 'owner-b';
    migrateLegacyNativeProviderAuthBindings('owner-b', { anthropic: true, xai: true });

    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    // 没被撤销的 provider 不受影响。
    expect(isNativeProviderAuthBound('xai')).toBe(true);
  });

  it('用户再次显式授权即清除撤销标记,恢复自动继承语义', () => {
    unbindNativeProviderAuth('xai', { revoked: true });
    expect(claimDetectedNativeProviderAuth('xai', () => true)).toBe(false);

    bindNativeProviderAuth('xai');
    expect(isNativeProviderAuthBound('xai')).toBe(true);
    unbindNativeProviderAuth('xai');
    // 上一次的撤销标记已随显式授权作废,这次(非显式登出)不该再挡。
    expect(claimDetectedNativeProviderAuth('xai', () => true)).toBe(true);
  });

  it('凭证失效(非用户登出)不留标记 —— 本机重新登录后仍按设计自动继承', () => {
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
    unbindNativeProviderAuth('anthropic'); // invalidate 路径:不传 revoked

    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).not.toHaveProperty('revoked');
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
  });

  it('绑定文件读不出来时不认领,也不覆盖它', () => {
    // 「归属信息丢失」不等于「没人绑过」。把损坏当空,等于在最不该下判断的时刻把共享
    // keychain 里的凭证判给当前账号,随后的写入还会把原有归属彻底盖掉(PR #548 review)。
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, '{ this is not json');

    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(fs.readFileSync(bindingFile, 'utf8')).toBe('{ this is not json');

    // 一次性 legacy 迁移同样不推进 —— 它还会顺手消费掉 legacyClaimOwner 名额。
    migrateLegacyNativeProviderAuthBindings('owner-a', { anthropic: true });
    expect(fs.readFileSync(bindingFile, 'utf8')).toBe('{ this is not json');

    // JSON 合法但根不是对象(数组 / 标量)同样按不可读处理。
    fs.writeFileSync(bindingFile, '["owner-a"]');
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
  });

  it('绑定文件读不出来时,显式登出也不覆盖它', () => {
    // 用户要的是「登出这一个 provider」。覆盖损坏文件 = 写出一份只剩撤销标记的新文件,
    // 其余 provider 从此无主,下一次可信读取就会把它们的残留凭证认领给当前账号 ——
    // 正是上一条刚堵掉的那个洞的另一个入口(PR #548 review)。
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, '{ this is not json');

    unbindNativeProviderAuth('anthropic', { revoked: true });
    expect(fs.readFileSync(bindingFile, 'utf8')).toBe('{ this is not json');
    // 不写标记不等于放开:同一条件下认领本来就被拒,用户看到的也一直是未连接。
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
  });

  it('revoked 字段被改坏时按不可读处理,而不是抛穿', () => {
    // `provider in bindings.revoked` 的右操作数是原始值时直接抛 TypeError —— 一个手工
    // 改坏的字段会让认领、迁移、登出全炸在这里(PR #548 review)。
    fs.mkdirSync(userDataDir, { recursive: true });
    for (const bad of ['{"revoked":"anthropic"}', '{"revoked":1}', '{"revoked":["anthropic"]}']) {
      fs.writeFileSync(bindingFile, bad);
      expect(() => claimDetectedNativeProviderAuth('anthropic', () => true)).not.toThrow();
      expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
      expect(() => unbindNativeProviderAuth('anthropic', { revoked: true })).not.toThrow();
      expect(() => migrateLegacyNativeProviderAuthBindings('owner-a', { anthropic: true })).not.toThrow();
      expect(fs.readFileSync(bindingFile, 'utf8')).toBe(bad); // 一律不改写
    }

    // 用户再次显式授权仍能把文件修回来 —— 否则坏字段会把这个 provider 永久锁死。
    fs.writeFileSync(bindingFile, '{"revoked":"anthropic"}');
    expect(() => bindNativeProviderAuth('anthropic')).not.toThrow();
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
  });

  it('整份读不出来时,显式授权也不写出一份「只有我」的干净文件', () => {
    // legacyClaimOwner 与各家 owner 一起没了,无可保留;但就这么写一份干净文件,等于让其余
    // provider 的残留凭证在文件恢复可读后立刻可被认领(PR #548 review)。
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, '{ not json at all');

    bindNativeProviderAuth('xai');
    const after = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
    expect(after.xai).toBe('owner-a');
    expect(after.revoked).toMatchObject({ anthropic: 'owner-a', openai: 'owner-a' });
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(false);
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
  });

  it('修 revoked 时保住别人的归属,并对其余 provider 保守抑制', () => {
    // 直接重写成「只有本次授权的这家」会抹掉 openai 的 owner-b,那份残留凭证下一次就会被
    // 认领给 owner-a —— 用一次修复换来一个新的越权口子(PR #548 review)。
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ openai: 'owner-b', revoked: 1 }));

    bindNativeProviderAuth('anthropic');
    const after = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
    expect(after.openai).toBe('owner-b'); // 别人的归属原样保留
    expect(after.anthropic).toBe('owner-a');

    // 坏掉的 revoked 无从得知谁被撤销过,不能直接丢弃(丢弃 = 给所有残留凭证放行)。
    expect(after.revoked).toMatchObject({ openai: 'owner-a', xai: 'owner-a' });
    expect(after.revoked).not.toHaveProperty('anthropic');
    expect(claimDetectedNativeProviderAuth('xai', () => true)).toBe(false);
    // 本次授权的这家不受抑制,且 owner-b 的 openai 依然轮不到 owner-a。
    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    expect(isNativeProviderAuthBound('openai')).toBe(false);
  });

  it('文件确实不存在 = 合法首次状态,照常认领', () => {
    // 与「读失败」必须分开:ENOENT 是全新安装的正常形态,挡掉它等于把自动继承整条废掉。
    expect(fs.existsSync(bindingFile)).toBe(false);
    expect(claimDetectedNativeProviderAuth('anthropic', () => true)).toBe(true);
  });

  it('treats corrupted falsy slot values as claimed-by-unknown and fails closed', () => {
    // 键存在但值为假(损坏 / 异常写入):按「归属不明」拒绝,绝不重认领。
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, JSON.stringify({ openai: '' }));
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);

    fs.writeFileSync(bindingFile, JSON.stringify({ legacyClaimOwner: '' }));
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toEqual({ legacyClaimOwner: '' });
  });
});

describe('凭证来路(selfAuthorized)—— 显式授权 vs 自动继承', () => {
  // 存在的理由:两者结果相同(绑到当前 owner、凭证可用),但用户可见文案的依据不同 ——
  // 「已沿用这台电脑上登录的账号」只对继承成立(PR #1076 review 第三轮)。

  it('显式授权记下来路,自动认领不记', () => {
    bindNativeProviderAuth('anthropic');
    expect(isNativeProviderAuthSelfAuthorized('anthropic')).toBe(true);

    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(isNativeProviderAuthSelfAuthorized('openai')).toBe(false);
  });

  it('来路按 provider 分别记账,不互相串味', () => {
    bindNativeProviderAuth('anthropic');
    expect(claimDetectedNativeProviderAuth('openai', () => true)).toBe(true);
    expect(isNativeProviderAuthSelfAuthorized('anthropic')).toBe(true);
    expect(isNativeProviderAuthSelfAuthorized('openai')).toBe(false);
  });

  it('登出清掉来路 —— 之后残留凭证对 Cindy 重新是「外部已有的」', () => {
    bindNativeProviderAuth('anthropic');
    expect(isNativeProviderAuthSelfAuthorized('anthropic')).toBe(true);

    unbindNativeProviderAuth('anthropic');
    expect(isNativeProviderAuthSelfAuthorized('anthropic')).toBe(false);
  });

  it('显式登出(带 revoked 标记)同样清掉来路', () => {
    bindNativeProviderAuth('openai');
    unbindNativeProviderAuth('openai', { revoked: true });
    expect(isNativeProviderAuthSelfAuthorized('openai')).toBe(false);
  });

  it('从没绑定过的 provider 不算自己授权过', () => {
    expect(isNativeProviderAuthSelfAuthorized('xai')).toBe(false);
  });

  it('绑定文件读不出来时保守按「自己授权过」——说不清来路就不要声称是继承', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(bindingFile, '{ this is not json');
    expect(isNativeProviderAuthSelfAuthorized('anthropic')).toBe(true);
  });
});
