import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFeishuLocalMcpServer } from '../cindy_feishuLocalMcpServer.js';
import {
  FEISHU_LOCAL_REQUIRED_SCOPES,
  a1RangeCovers,
  parseA1Range,
  rowHash,
} from '../feishu-local/descriptor.js';
import type {
  FeishuLocalAuthState,
  FeishuLocalBinaryProbe,
  FeishuLocalCliInvocation,
  FeishuLocalHostPort,
} from '../feishu-local/types.js';

interface FakeState {
  probe: FeishuLocalBinaryProbe;
  auth: FeishuLocalAuthState;
  imageReadback: unknown[][];
  verifyClear: boolean;
  verifyFormats: boolean;
  updateChecks: number;
  calls: FeishuLocalCliInvocation[];
  setupInputs: unknown[];
  cleanup: ReturnType<typeof vi.fn>;
}

function okJson(payload: unknown) {
  return {
    ok: true as const,
    stdout: JSON.stringify(payload),
    stderr: 'RAW_STDERR_SHOULD_NOT_LEAK /private/fixture-path-should-not-leak',
    exitCode: 0,
  };
}

function makeFakePort(): { port: FeishuLocalHostPort; state: FakeState } {
  const state: FakeState = {
    probe: { installed: true, binary_source: 'fixed-path', version: '1.0.57', version_supported: true },
    auth: { state: 'ready', identity_alias: 'Fixture User', scopes: [...FEISHU_LOCAL_REQUIRED_SCOPES] },
    imageReadback: [[{ type: 'embed-image', file_token: 'fixture-image-token' }]],
    verifyClear: true,
    verifyFormats: true,
    updateChecks: 0,
    calls: [],
    setupInputs: [],
    cleanup: vi.fn(async () => {}),
  };
  const port: FeishuLocalHostPort = {
    deviceId: () => 'device-local',
    probeBinary: async () => state.probe,
    readAuth: async () => state.auth,
    checkUpdate: async () => {
      state.updateChecks += 1;
      return { current_version: '1.0.57', latest_version: '1.0.100' };
    },
    runCli: async (invocation) => {
      state.calls.push(invocation);
      const argv = invocation.argv;
      if (argv.includes('+cells-get')) {
        const index = argv.indexOf('--range');
        const range = index >= 0 ? argv[index + 1] : '';
        const includeIndex = argv.indexOf('--include');
        const include = includeIndex >= 0 ? argv[includeIndex + 1] ?? '' : '';
        if (range === 'A85:K85' || range === 'A92:K92') return okJson({ values: [['identity']] });
        if (range === 'I92') return okJson({ values: state.imageReadback });
        if (range === 'I85') {
          if (include.includes('style')) {
            return okJson({ values: [[{ value: 'kept text', style: state.verifyFormats ? {} : { bold: true } }]] });
          }
          return okJson({ values: state.verifyClear ? [['']] : [['still-here']] });
        }
        return okJson({ values: [['value']] });
      }
      return okJson({ ok: true });
    },
    resolveImage: async () => ({ cwd: '/tmp/fixture', relativePath: 'image.png', cleanup: state.cleanup }),
    requestSetup: async (input) => {
      state.setupInputs.push(input);
      return { ok: false, reasonCode: 'SETUP_REQUIRED', message: 'Authorization card sent.' };
    },
    connect: async () => ({ ok: false, reasonCode: 'SETUP_REQUIRED', message: 'Authorization card sent.' }),
  };
  return { port, state };
}

async function callTool(
  port: FeishuLocalHostPort,
  name: string,
  args: Record<string, unknown>,
  getSessionId: () => string | undefined = () => 'session-fixture',
): Promise<Record<string, unknown>> {
  const server = createFeishuLocalMcpServer({ port, getSessionId });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    const first = content[0];
    if (!first || first.type !== 'text' || typeof first.text !== 'string') throw new Error('missing text result');
    return JSON.parse(first.text) as Record<string, unknown>;
  } finally {
    await client.close();
    await server.close();
  }
}

function noRawOutput(payload: Record<string, unknown>): void {
  const text = JSON.stringify(payload);
  expect(text).not.toContain('RAW_STDERR_SHOULD_NOT_LEAK');
  expect(text).not.toContain('/private/fixture-path-should-not-leak');
  expect(text).not.toContain('"stdout"');
  expect(text).not.toContain('"stderr"');
}

describe('cindy_feishu_local MCP server', () => {
  it('exposes a non-secret status projection and only checks upstream versions on explicit refresh', async () => {
    const { port, state } = makeFakePort();
    const initial = await callTool(port, 'status', { capability_hint: 'sheet_image' });
    expect(initial.device_id).toBe('device-local');
    expect(initial.installed).toBe(true);
    expect(initial.min_supported_version).toBe('1.0.57');
    expect(initial.auth_state).toBe('ready');
    expect(initial.reason_code).toBe('PLUGIN_UNSUPPORTED_BUT_LOCAL_CLI_AVAILABLE');
    expect(state.updateChecks).toBe(0);
    noRawOutput(initial);

    const refreshed = await callTool(port, 'status', { refresh_version: true });
    expect(refreshed.latest_version).toBe('1.0.100');
    expect(state.updateChecks).toBe(1);
    noRawOutput(refreshed);
  });

  it.each([
    [{ installed: false, binary_source: 'unavailable', version: null, version_supported: false }, 'LOCAL_CLI_NOT_INSTALLED'],
    [{ installed: true, binary_source: 'fixed-path', version: '1.0.0', version_supported: false }, 'LOCAL_CLI_VERSION_UNSUPPORTED'],
  ] as const)('reports binary reason code %j', async (probe, reason) => {
    const { port } = makeFakePort();
    port.probeBinary = async () => probe as unknown as FeishuLocalBinaryProbe;
    const result = await callTool(port, 'status', {});
    expect(result.reason_code).toBe(reason);
  });

  it.each([
    [{ state: 'missing', identity_alias: null, scopes: [] }, 'NOT_AUTHORIZED'],
    [{ state: 'ready', identity_alias: 'Fixture User', scopes: ['sheets:spreadsheet'] }, 'SCOPE_MISSING'],
  ] as const)('reports auth reason code %j', async (auth, reason) => {
    const { port } = makeFakePort();
    port.readAuth = async () => auth as unknown as FeishuLocalAuthState;
    const result = await callTool(port, 'status', {});
    expect(result.reason_code).toBe(reason);
  });

  it('reads cells and returns a stable whole-row hash', async () => {
    const { port } = makeFakePort();
    const result = await callTool(port, 'read_cells', {
      spreadsheet: 'fixture-token',
      sheet: { sheet_id: 'sheet-fixture' },
      range: 'A85:K85',
    });
    expect(result.values).toEqual([['identity']]);
    expect(result.row_hash).toBe(rowHash([['identity']]));
    noRawOutput(result);
  });

  it('requires a dry-run token, uses a relative managed image, and verifies the embedded image', async () => {
    const { port, state } = makeFakePort();
    const base = {
      spreadsheet: 'fixture-token',
      sheet: { sheet_id: 'sheet-fixture' },
      cell: 'I92',
      row_range: 'A92:K92',
      expected_row_hash: rowHash([['identity']]),
      image_ref: 'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    };
    const dryRun = await callTool(port, 'set_cell_image', base);
    expect(dryRun.ok).toBe(true);
    expect(typeof dryRun.confirmation_token).toBe('string');
    expect(state.calls.some(call => call.argv.includes('+cells-set-image') && call.argv.includes('--dry-run'))).toBe(true);
    noRawOutput(dryRun);

    const write = await callTool(port, 'set_cell_image', {
      ...base,
      dry_run: false,
      confirmation_token: dryRun.confirmation_token,
    });
    expect(write.ok).toBe(true);
    expect(write.verified).toBe(true);
    expect(state.calls.some(call =>
      call.argv.includes('+cells-set-image') &&
      call.argv.includes('image.png') &&
      !call.argv.some(arg => arg.includes('/tmp/fixture')) &&
      !call.argv.includes('--yes'))).toBe(true);
    expect(state.cleanup).toHaveBeenCalled();
    noRawOutput(write);
  });

  it('rejects raw filesystem paths with PATH_HANDOFF_REJECTED', async () => {
    const { port } = makeFakePort();
    const result = await callTool(port, 'set_cell_image', {
      spreadsheet: 'fixture-token',
      sheet: { sheet_id: 'sheet-fixture' },
      cell: 'I92',
      row_range: 'A92:K92',
      expected_row_hash: rowHash([['identity']]),
      image_ref: '/tmp/fixture/image.png',
    });
    expect(result.reason_code).toBe('PATH_HANDOFF_REJECTED');
    noRawOutput(result);
  });

  it('rejects a stale row with ROW_CHANGED before any write', async () => {
    const { port, state } = makeFakePort();
    const result = await callTool(port, 'set_cell_image', {
      spreadsheet: 'fixture-token',
      sheet: { sheet_id: 'sheet-fixture' },
      cell: 'I92',
      row_range: 'A92:K92',
      expected_row_hash: 'stale-hash',
      image_ref: 'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    });
    expect(result.reason_code).toBe('ROW_CHANGED');
    expect(state.calls.some(call => call.argv.includes('+cells-set-image'))).toBe(false);
  });

  it('returns VERIFY_FAILED when readback does not contain the embedded image', async () => {
    const { port, state } = makeFakePort();
    state.imageReadback = [['text']];
    const base = {
      spreadsheet: 'fixture-token',
      sheet: { sheet_id: 'sheet-fixture' },
      cell: 'I92',
      row_range: 'A92:K92',
      expected_row_hash: rowHash([['identity']]),
      image_ref: 'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    };
    const dryRun = await callTool(port, 'set_cell_image', base);
    const write = await callTool(port, 'set_cell_image', {
      ...base,
      dry_run: false,
      confirmation_token: dryRun.confirmation_token,
    });
    expect(write.reason_code).toBe('VERIFY_FAILED');
  });

  // 测试价值
  // - 生产入口与可观察结果：真实 MCP set_cell_image 写后回读只接受结构化图片单元格及有效 token；token 类普通文本返回 VERIFY_FAILED，结构化 image_token / file_token 和嵌套单元格才返回 verified:true。
  // - Bug／规则依据：PR #11697 P2（JSON 文本子串被当作图片证据）及「写后验证必须依赖结构」不变量。
  // - 现有覆盖缺口：旧用例只回读 `[['text']]`，未覆盖 `image_token`、`file_token`、`embed-image` 等关键词文本，也未覆盖有效 token 字段与嵌套单元格。
  // - 最小失败输入：回读 `[['image_token']]`；修复前写入回执为 verified:true。
  // - tier：unit（MCP 内存传输 + 注入 Host port，无真实 CLI 或飞书写入）。
  // - 实测耗时：4.61s（`@cindy/mcps` Vitest 单独运行 `src/__tests__/feishuLocalMcpServer.test.ts`，38 条用例）。
  it.each([
    ['plain image_token text', [['image_token']]],
    ['plain file_token text', [['file_token']]],
    ['plain embed-image text', [['embed-image']]],
    ['text object with token keyword', [[{ type: 'text', text: 'image_token' }]]],
  ] as const)('does not verify %s as an embedded image', async (_name, values) => {
    const { port, state } = makeFakePort();
    state.imageReadback = values as unknown as unknown[][];
    const base = {
      spreadsheet: 'fixture-token', sheet: { sheet_id: 'sheet-fixture' }, cell: 'I92',
      row_range: 'A92:K92', expected_row_hash: rowHash([['identity']]),
      image_ref: 'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    };
    const dryRun = await callTool(port, 'set_cell_image', base);
    const write = await callTool(port, 'set_cell_image', {
      ...base, dry_run: false, confirmation_token: dryRun.confirmation_token,
    });
    expect(write.reason_code).toBe('VERIFY_FAILED');
    expect(write.verified).toBeUndefined();
  });

  it.each([
    ['file_token', [[{ type: 'embed-image', file_token: 'fixture-image-token' }]]],
    ['image_token', [[{ type: 'image', image_token: 'fixture-image-token' }]]],
    ['nested value', [[{ value: { type: 'embed-image', image_token: 'fixture-image-token' } }]]],
  ] as const)('verifies a structured image cell with %s', async (_name, values) => {
    const { port, state } = makeFakePort();
    state.imageReadback = values as unknown as unknown[][];
    const base = {
      spreadsheet: 'fixture-token', sheet: { sheet_id: 'sheet-fixture' }, cell: 'I92',
      row_range: 'A92:K92', expected_row_hash: rowHash([['identity']]),
      image_ref: 'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    };
    const dryRun = await callTool(port, 'set_cell_image', base);
    const write = await callTool(port, 'set_cell_image', {
      ...base, dry_run: false, confirmation_token: dryRun.confirmation_token,
    });
    expect(write.ok).toBe(true);
    expect(write.verified).toBe(true);
  });

  it('maps clear_cells to +cells-clear with --yes and never writes an empty string', async () => {
    const { port, state } = makeFakePort();
    const base = {
      spreadsheet: 'fixture-token',
      sheet: { sheet_id: 'sheet-fixture' },
      range: 'I85',
      row_range: 'A85:K85',
      expected_row_hash: rowHash([['identity']]),
      scope: 'content',
    };
    const dryRun = await callTool(port, 'clear_cells', base);
    expect(typeof dryRun.confirmation_token).toBe('string');
    const missingConfirm = await callTool(port, 'clear_cells', {
      ...base,
      dry_run: false,
      confirmation_token: dryRun.confirmation_token,
    });
    expect(missingConfirm.reason_code).toBe('CONFIRMATION_REQUIRED');

    const write = await callTool(port, 'clear_cells', {
      ...base,
      dry_run: false,
      confirmation_token: dryRun.confirmation_token,
      confirm: true,
    });
    expect(write.ok).toBe(true);
    expect(write.verified).toBe(true);
    expect(state.calls.some(call =>
      call.argv.includes('+cells-clear') &&
      call.argv.includes('--yes') &&
      call.argv.includes('content') &&
      !call.argv.includes('+cells-set'))).toBe(true);
  });

  it('returns TARGET_DEVICE_UNAVAILABLE for a non-local device without probing the CLI', async () => {
    const { port, state } = makeFakePort();
    const result = await callTool(port, 'status', { device_id: 'other-device' });
    expect(result.reason_code).toBe('TARGET_DEVICE_UNAVAILABLE');
    expect(result.target_device).toBe('other-device');
    expect(state.updateChecks).toBe(0);
  });

  it('routes native setup through the Host card without exposing device codes or tokens', async () => {
    const { port } = makeFakePort();
    const result = await callTool(port, 'connect', {});
    expect(result.reason_code).toBe('SETUP_REQUIRED');
    expect(JSON.stringify(result)).not.toContain('device_code');
    expect(JSON.stringify(result)).not.toContain('RAW_STDERR_SHOULD_NOT_LEAK');
  });

  it.each([
    ['set_cell_image', {
      spreadsheet: 'fixture-token', sheet: { sheet_id: 'sheet-fixture' }, cell: 'I92',
      row_range: 'A85:K85', expected_row_hash: rowHash([['identity']]),
      image_ref: 'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', dry_run: true,
    }],
    ['clear_cells', {
      spreadsheet: 'fixture-token', sheet: { sheet_id: 'sheet-fixture' }, range: 'I92',
      row_range: 'A85:K85', expected_row_hash: rowHash([['identity']]), dry_run: true,
    }],
  ] as const)('rejects %s when row_range does not cover the target before any CLI call', async (name, args) => {
    const { port, state } = makeFakePort();
    const result = await callTool(port, name, args);
    expect(result.reason_code).toBe('INVALID_ARGS');
    expect(state.calls).toHaveLength(0);
  });

  // 测试价值
  // - 生产入口与可观察结果：MCP set_cell_image / clear_cells 的 dry_run 与 a1RangeCovers 对整行、整列范围给出正确的确认令牌或拒绝语义。
  // - Bug／规则依据：PR #11697 P2（无界轴被误判为不覆盖具体单元格）及「对称半边」收敛要求。
  // - 现有覆盖缺口：只覆盖有界 A92:K92 与明确不覆盖的 A85:K85，未覆盖 `92:92` / `I:K`。
  // - 最小失败输入：row_range=`92:92` 或 `I:K`、目标 `I92`；修复前返回 INVALID_ARGS 且不调用 CLI。
  // - tier：unit（MCP 内存传输 + 纯 A1 解析，无真实进程或网络）。
  // - 实测耗时：4.61s（`@cindy/mcps` Vitest 单独运行 `src/__tests__/feishuLocalMcpServer.test.ts`，38 条用例）。
  it.each([
    ['set_cell_image', '92:92', {
      spreadsheet: 'fixture-token', sheet: { sheet_id: 'sheet-fixture' }, cell: 'I92',
      row_range: '92:92', expected_row_hash: rowHash([['value']]),
      image_ref: 'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', dry_run: true,
    }],
    ['clear_cells', '92:92', {
      spreadsheet: 'fixture-token', sheet: { sheet_id: 'sheet-fixture' }, range: 'I92',
      row_range: '92:92', expected_row_hash: rowHash([['value']]), dry_run: true,
    }],
    ['set_cell_image', 'I:K', {
      spreadsheet: 'fixture-token', sheet: { sheet_id: 'sheet-fixture' }, cell: 'I92',
      row_range: 'I:K', expected_row_hash: rowHash([['value']]),
      image_ref: 'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', dry_run: true,
    }],
    ['clear_cells', 'I:K', {
      spreadsheet: 'fixture-token', sheet: { sheet_id: 'sheet-fixture' }, range: 'I92',
      row_range: 'I:K', expected_row_hash: rowHash([['value']]), dry_run: true,
    }],
  ] as const)('accepts %s with unbounded row_range %s before a dry-run write', async (name, _range, args) => {
    const { port, state } = makeFakePort();
    const result = await callTool(port, name, args);
    expect(result.ok).toBe(true);
    expect(typeof result.confirmation_token).toBe('string');
    expect(state.calls.some(call => call.argv.includes('+cells-get'))).toBe(true);
    expect(state.calls.some(call =>
      (call.argv.includes('+cells-set-image') || call.argv.includes('+cells-clear')) &&
      !call.argv.includes('--dry-run'))).toBe(false);
    noRawOutput(result);
  });

  it.each([
    ['whole row covers a cell', '92:92', 'I92', true],
    ['whole columns cover a cell', 'I:K', 'I92', true],
    ['bounded rows do not cover whole columns', '92:92', 'A:A', false],
    ['bounded columns do not cover whole rows', 'A85:K85', '85:85', false],
  ] as const)('%s symmetrically on the row and column axes', (_name, outerRange, innerRange, expected) => {
    const outer = parseA1Range(outerRange);
    const inner = parseA1Range(innerRange);
    expect(outer).not.toBeNull();
    expect(inner).not.toBeNull();
    expect(a1RangeCovers(outer!, inner!)).toBe(expected);
  });

  it.each([
    [{ ok: true, stdout: 'not json', stderr: 'RAW_STDERR_SHOULD_NOT_LEAK', exitCode: 0 }],
    [{ ok: true, stdout: '{"values":[]}', stderr: '', exitCode: 0 }],
    [{ ok: true, stdout: '{"values":[["value"]]}', stderr: '', exitCode: 0, outputTruncated: true }],
  ] as const)('fails closed on unparseable, empty or truncated cell output %j', async (cliResult) => {
    const { port } = makeFakePort();
    port.runCli = async () => cliResult as never;
    const result = await callTool(port, 'read_cells', {
      spreadsheet: 'fixture-token', sheet: { sheet_id: 'sheet-fixture' }, range: 'A85:K85',
    });
    expect(result.reason_code).toBe('CLI_FAILED');
    noRawOutput(result);
  });

  it('refuses a write when the row readback is an empty matrix', async () => {
    const { port, state } = makeFakePort();
    port.runCli = async () => ({ ok: true, stdout: '{"values":[]}', stderr: '', exitCode: 0 }) as never;
    const result = await callTool(port, 'set_cell_image', {
      spreadsheet: 'fixture-token',
      sheet: { sheet_id: 'sheet-fixture' },
      cell: 'I92',
      row_range: 'A92:K92',
      expected_row_hash: rowHash([]),
      image_ref: 'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      dry_run: true,
    });
    expect(result.reason_code).toBe('CLI_FAILED');
    expect(state.calls.some(call => call.argv.includes('+cells-set-image'))).toBe(false);
  });

  it.each([true, false])('verifies formats clearance by style readback (verified=%s)', async (verified) => {
    const { port, state } = makeFakePort();
    state.verifyFormats = verified;
    const base = {
      spreadsheet: 'fixture-token',
      sheet: { sheet_id: 'sheet-fixture' },
      range: 'I85',
      row_range: 'A85:K85',
      expected_row_hash: rowHash([['identity']]),
      scope: 'formats',
    };
    const dryRun = await callTool(port, 'clear_cells', base);
    const write = await callTool(port, 'clear_cells', {
      ...base,
      dry_run: false,
      confirmation_token: dryRun.confirmation_token,
      confirm: true,
    });
    expect(write.ok).toBe(verified);
    if (verified) expect(write.verified).toBe(true);
    else expect(write.reason_code).toBe('VERIFY_FAILED');
    expect(state.calls.some(call =>
      call.argv.includes('+cells-get') && call.argv.includes('--include') &&
      call.argv.some(arg => arg.includes('style')))).toBe(true);
  });

  it('reports SETUP_REQUIRED without projecting a terminal identity and does not cache it', async () => {
    const { port, state } = makeFakePort();
    port.readAuth = async () => ({
      state: 'ready', identity_alias: null, scopes: [...FEISHU_LOCAL_REQUIRED_SCOPES], reason_code: 'SETUP_REQUIRED',
    });
    const status = await callTool(port, 'status', {});
    expect(status.reason_code).toBe('SETUP_REQUIRED');
    expect(status.identity_alias).toBeNull();
    const read = await callTool(port, 'read_cells', {
      spreadsheet: 'fixture-token', sheet: { sheet_id: 'sheet-fixture' }, range: 'A85:K85',
    });
    expect(read.reason_code).toBe('SETUP_REQUIRED');
    expect(state.calls).toHaveLength(0);
    port.readAuth = async () => ({ state: 'ready', identity_alias: 'Fixture User', scopes: [...FEISHU_LOCAL_REQUIRED_SCOPES] });
    const refreshed = await callTool(port, 'status', {});
    expect(refreshed.reason_code).toBe('OK');
  });

  it('fails closed when the Host has no interactive setup surface', async () => {
    const { port, state } = makeFakePort();
    const result = await callTool(port, 'connect', {}, () => undefined);
    expect(result.reason_code).toBe('SETUP_UNAVAILABLE');
    expect(state.setupInputs).toHaveLength(0);
    noRawOutput(result);
  });
});
