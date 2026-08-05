/**
 * device-link 远控输入 → 自动起名的**接线契约**。
 *
 * 起名核心逻辑由 sessionAutoTitle.test.ts 覆盖;这里只锁 register.ts 里两条远控
 * 输入路径都真的接上了它:INPUT_ENQUEUE(排队发送)与 INPUT_STEER(插话)。
 * 只接了入队的话,用户趁这一轮还在跑用插话写下的第一句话不会改名,标题会一直停在
 * 首条纯附件消息的合成占位上(PR #510 review P1)。
 *
 * register.ts 是超大 handler 注册文件、没有可注入的测试入口,repo 里既有的做法
 * 就是对源码断言(见 interruptedContinuationContract.test.ts)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'register.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');
const sessionsSource = readFileSync(
  resolve(__dirname, '..', 'localDb', 'ipc', 'sessions.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

function handlerBody(channel: string, nextChannel: string): string {
  const start = registerSource.indexOf(`ipcMain.handle(MAKER_INVOKE.${channel}`);
  const end = registerSource.indexOf(`ipcMain.handle(MAKER_INVOKE.${nextChannel}`, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return registerSource.slice(start, end);
}

describe('device-link auto-title wiring', () => {
  it('入队与插话两条路径都调用起名准备', () => {
    expect(handlerBody('INPUT_ENQUEUE', 'INPUT_COMPACT')).toMatch(
      /await prepareDeviceLinkAutoTitle\(\s*sid\s*,\s*queued\s*\)/,
    );
    expect(handlerBody('INPUT_STEER', 'INPUT_STOP')).toMatch(
      /await prepareDeviceLinkAutoTitle\(\s*sid\s*,\s*queued\s*\)/,
    );
  });

  it('入队:调度发生在 coordinator 接受之后', () => {
    // enqueue 是同步的、不会拒绝(重复 clientId 也只是幂等返回),排在它之后即可。
    const body = handlerBody('INPUT_ENQUEUE', 'INPUT_COMPACT');
    const acceptAt = body.indexOf('inputCoordinator.enqueue');
    const commitAt = body.indexOf('commitAutoTitle()');
    expect(acceptAt).toBeGreaterThan(-1);
    expect(commitAt).toBeGreaterThan(acceptAt);
  });

  it('插话:等 steer 落定且受理了才调度', () => {
    // steer 会因同会话已有在飞 steer / Stop 边界 / 输入锁返回 false。被拒的文本
    // 改掉默认名 / 合成占位 / fork 占位就是凭空改名(review P1)。
    const body = handlerBody('INPUT_STEER', 'INPUT_STOP');
    expect(body).toMatch(/const accepted = await inputCoordinator\.steer\(/);
    expect(body).toMatch(/if \(accepted\) commitAutoTitle\(\);/);
    const acceptAt = body.indexOf('await inputCoordinator.steer(');
    expect(body.indexOf('commitAutoTitle()')).toBeGreaterThan(acceptAt);
  });

  it('只对远控调用生效:本机 renderer 走 maker:auto-title,不在这里重复起名', () => {
    const start = registerSource.indexOf('const prepareDeviceLinkAutoTitle =');
    expect(start).toBeGreaterThan(-1);
    const body = registerSource.slice(start, registerSource.indexOf('\n  };', start));
    expect(body).toMatch(/if \(!isDeviceLinkInvoke\(\)\) return noop;/);
    // 预检失败按「要起名」放行:一次 DB 抖动不该让标题永久停在 New Maker。
    expect(body).toMatch(/eligible = true;/);
  });
});

describe('user rename notification ordering', () => {
  it('三条改名出口都在写库**之前**记号', () => {
    // 写库是一次 worker RPC 往返:改名提交与拿到回执之间有真实时间差,期间并发的
    // 智能标题仍能满足 `WHERE title = 期望值` 把用户刚保存的名字盖掉(review P1)。
    for (const [note, write] of [
      // local-db:sessions:update(本机重命名框)
      ["if (typeof p.title === 'string') noteUserTitleWritten(sid);",
       'await db.update(sessions).set(setObj).where(eq(sessions.id, sid));'],
      // patchSessionMetaInDb(device-link 远程改名)
      ['if (patch.title !== undefined) noteUserTitleWritten(sessionId);',
       'await db.update(sessions).set(setObj).where(eq(sessions.id, sessionId));'],
      // renameSessionTitlesInDb(MCP 批量改名)
      ['for (const change of changes) noteUserTitleWritten(change.sessionId);',
       "getDbClient()\n    .tx('sessions.renameTitles'"],
    ] as const) {
      const noteAt = sessionsSource.indexOf(note);
      expect(noteAt).toBeGreaterThan(-1);
      const writeAt = sessionsSource.indexOf(write, noteAt);
      expect(writeAt).toBeGreaterThan(noteAt);
    }
  });

  it('自动起名自己的写入不发改名记号(否则一起名就自我禁用)', () => {
    const start = sessionsSource.indexOf('export async function persistSessionTitleIfStillDraft');
    const end = sessionsSource.indexOf('export async function clearSessionContextInDb', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(sessionsSource.slice(start, end)).not.toContain('noteUserTitleWritten');
  });
});
