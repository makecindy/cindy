// Guard tier: engineering-conventions section 3.2. Existing cross-file
// credential, permission, protocol, race, and design contracts are isolated
// from runtime unit tests. No new input or assertion is introduced here.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('注入接线(源码级守卫)', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/maker-ipc/makerSendTransaction.ts'),
    'utf8',
  );

  it('说明只进 wire payload,落库走 persistUserMessage.content', () => {
    expect(source).toContain(
      'deps.isMobileClientInvoke?.() === true || so.fromMobileClient === true',
    );
    // 注入链:normalized → withHandoff → withPlanReconcile → withGoalInactiveNote
    // → 来源说明 → 客户端说明(元信息都在交接段之前)。
    expect(source).toContain('prependNoteToWireUserMessage(withGoalInactiveNote as HandoffWireMessage, messageSourceNote)');
    // 环境说明经 wireNoteMemory 去重后再前置(内容没变就不重复),链路位置不变。
    expect(source).toContain("prependNoteToWireUserMessage(withSourceNote as HandoffWireMessage, plannedNotes['client-environment'])");
    expect(source).toContain('deps.planRepeatableWireNotes?.(sessionId, repeatableNotes, { force: pendingHandoff !== null })');
    expect(source).toContain('readWireSourceDevice(so.sourceDevice)');
    expect(source).toContain('shouldPrependMobileClientPromptNote(normalized, sess.agentKind)');
    // 落库内容必须仍取 persistUserMessage.content —— 若改成 outgoing,提示语会写进
    // 用户消息、污染界面显示的原话。
    expect(source).toContain('content: persistUserMessage.content');
    expect(source).not.toMatch(/content:\s*outgoing/);
  });

  it('来源判据经 deps 注入,不在事务里直接 import ALS', () => {
    // 只看 import 与调用形态 —— deps 字段的注释里会提到这个函数名,那不算直连。
    expect(source).not.toMatch(/from '\.\.\/device-link\/invoke-context/);
    expect(source).not.toMatch(/isMobileControllerInvoke\s*\(/);
  });

  it('注释不得把平台值说成安全边界(平台由对端 hello 自报,无服务端校验)', () => {
    const files = [
      'src/main/device-link/invoke-context.ts',
      'src/main/device-link/controllerPlatform.ts',
      'src/main/maker-ipc/makerSendTransaction.ts',
    ].map((rel) => readFileSync(resolve(process.cwd(), rel), 'utf8'));
    for (const text of files) {
      expect(text).not.toContain('不可伪造');
    }
    // 三处都必须显式声明它只用于体验分流。
    expect(files[0]).toContain('不是安全 / 鉴权 / 权限边界');
    expect(files[1]).toContain('仅体验分流,不是安全边界');
    expect(files[2]).toContain('不是安全判据');
  });

  it('装配处每次调用现取,不提前求值缓存', () => {
    const register = readFileSync(
      resolve(process.cwd(), 'src/main/maker-ipc/register.ts'),
      'utf8',
    );
    expect(register).toContain('isMobileClientInvoke: () => isMobileControllerInvoke()');
  });
});


describe('排队 / 插入两条路径的接线(源码级守卫)', () => {
  const register = readFileSync(resolve(process.cwd(), 'src/main/maker-ipc/register.ts'), 'utf8');
  const coordinator = readFileSync(
    resolve(process.cwd(), 'src/main/maker-ipc/agent-input-coordinator.ts'),
    'utf8',
  );
  const transaction = readFileSync(
    resolve(process.cwd(), 'src/main/maker-ipc/makerSendTransaction.ts'),
    'utf8',
  );
  const sendHandler = readFileSync(
    resolve(process.cwd(), 'src/main/maker-ipc/sessionSendHandler.ts'),
    'utf8',
  );

  it('enqueue 与 steer 两个 IPC 边界都盖章,编辑时按编辑者重新盖章', () => {
    // 手机会话页所有发送都走这两条,只在 invoke context 里读来源实际读不到(review P1)。
    // 第三处是排队编辑(两个编辑入口共用 stampQueuedEditProvenance)。
    const stamps = register.match(/stampMobileClientOrigin\(/g) ?? [];
    expect(stamps.length).toBe(3);
    expect(register.match(/stampQueuedEditProvenance\(updated, remote, editor\)/g)?.length).toBe(2);
    expect(register).toContain('isMobileControllerInvoke(),');
  });

  it('device-link provenance is stamped at both queue input boundaries', () => {
    const stamps = register.match(/stampTrustedDeviceLinkQueuedOrigin\(/g) ?? [];
    expect(stamps.length).toBe(3);
    expect(register).toContain('deviceLinkInvoke,');
    // 设备来源与 device-link 标记同点盖章(两处 IPC 边界)。
    expect(register.match(/deviceLinkInvoke,\r?\n\s+readDeviceLinkInvokeSourceDevice\(\),/g)?.length).toBe(2);
  });

  it('直连 maker:send / maker:steer 在 IPC 边界按 invoke context 盖设备来源', () => {
    expect(register.match(/stampDirectSendSourceDevice\([^)]*readDeviceLinkInvokeSourceDevice\(\)\)/g)?.length).toBe(2);
  });

  it('coordinator 在 drain 与 steer 两处都透传设备来源', () => {
    expect(coordinator).toContain('...(head.sourceDevice ? { sourceDevice: head.sourceDevice } : {})');
    expect(coordinator).toContain('...(item.sourceDevice ? { sourceDevice: item.sourceDevice } : {})');
    expect(coordinator).toContain('...(!isHostGeneratedSteerItem(item) && item.origin ? { sourceOrigin: item.origin } : {})');
  });

  it('coordinator 在 drain 与 steer 两处都透传', () => {
    const passes = coordinator.match(/fromMobileClient: true \} : \{\}\)/g) ?? [];
    expect(passes.length).toBe(2);
  });

  it('coordinator drain carries device-link provenance into the send transaction', () => {
    expect(coordinator).toContain('fromDeviceLinkClient: true } : {})');
    expect(transaction).toContain('requestedSendOpts.fromDeviceLinkClient === true');
  });

  it('send 事务认 async context 与透传值两个来源', () => {
    expect(transaction).toContain(
      "deps.isMobileClientInvoke?.() === true || so.fromMobileClient === true",
    );
  });

  it('steer 投递也注入说明,且只进 wire payload', () => {
    expect(register).toContain("isMobileControllerInvoke() || so.fromMobileClient === true");
    expect(register).toContain('shouldPrependMobileClientPromptNote(normalized, sess.agentKind)');
    expect(register).toContain('prependNoteToWireUserMessage(normalized as HandoffWireMessage, steerSourceNote)');
    // steer 与 send 事务共用同一份环境说明去重记忆,投递成功后才记为已发送。
    expect(register).toContain("prependNoteToWireUserMessage(withSteerSourceNote as HandoffWireMessage, steerPlannedNotes['client-environment'])");
    expect(register).toContain('steerNotePlan?.commit()');
    expect(register).toContain('readWireSourceDevice(so.sourceDevice)');
    expect(register).toContain('await sess.steer(steerPayload as never');
  });

  it('直连 maker:send 的 wire sendOpts 必须消毒', () => {
    expect(sendHandler).toContain(
      'attachMainOwnedInputBoundary(sendOpts, mainOwnedBoundaryStamp)',
    );
  });

  it('直连 maker:steer 的 wire sendOpts 同样必须消毒', () => {
    // 这个 channel 在 device-link allowlist 里开放,sendOpts 是调用方可控输入 ——
    // 不剥的话传 `{ fromMobileClient: true }` 就能让非手机轮次收到伪造的手机说明
    // (review P1/P2 各报一次)。契约与 maker:send 一致:该字段只由 main 盖章。
    expect(register).toContain(
      'const sanitizedSendOpts = attachMainOwnedInputBoundary(',
    );
    expect(register).toContain('stripMainOnlySendOpts(sendOpts)');
    // coordinator 的内部调用**不得**被消毒 —— 那条路的 sendOpts 是 main 构造的透传值。
    expect(register).toContain('steerToAgent: (sessionId, message, sendOpts) => {');
    expect(register).toContain('const expectedText = trustedDesktopSteerText.getStore();');
  });
});
