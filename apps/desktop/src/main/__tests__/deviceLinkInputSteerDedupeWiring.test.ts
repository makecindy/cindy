/**
 * device-link INPUT_STEER 的幂等接线契约。
 *
 * coordinator 覆盖运行期状态机；register.ts 还必须在附件物化前以及最后一个
 * await 后识别 queued-row promotion 的弱网重传，否则两个同 clientId 请求可
 * 分别生成附件 owner，重复请求会覆盖首个请求的 current owner。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'register.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

function inputSteerHandlerBody(): string {
  const start = registerSource.search(/ipcMain\.handle\(\s*MAKER_INVOKE\.INPUT_STEER/);
  const next = registerSource
    .slice(start + 1)
    .search(/ipcMain\.handle\(\s*MAKER_INVOKE\.INPUT_STOP/);
  expect(start).toBeGreaterThan(-1);
  expect(next).toBeGreaterThan(-1);
  return registerSource.slice(start, start + 1 + next);
}

describe('device-link INPUT_STEER dedupe wiring', () => {
  it('rechecks duplicate ownership before materialisation and owner activation', () => {
    const body = inputSteerHandlerBody();
    const duplicateCheckAt = body.indexOf('const isKnownSteerDuplicate =');
    const duplicateCalls = [...body.matchAll(/isKnownSteerDuplicate\(\)/g)].map(
      (match) => match.index ?? -1,
    );
    const durableAt = body.indexOf('await remoteInputClientIdWasPersisted', duplicateCheckAt);
    const pendingAt = body.indexOf('const steeringStoredQueueItem =', durableAt);
    const materializeAt = body.indexOf('await materializeQueuedOssAttachmentsDeferred', durableAt);
    const activateAt = body.indexOf(
      'queuedAttachmentOwnership.activateCurrentOwner',
      materializeAt,
    );

    expect(duplicateCheckAt).toBeGreaterThan(-1);
    expect(duplicateCalls).toHaveLength(3);
    expect(duplicateCalls[0]).toBeLessThan(durableAt);
    expect(duplicateCalls[1]).toBeGreaterThan(durableAt);
    expect(duplicateCalls[1]).toBeLessThan(materializeAt);
    expect(pendingAt).toBeGreaterThan(duplicateCalls[1] ?? -1);
    expect(materializeAt).toBeGreaterThan(durableAt);
    expect(duplicateCalls[2]).toBeGreaterThan(materializeAt);
    expect(duplicateCalls[2]).toBeLessThan(activateAt);
    expect(body.slice(duplicateCalls[2], activateAt)).toContain(
      'await materialized.cleanupBeforeAcceptance?.()',
    );
    expect(body.slice(duplicateCalls[2], activateAt)).toContain(
      'await discardSpecificQueuedAttachmentOwnership',
    );
  });
});
