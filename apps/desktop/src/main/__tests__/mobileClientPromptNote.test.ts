/**
 * 手机客户端说明:来源判据(体验分流用,**非**安全边界 —— 平台值由对端自报,见
 * device-link/invoke-context 的可信度说明)、wire 注入形态、以及「只进喂给 agent 的
 * 内容、不进落库原话」这条不变量的源码级守卫。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  clearControllerPlatforms,
  getControllerPlatform,
  isMobilePlatform,
  setControllerPlatform,
} from '../device-link/controllerPlatform';
import {
  isDeviceLinkInvoke,
  isMobileControllerInvoke,
  runDeviceLinkInvokeContext,
} from '../device-link/invoke-context';
import {
  prependHandoffToUserMessage,
  prependNoteToWireUserMessage,
} from '../maker-ipc/agentHandoff';
import {
  attachMainOwnedInputBoundary,
  buildMobileClientPromptNote,
  shouldPrependMobileClientPromptNote,
  stampMobileClientOrigin,
  stripMainOnlySendOpts,
} from '../maker-ipc/mobileClientPromptNote';

describe('isMobilePlatform(平台判据)', () => {
  it('手机平台为真', () => {
    expect(isMobilePlatform('ios')).toBe(true);
    expect(isMobilePlatform('android')).toBe(true);
  });

  it('桌面平台为假', () => {
    expect(isMobilePlatform('darwin')).toBe(false);
    expect(isMobilePlatform('win32')).toBe(false);
    expect(isMobilePlatform('linux')).toBe(false);
  });

  it('未知 / 缺失一律为假(fail-closed,不能靠 !isDesktopPlatform 取反)', () => {
    // presence 未到、旧客户端报了别的字符串时,平台是「未知」而不是「手机」。
    expect(isMobilePlatform(undefined)).toBe(false);
    expect(isMobilePlatform(null)).toBe(false);
    expect(isMobilePlatform('')).toBe(false);
    expect(isMobilePlatform('freebsd')).toBe(false);
    expect(isMobilePlatform('iOS')).toBe(false); // 大小写敏感,presence 报的是小写
  });
});

describe('控制端平台登记表', () => {
  beforeEach(() => {
    clearControllerPlatforms();
  });

  it('登记后可按 deviceId 查回;未登记为 undefined', () => {
    setControllerPlatform('dev-phone', 'ios');
    expect(getControllerPlatform('dev-phone')).toBe('ios');
    expect(getControllerPlatform('dev-unknown')).toBeUndefined();
  });

  it('清空后不残留(账号切换 / 连接重置)', () => {
    setControllerPlatform('dev-phone', 'ios');
    clearControllerPlatforms();
    expect(getControllerPlatform('dev-phone')).toBeUndefined();
  });
});

describe('isMobileControllerInvoke(来源判据)', () => {
  it('本机 renderer(无 device-link 上下文)为假', () => {
    expect(isDeviceLinkInvoke()).toBe(false);
    expect(isMobileControllerInvoke()).toBe(false);
  });

  it('手机控制端为真', () => {
    const seen = runDeviceLinkInvokeContext(
      { controllerDeviceId: 'dev-phone', channel: 'maker:send', controllerPlatform: 'android' },
      () => isMobileControllerInvoke(),
    );
    expect(seen).toBe(true);
  });

  it('另一台桌面作控制端为假(远控不等于手机)', () => {
    const seen = runDeviceLinkInvokeContext(
      { controllerDeviceId: 'dev-mac', channel: 'maker:send', controllerPlatform: 'darwin' },
      () => isMobileControllerInvoke(),
    );
    expect(seen).toBe(false);
  });

  it('platform 未知为假,但仍算 device-link 调用(两个判据互不干扰)', () => {
    const seen = runDeviceLinkInvokeContext(
      { controllerDeviceId: 'dev-x', channel: 'maker:send' },
      () => ({ mobile: isMobileControllerInvoke(), remote: isDeviceLinkInvoke() }),
    );
    expect(seen).toEqual({ mobile: false, remote: true });
  });

  it('跨 await 后仍成立 —— send 路径外面套了串行锁,上下文必须能穿过它', async () => {
    const seen = await runDeviceLinkInvokeContext(
      { controllerDeviceId: 'dev-phone', channel: 'maker:send', controllerPlatform: 'ios' },
      async () => {
        // 模拟 withSendToSessionLock:先 await 一个别处 resolve 的锁,再读来源。
        let release: (() => void) | null = null;
        const lock = new Promise<void>((r) => {
          release = r;
        });
        setTimeout(() => release?.(), 0);
        await lock;
        return isMobileControllerInvoke();
      },
    );
    expect(seen).toBe(true);
  });

  it('上下文结束后不残留', () => {
    runDeviceLinkInvokeContext(
      { controllerDeviceId: 'dev-phone', channel: 'maker:send', controllerPlatform: 'ios' },
      () => isMobileControllerInvoke(),
    );
    expect(isMobileControllerInvoke()).toBe(false);
  });
});

describe('buildMobileClientPromptNote(送进模型的文本)', () => {
  const note = buildMobileClientPromptNote();

  it('首句声明这不是用户消息(否则模型会当请求回应或复述)', () => {
    expect(note.startsWith('[客户端说明]')).toBe(true);
    expect(note).toContain('不是用户发来的消息');
    expect(note).toContain('不要把它当作用户的请求');
  });

  it('给出自包含单文件的产出偏好', () => {
    expect(note).toContain('手机客户端');
    expect(note).toContain('自包含单文件');
  });

  it('是偏好不是禁令:用户明确要多文件时不被挡住', () => {
    expect(note).toContain('优先');
    expect(note).toContain('明确要求多文件时照常产出');
    expect(note).not.toContain('必须做成');
    expect(note).not.toContain('禁止');
  });

  it('不写「不要给本地路径」—— 手机端本就能打开路径,那样写会和已有能力打架', () => {
    // 路径在手机上可点、可渲染、同目录资源会被取回(见 mobile 的 HtmlFileReader /
    // htmlLocalResources)。这里只要求「别只回一个路径」,不否定给路径本身。
    expect(note).not.toContain('不要给出路径');
    expect(note).not.toContain('不要给本地路径');
    expect(note).toContain('不要只回一个路径');
  });

  it('逐字节稳定:不含时间戳 / 随机量等易变内容(否则污染 prompt 前缀假设)', () => {
    expect(buildMobileClientPromptNote()).toBe(note);
    expect(note).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(note).not.toMatch(/\d{10,}/);
  });
});

describe('prependNoteToWireUserMessage(wire 注入形态)', () => {
  it('string 形态直接前拼', () => {
    expect(prependNoteToWireUserMessage('原话', 'NOTE')).toBe('NOTE\n\n原话');
  });

  it('content 为 string 的对象形态', () => {
    expect(prependNoteToWireUserMessage({ type: 'user', content: '原话' }, 'NOTE'))
      .toEqual({ type: 'user', content: 'NOTE\n\n原话' });
  });

  it('blocks 形态前插独立 text block,原 blocks 不变', () => {
    const blocks = [{ type: 'image', url: 'x' }, { type: 'text', text: '原话' }];
    expect(prependNoteToWireUserMessage({ type: 'user', content: blocks }, 'NOTE'))
      .toEqual({ type: 'user', content: [{ type: 'text', text: 'NOTE' }, ...blocks] });
    // 不原地改入参(调用方还要用 normalized 去落库)。
    expect(blocks[0]).toEqual({ type: 'image', url: 'x' });
  });

  it('交接前缀仍走同一份实现(向后兼容)', () => {
    expect(prependHandoffToUserMessage('原话', 'HANDOFF')).toBe('HANDOFF\n\n原话');
  });

  it('说明 + 交接叠加时说明在最前(交接自带结束标记,必须收尾在后)', () => {
    const withHandoff = prependHandoffToUserMessage('原话', 'HANDOFF');
    expect(prependNoteToWireUserMessage(withHandoff, 'NOTE')).toBe('NOTE\n\nHANDOFF\n\n原话');
  });
});

describe('shouldPrependMobileClientPromptNote(内置命令旁路)', () => {
  it('Claude Code /compact 保持在消息开头，含可选指令也旁路', () => {
    expect(shouldPrependMobileClientPromptNote('/compact', 'claude-code')).toBe(false);
    expect(shouldPrependMobileClientPromptNote('/compact focus on decisions', 'claude-code'))
      .toBe(false);
    expect(shouldPrependMobileClientPromptNote(
      { type: 'user', content: '/compact\nkeep the API contract' },
      'claude-code',
    )).toBe(false);
    expect(shouldPrependMobileClientPromptNote(
      { type: 'user', content: [{ type: 'text', text: '/compact' }] },
      'claude-code',
    )).toBe(false);
  });

  it('不把相似文本、带附件消息或其他 Agent 的输入误判成 Claude 命令', () => {
    expect(shouldPrependMobileClientPromptNote('/compactness', 'claude-code')).toBe(true);
    expect(shouldPrependMobileClientPromptNote(' /compact', 'claude-code')).toBe(true);
    expect(shouldPrependMobileClientPromptNote(
      {
        type: 'user',
        content: [
          { type: 'text', text: '/compact' },
          { type: 'image', url: 'x' },
        ],
      },
      'claude-code',
    )).toBe(true);
    expect(shouldPrependMobileClientPromptNote('/compact', 'pi')).toBe(true);
    expect(shouldPrependMobileClientPromptNote('/compact', 'codex')).toBe(true);
  });
});

describe('注入接线(源码级守卫)', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/maker-ipc/makerSendTransaction.ts'),
    'utf8',
  );

  it('说明只进 wire payload,落库走 persistUserMessage.content', () => {
    expect(source).toContain(
      'deps.isMobileClientInvoke?.() === true || so.fromMobileClient === true',
    );
    // 注入链:normalized → withHandoff → withPlanReconcile → mobile note(最外层)。
    expect(source).toContain('prependNoteToWireUserMessage(withPlanReconcile as HandoffWireMessage, mobileClientNote)');
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

describe('stampMobileClientOrigin(IPC 边界盖章)', () => {
  it('手机来源盖上标记,返回新对象不改入参', () => {
    // 显式标出可选字段:真实入参是 AgentInputQueuedMessage(该字段是可选的),
    // 字面量不写这一项会让 TS 判「与约束无公共属性」(TS2559)而拒收。
    const item: { clientId: string; text: string; fromMobileClient?: boolean } = { clientId: 'a', text: 'hi' };
    const out = stampMobileClientOrigin(item, true);
    expect(out).toEqual({ clientId: 'a', text: 'hi', fromMobileClient: true });
    expect(item).toEqual({ clientId: 'a', text: 'hi' });
  });

  it('非手机来源:客户端自填的标记必须被剥掉(wire 值一律不生效)', () => {
    // item 来自 wire,客户端可以自己填 true —— 必须无条件覆盖。
    const forged = { clientId: 'a', text: 'hi', fromMobileClient: true };
    expect(stampMobileClientOrigin(forged, false)).toEqual({ clientId: 'a', text: 'hi' });
    expect(stampMobileClientOrigin(forged, false)).not.toHaveProperty('fromMobileClient');
  });

  it('手机来源时覆盖为 true(即使 wire 传的是 false)', () => {
    expect(stampMobileClientOrigin({ fromMobileClient: false }, true))
      .toEqual({ fromMobileClient: true });
  });
});

describe('stripMainOnlySendOpts(直连路径消毒)', () => {
  it('剥掉客户端自报的 fromMobileClient', () => {
    expect(stripMainOnlySendOpts({ messageUuid: 'u', fromMobileClient: true }))
      .toEqual({ messageUuid: 'u' });
  });

  it('剥掉客户端伪造的 generation 与 turn 身份,但保留待 IPC 校验的 clear token', () => {
    expect(
      stripMainOnlySendOpts({
        expectedClearBoundaryMs: 123,
        expectedInputGeneration: 77,
        expectedTurnSession: { forged: true },
        expectedTurnGeneration: 88,
        messageUuid: 'u',
      }),
    ).toEqual({ expectedClearBoundaryMs: 123, messageUuid: 'u' });
  });

  it('host stamp 覆盖 wire token 并附带 generation', () => {
    expect(
      attachMainOwnedInputBoundary(
        { expectedClearBoundaryMs: 123, expectedInputGeneration: 77, messageUuid: 'u' },
        { expectedClearBoundaryMs: 456, expectedInputGeneration: 9 },
      ),
    ).toEqual({ expectedClearBoundaryMs: 456, expectedInputGeneration: 9, messageUuid: 'u' });
  });

  it('非对象 sendOpts 也映射 main-owned abort signal 到事务读取的 signal', () => {
    const controller = new AbortController();
    expect(
      attachMainOwnedInputBoundary(undefined, {
        expectedClearBoundaryMs: 456,
        expectedInputGeneration: 9,
        inputAbortSignal: controller.signal,
      }),
    ).toEqual({
      expectedClearBoundaryMs: 456,
      expectedInputGeneration: 9,
      signal: controller.signal,
    });
  });

  it('剥掉 wire 注入的 signal,只允许 main 写入 AbortSignal', () => {
    expect(stripMainOnlySendOpts({ messageUuid: 'u', signal: 'forged' })).toEqual({
      messageUuid: 'u',
    });
  });

  it('其它字段原样保留', () => {
    const opts = { messageUuid: 'u', userName: 'n', origin: { kind: 'scheduler' } };
    expect(stripMainOnlySendOpts(opts)).toEqual(opts);
  });

  it('非对象输入原样返回(事务自己 ?? {} 兜底)', () => {
    expect(stripMainOnlySendOpts(undefined)).toBeUndefined();
    expect(stripMainOnlySendOpts(null)).toBeNull();
    expect(stripMainOnlySendOpts('x')).toBe('x');
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

  it('enqueue 与 steer 两个 IPC 边界都盖章', () => {
    // 手机会话页所有发送都走这两条,只在 invoke context 里读来源实际读不到(review P1)。
    const stamps = register.match(/stampMobileClientOrigin\(/g) ?? [];
    expect(stamps.length).toBe(2);
    expect(register).toContain('isMobileControllerInvoke(),');
  });

  it('coordinator 在 drain 与 steer 两处都透传', () => {
    const passes = coordinator.match(/fromMobileClient: true \} : \{\}\)/g) ?? [];
    expect(passes.length).toBe(2);
  });

  it('send 事务认 async context 与透传值两个来源', () => {
    expect(transaction).toContain(
      "deps.isMobileClientInvoke?.() === true || so.fromMobileClient === true",
    );
  });

  it('steer 投递也注入说明,且只进 wire payload', () => {
    expect(register).toContain("isMobileControllerInvoke() || so.fromMobileClient === true");
    expect(register).toContain('shouldPrependMobileClientPromptNote(normalized, sess.agentKind)');
    expect(register).toContain('prependNoteToWireUserMessage(normalized as HandoffWireMessage, steerNote)');
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
      'attachMainOwnedInputBoundary(stripMainOnlySendOpts(sendOpts), boundaryStamp)',
    );
    // coordinator 的内部调用**不得**被消毒 —— 那条路的 sendOpts 是 main 构造的透传值。
    expect(register).toContain('steerToAgent: (sessionId, message, sendOpts) =>');
    expect(register).toMatch(
      /steerToAgent: \(sessionId, message, sendOpts\) =>\s*\n\s*steerToAgentAccepted\(sessionId, message, sendOpts\),/,
    );
  });
});
