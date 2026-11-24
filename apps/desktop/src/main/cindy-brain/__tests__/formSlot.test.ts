/**
 * formSlot.test — 表单弹窗槽(form)与往返桥的假 deps 单测。
 *
 * 测试价值
 * - 生产入口与可观察结果:GhostFormSlot.handleRequest(插件管子 form-request 的处理入口)回给插件的
 *   结构化结果;GhostFormDialogBridge.request / resolve / cancelAll(main ↔ renderer 往返)的结算与收起。
 * - Bug／规则依据:新增 form 槽(2026-11-23),沿用 confirm 槽的安全模型(plugin-security-and-authoring:
 *   资格审、主机拥有壳与净化、限速 + 全局单飞、fail closed),另加「只在用户正看着 Cindy 时弹」与
 *   「main 按原表单收口 renderer 回包」两条边界。
 * - 现有覆盖缺口:新模块,confirmSlot / ghostConfirmDialogBridge 的测试不覆盖表单字段校验、值收口、
 *   窗口归属回包、超时收起与窗口关闭结算。
 * - 最小失败输入:未声明 form 的插件请求;字段 key 为 id 的表单;renderer 回传不在选项里的下拉值、
 *   超出 maxItems 的条目;另一个窗口拿同一 requestId 回包;超时后表单仍留在窗口里。
 * - tier:unit(纯逻辑 + 依赖注入,无真实窗口、无真实等待;超时用 fake timers)。
 * - 实测耗时:见 PR 描述。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import type { GhostFormAnswer } from '../../../shared/ghostForm';
import { GhostFormSlot, type FormSlotDeps, type GhostFormShowParams } from '../formSlot';
import { GhostFormDialogBridge, type GhostFormDelivery, type GhostFormPush } from '../ghostFormDialogBridge';

function formGhost(options: { form?: boolean; enabled?: boolean } = {}): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 3,
      id: 'form-ghost',
      name: '表单插件',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      ...(options.form === false ? {} : { form: true }),
    },
    dir: '/fake/form-ghost',
    enabled: options.enabled ?? true,
  } as InstalledGhost;
}

/** 一份覆盖所有字段类型的表单:顶层开关 + 分段 + 「要处理的事」列表。 */
const FORM = {
  title: '顾雍\u0007',
  description: '消息先对上是哪件事再交出去。',
  fields: [
    { type: 'switch', key: 'enabled', label: '关注中' },
    { type: 'choice', key: 'scope', label: '看哪些消息', options: [{ value: 'mention', label: '只看 @我的' }, { value: 'all', label: '全部消息' }] },
    {
      type: 'list', key: 'topics', label: '要处理的事', itemLabel: '事情', maxItems: 2,
      fields: [
        { type: 'text', key: 'what', label: '什么样的消息', required: true, maxLength: 10 },
        { type: 'select', key: 'project', label: '交给哪个项目', required: true, options: [{ value: 'chat', label: '对话' }, { value: '/work/a', label: 'A' }] },
      ],
    },
  ],
  values: {
    enabled: true,
    scope: 'nope',
    topics: [
      { id: 't1', what: '提交 iOS 审核', project: 'chat', stray: 'x' },
      { id: 'bad id!', what: '一二三四五六七八九十十一', project: '/gone' },
      { what: '第三条超出上限', project: 'chat' },
    ],
  },
  action: { id: 'unfollow', text: '删除关注', danger: true, confirm: '确定删除关注?', icon: 'trash' },
};

function makeSlot(overrides: Partial<FormSlotDeps> = {}, answer: GhostFormAnswer = { outcome: 'cancel' }) {
  let clock = 0;
  const showForm = vi.fn(async (_params: GhostFormShowParams) => answer);
  const deps: FormSlotDeps = {
    getGhost: () => formGhost(),
    hasFocusedWindow: () => true,
    now: () => (clock += 60_000),
    showForm,
    ...overrides,
  };
  return { slot: new GhostFormSlot(deps), showForm };
}

describe('formSlot · 资格审与载荷校验', () => {
  it.each([
    ['未声明 form', formGhost({ form: false })],
    ['插件已停用', formGhost({ enabled: false })],
    ['插件不存在', null],
  ])('%s → PERMISSION_DENIED,不弹窗', async (_name, ghost) => {
    const { slot, showForm } = makeSlot({ getGhost: () => ghost });
    expect(await slot.handleRequest('form-ghost', FORM)).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(showForm).not.toHaveBeenCalled();
  });

  it('手机插件页来的请求回 UNAVAILABLE(暂不支持),不在桌面弹', async () => {
    const { slot, showForm } = makeSlot();
    expect(await slot.handleRequest('form-ghost', { ...FORM, mobilePageId: '00000000-0000-0000-0000-000000000000' }))
      .toMatchObject({ ok: false, errorCode: 'UNAVAILABLE' });
    expect(showForm).not.toHaveBeenCalled();
  });

  it.each([
    ['缺标题', { ...FORM, title: '  ' }],
    ['标题过长', { ...FORM, title: '长'.repeat(41) }],
    ['没有字段', { ...FORM, fields: [] }],
    ['字段 key 为 id(留给列表条目)', { ...FORM, fields: [{ type: 'text', key: 'id', label: 'x' }] }],
    ['字段 key 重复', { ...FORM, fields: [{ type: 'switch', key: 'a', label: 'x' }, { type: 'switch', key: 'a', label: 'y' }] }],
    ['未知字段类型', { ...FORM, fields: [{ type: 'date', key: 'a', label: 'x' }] }],
    ['下拉没有选项', { ...FORM, fields: [{ type: 'select', key: 'a', label: 'x', options: [] }] }],
    ['分段选项超过 5 个', { ...FORM, fields: [{ type: 'choice', key: 'a', label: 'x', options: 'abcdef'.split('').map((v) => ({ value: v, label: v })) }] }],
    ['列表里再套列表', { ...FORM, fields: [{ type: 'list', key: 'a', label: 'x', itemLabel: 'y', maxItems: 2, fields: [{ type: 'list', key: 'b', label: 'z', itemLabel: 'w', maxItems: 1, fields: [] }] }] }],
    ['maxItems 超上限', { ...FORM, fields: [{ ...FORM.fields[2], maxItems: 21 }] }],
    ['额外操作 id 非法', { ...FORM, action: { id: 'un follow', text: '删除关注' } }],
    ['额外操作图标不在主机图标集里', { ...FORM, action: { id: 'unfollow', text: '删除关注', icon: 'skull' } }],
  ])('%s → INVALID_REQUEST,不弹窗', async (_name, payload) => {
    const { slot, showForm } = makeSlot();
    expect(await slot.handleRequest('form-ghost', payload)).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(showForm).not.toHaveBeenCalled();
  });

  it('交给窗口的表单:身份来自已装清单,文案已净化,初始值按字段收口', async () => {
    const { slot, showForm } = makeSlot();
    await slot.handleRequest('form-ghost', FORM);
    const shown = showForm.mock.calls[0]![0];
    expect(shown).toMatchObject({ ghostId: 'form-ghost', ghostName: '表单插件' });
    expect(shown.spec.title).toBe('顾雍');
    expect(shown.spec.action).toEqual({ id: 'unfollow', text: '删除关注', danger: true, confirm: '确定删除关注?', icon: 'trash' });
    expect(shown.spec.values).toEqual({
      enabled: true,
      // 分段值不在选项里 → 落回第一个选项
      scope: 'mention',
      // 列表截到 maxItems;不认识的 key 丢掉;非法 id 丢掉;文本截到 maxLength;下拉值不在选项里清空
      topics: [
        { id: 't1', what: '提交 iOS 审核', project: 'chat' },
        { what: '一二三四五六七八九十', project: '' },
      ],
    });
  });
});

describe('formSlot · 打扰钳制与前台', () => {
  it('上个表单关掉 1 秒内再请求 → RATE_LIMITED(从关掉时算起);已有表单在场 → BUSY;Cindy 不在前台 → UNAVAILABLE', async () => {
    let now = 0;
    // 用户填了 5 秒才关掉:间隔从关掉时算,紧接着 0.5 秒再弹被拦,过了 1 秒放行。
    const { slot } = makeSlot({ now: () => now, showForm: async () => { now += 5000; return { outcome: 'cancel' }; } });
    expect((await slot.handleRequest('form-ghost', FORM)).ok).toBe(true);
    now += 500;
    expect(await slot.handleRequest('form-ghost', FORM)).toMatchObject({ ok: false, errorCode: 'RATE_LIMITED' });
    now += 1000;
    expect((await slot.handleRequest('form-ghost', FORM)).ok).toBe(true);

    let release!: (answer: GhostFormAnswer) => void;
    const pending = makeSlot({ showForm: () => new Promise((resolve) => { release = resolve; }) });
    const first = pending.slot.handleRequest('form-ghost', FORM);
    expect(await pending.slot.handleRequest('other-ghost', FORM)).toMatchObject({ ok: false, errorCode: 'BUSY' });
    release({ outcome: 'cancel' });
    await first;

    const away = makeSlot({ hasFocusedWindow: () => false });
    expect(await away.slot.handleRequest('form-ghost', FORM)).toMatchObject({ ok: false, errorCode: 'UNAVAILABLE' });
    expect(away.showForm).not.toHaveBeenCalled();
  });

  it('投不出去(窗口通道不可用)→ UNAVAILABLE,而不是「用户取消」', async () => {
    const { slot } = makeSlot({ showForm: async () => { throw new Error('no window'); } });
    expect(await slot.handleRequest('form-ghost', FORM)).toMatchObject({ ok: false, errorCode: 'UNAVAILABLE' });
  });
});

describe('formSlot · 答复收口', () => {
  it.each<[string, GhostFormAnswer, unknown]>([
    [
      '保存:回包按原表单收口(多余 key、越界条目、无效下拉值都不交给插件)',
      { outcome: 'submit', values: { enabled: 'yes', scope: 'all', extra: 1, topics: [
        { id: 't1', what: '改过的', project: '/work/a' },
        { what: '新的', project: '/elsewhere' },
        { what: '第三条', project: 'chat' },
      ] } },
      { ok: true, outcome: 'submit', values: { enabled: false, scope: 'all', topics: [
        { id: 't1', what: '改过的', project: '/work/a' },
        { what: '新的', project: '' },
      ] } },
    ],
    ['额外操作:回插件声明的操作 id', { outcome: 'action' }, { ok: true, outcome: 'action', action: 'unfollow' }],
    ['取消', { outcome: 'cancel' }, { ok: true, outcome: 'cancel' }],
  ])('%s', async (_name, answer, expected) => {
    const { slot } = makeSlot({}, answer);
    expect(await slot.handleRequest('form-ghost', FORM)).toEqual(expected);
  });

  it('表单没有额外操作时,回包里的 action 按取消处理', async () => {
    const { slot } = makeSlot({}, { outcome: 'action' });
    expect(await slot.handleRequest('form-ghost', { ...FORM, action: undefined })).toEqual({ ok: true, outcome: 'cancel' });
  });
});

describe('ghostFormDialogBridge · 往返与收尾', () => {
  afterEach(() => vi.useRealTimers());

  function makeBridge(timeoutMs = 1000) {
    const delivered: GhostFormPush[] = [];
    const dismissed: string[] = [];
    let closeWindow: () => void = () => {};
    const delivery: GhostFormDelivery = {
      windowId: 7,
      dismiss: (requestId) => dismissed.push(requestId),
      onClosed: (callback) => { closeWindow = callback; return () => { closeWindow = () => {}; }; },
    };
    const bridge = new GhostFormDialogBridge({
      deliver: (payload) => { delivered.push(payload); return delivery; },
      timeoutMs,
    });
    const ask = () => bridge.request({ ghostId: 'form-ghost', ghostName: '表单插件', spec: { title: 't', description: null, fields: [], values: {}, submitText: null, cancelText: null, action: null } });
    return { bridge, delivered, dismissed, ask, closeWindow: () => closeWindow() };
  }

  it('只认投递目标窗口的回包;形状非法的回包按取消结算', async () => {
    const { bridge, delivered, ask } = makeBridge();
    const answer = ask();
    const { requestId } = delivered[0];
    expect(bridge.resolve(8, requestId, { outcome: 'submit', values: {} })).toBe(false);
    expect(bridge.resolve(7, requestId, { outcome: 'approve' })).toBe(true);
    expect(await answer).toEqual({ outcome: 'cancel' });
    expect(bridge.resolve(7, requestId, { outcome: 'submit' })).toBe(false);
  });

  it('超时按取消结算并收起窗口里的表单;窗口关闭立即按取消结算', async () => {
    vi.useFakeTimers();
    const timed = makeBridge(1000);
    const answer = timed.ask();
    vi.advanceTimersByTime(1000);
    expect(await answer).toEqual({ outcome: 'cancel' });
    expect(timed.dismissed).toEqual([timed.delivered[0].requestId]);

    const closed = makeBridge(1000);
    const second = closed.ask();
    closed.closeWindow();
    expect(await second).toEqual({ outcome: 'cancel' });
    expect(closed.dismissed).toEqual([]);
    expect(closed.bridge.pendingCount).toBe(0);
  });

  it('cancelAll 按取消结算并收起;投不出去时 reject(由槽回 UNAVAILABLE)', async () => {
    const { bridge, dismissed, delivered, ask } = makeBridge();
    const answer = ask();
    bridge.cancelAll('form-ghost');
    expect(await answer).toEqual({ outcome: 'cancel' });
    expect(dismissed).toEqual([delivered[0].requestId]);

    const nowhere = new GhostFormDialogBridge({ deliver: () => null });
    await expect(nowhere.request({ ghostId: 'g', ghostName: 'g', spec: { title: 't', description: null, fields: [], values: {}, submitText: null, cancelText: null, action: null } }))
      .rejects.toThrow();
  });
});
