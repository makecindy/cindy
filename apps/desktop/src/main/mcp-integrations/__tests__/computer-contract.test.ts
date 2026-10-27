import { describe, expect, it } from 'vitest';
import fixture from './fixtures/cua-driver-0.23.2.json';
import {
  adaptComputerDriverArgs,
  selectAdvertisedComputerDriverArgs,
  type ComputerDriverToolSchema,
} from '../computer-contract.js';

const schemas = new Map(
  fixture.tools.map((tool) => [tool.name, tool.inputSchema as ComputerDriverToolSchema]),
);
describe('installed Computer Use contract', () => {
  // Production argument adapter, unit tier: new incremental evidence requests
  // must still dispatch with the existing old-driver fixture (previously untested).
  it('preserves Markdown evidence diffs only for drivers advertising since', () => {
    const input = { pid: 1, window_id: 2, include_screenshot: false, tree_format: 'markdown', since: 'latest' };
    const modern = new Map<string, ComputerDriverToolSchema>([['get_window_state', {
      properties: { pid: {}, window_id: {}, include_screenshot: {}, tree_format: {}, since: {} },
      additionalProperties: false,
    }]]);
    expect(adaptComputerDriverArgs('get_window_state', input, modern)).toEqual(input);
    expect(adaptComputerDriverArgs('get_window_state', input, schemas)).not.toHaveProperty('since');
  });
  it('preserves driver credentials and rejects missing observation provenance', () => {
    const args = {
      pid: 1,
      window_id: 2,
      element_index: 3,
      snapshot_id: 's01234567',
      element_token: 'opaque:untouched',
      delivery_mode: 'background',
    };
    expect(adaptComputerDriverArgs('click', args, schemas)).toEqual(args);
    expect(() => adaptComputerDriverArgs('click', { pid: 1, element_index: 3 }, schemas)).toThrow(
      'fresh driver snapshot_id',
    );
  });
  it('uses the real screenshot switch and bounded traversal without mutating caller input', () => {
    const args = { pid: 1, window_id: 2, capture_mode: 'ax' };
    expect(adaptComputerDriverArgs('get_window_state', args, schemas)).toEqual({
      pid: 1,
      window_id: 2,
      include_screenshot: false,
      max_elements: 200,
      max_depth: 15,
    });
    expect(args.capture_mode).toBe('ax');
    expect(
      adaptComputerDriverArgs(
        'get_window_state',
        { ...args, include_screenshot: true, max_elements: 500 },
        schemas,
      ),
    ).toMatchObject({ include_screenshot: true, max_elements: 500 });
  });
  it('preserves legacy SOM and maps an explicit new screenshot flag for old drivers', () => {
    const legacy = new Map([['get_window_state', { properties: { capture_mode: {} } }]]);
    expect(adaptComputerDriverArgs('get_window_state', { capture_mode: 'som' }, legacy)).toEqual({
      capture_mode: 'som',
    });
    expect(
      adaptComputerDriverArgs('get_window_state', { include_screenshot: false }, legacy),
    ).toEqual({ capture_mode: 'ax' });
  });
  it('addresses token-only drivers with the observed row and asks for structured elements', () => {
    // cua-driver 0.35+: Markdown-only reads by default, actions take only element_token.
    const tokenOnly = new Map<string, ComputerDriverToolSchema>([
      ['click', { properties: { pid: {}, window_id: {}, element_token: {} }, additionalProperties: false }],
      ['get_window_state', {
        properties: { pid: {}, window_id: {}, include_screenshot: {}, max_elements: {}, max_depth: {}, tree_format: {} },
        required: ['pid', 'window_id'],
        additionalProperties: false,
      }],
    ]);
    expect(adaptComputerDriverArgs('click', {
      pid: 1, window_id: 2, element_index: 5, snapshot_id: 's0000002d',
    }, tokenOnly)).toEqual({ pid: 1, window_id: 2, element_token: 's0000002d:5' });
    expect(adaptComputerDriverArgs('click', {
      pid: 1, window_id: 2, element_index: 5, element_token: 's0000002d:5', snapshot_id: 's0000002d',
    }, tokenOnly)).toEqual({ pid: 1, window_id: 2, element_token: 's0000002d:5' });
    expect(() => adaptComputerDriverArgs('click', { pid: 1, window_id: 2, element_index: 5 }, tokenOnly))
      .toThrow('fresh snapshot_id or element_token');
    expect(adaptComputerDriverArgs('get_window_state', { pid: 1, window_id: 2 }, tokenOnly))
      .toMatchObject({ tree_format: 'both' });
    expect(adaptComputerDriverArgs('get_window_state', { pid: 1, window_id: 2, tree_format: 'markdown' }, tokenOnly))
      .toMatchObject({ tree_format: 'markdown' });
    // Older drivers have no tree_format; Cindy's internal reads must still dispatch.
    expect(adaptComputerDriverArgs('get_window_state', { pid: 1, window_id: 2, tree_format: 'markdown' }, schemas))
      .not.toHaveProperty('tree_format');
  });
  it('rejects unavailable tools and incompatible arguments before dispatch', () => {
    expect(() => adaptComputerDriverArgs('missing', {}, schemas)).toThrow('does not advertise');
    const olderClick = new Map([['click', {
      properties: { pid: {}, window_id: {}, element_index: {}, snapshot_id: {} },
      additionalProperties: false,
    }]]);
    expect(adaptComputerDriverArgs('click', {
      pid: 1,
      window_id: 2,
      element_index: 3,
      snapshot_id: 's01234567',
      delivery_mode: 'background',
    }, olderClick)).toEqual({
      pid: 1,
      window_id: 2,
      element_index: 3,
      snapshot_id: 's01234567',
    });
    expect(() => adaptComputerDriverArgs('click', {
      pid: 1,
      window_id: 2,
      element_index: 3,
      snapshot_id: 's01234567',
      unsupported: true,
    }, olderClick)).toThrow('does not accept unsupported');
    expect(() =>
      adaptComputerDriverArgs('verify_state', { pid: 1, window_id: 2 }, schemas),
    ).toThrow('requires expect');
  });
  // 测试价值：#6979 中 cua-driver 0.38 的闭合 schema 移除了旧光标样式字段；生产契约
  // 协商必须在派发前跳过无兼容参数的可选装饰，避免每个新会话产生拒绝日志。旧覆盖只验证
  // 必需动作的 fail-closed 适配；最小失败输入是一个仅声明新运动字段的闭合 schema，unit tier。
  it('negotiates optional cursor decoration against the advertised schema', () => {
    const legacyInput = {
      cursor_id: 'session',
      cursor_icon: 'arrow',
      cursor_color: '#DF0C27',
    };
    const v038 = new Map<string, ComputerDriverToolSchema>([
      ['set_agent_cursor_motion', {
        properties: { arc_flow: {}, style: {}, timing: {} },
        additionalProperties: false,
      }],
    ]);
    expect(selectAdvertisedComputerDriverArgs('set_agent_cursor_motion', legacyInput, v038)).toBeNull();
    expect(selectAdvertisedComputerDriverArgs('set_agent_cursor_style', legacyInput, v038)).toBeNull();

    const compatible = new Map<string, ComputerDriverToolSchema>([
      ['set_agent_cursor_motion', {
        properties: { cursor_color: {} },
        additionalProperties: false,
      }],
    ]);
    expect(selectAdvertisedComputerDriverArgs('set_agent_cursor_motion', legacyInput, compatible))
      .toEqual({ cursor_color: '#DF0C27' });

    const permissive = new Map<string, ComputerDriverToolSchema>([
      ['set_agent_cursor_motion', { additionalProperties: true }],
    ]);
    expect(selectAdvertisedComputerDriverArgs('set_agent_cursor_motion', legacyInput, permissive))
      .toEqual(legacyInput);
  });
});
