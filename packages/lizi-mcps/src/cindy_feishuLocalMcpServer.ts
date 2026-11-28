import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HostToolMcpServer } from './host-tool-runtime.js';
import type { XdtHelperToolResult } from './lizi_xdtHelperToolRegistry.js';
import {
  isValidA1Range,
  isValidSingleCell,
} from './feishu-local/descriptor.js';
import { FeishuLocalRunner } from './feishu-local/runner.js';
import type {
  FeishuLocalClearCellsInput,
  FeishuLocalReadCellsInput,
  FeishuLocalSetCellImageInput,
  FeishuLocalStatusInput,
} from './feishu-local/runner.js';
import type { FeishuLocalHostPort, FeishuLocalReasonCode } from './feishu-local/types.js';

export interface FeishuLocalMcpDeps {
  port: FeishuLocalHostPort;
  getSessionId(): string | undefined;
}

type InputShape = Record<string, z.ZodTypeAny>;

interface ToolDefinition {
  name: string;
  category: string;
  description: string;
  inputShape: InputShape;
  handler(args: Record<string, unknown>): Promise<unknown>;
}

const REASON_CODES = [
  'PLUGIN_UNSUPPORTED_BUT_LOCAL_CLI_AVAILABLE',
  'LOCAL_CLI_NOT_INSTALLED',
  'LOCAL_CLI_VERSION_UNSUPPORTED',
  'NOT_AUTHORIZED',
  'SCOPE_MISSING',
  'TARGET_DEVICE_UNAVAILABLE',
  'ROW_CHANGED',
  'PATH_HANDOFF_REJECTED',
  'VERIFY_FAILED',
  'CONFIRMATION_REQUIRED',
  'INVALID_ARGS',
  'CLI_FAILED',
  'SETUP_REQUIRED',
  'SETUP_UNAVAILABLE',
] as const;

const REASON_TAIL = ` Stable reasonCode values: ${REASON_CODES.join(', ')}. Tool results never include stdout, stderr, tokens, filesystem paths or stack traces.`;

function textResult(payload: unknown, isError = false): XdtHelperToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

function invalidArgs(): XdtHelperToolResult {
  return textResult({
    ok: false,
    reason_code: 'INVALID_ARGS' satisfies FeishuLocalReasonCode,
    message: 'The tool arguments are invalid.',
  }, true);
}

const sheetShape = z.object({
  sheet_id: z.string().min(1).max(256).optional(),
  sheet_name: z.string().min(1).max(256).optional(),
}).strict().refine(
  value => (value.sheet_id ? 1 : 0) + (value.sheet_name ? 1 : 0) === 1,
  { message: 'Provide exactly one of sheet_id or sheet_name.' },
);

const spreadsheet = z.string().min(1).max(1024);
const a1Range = z.string().min(1).max(64).refine(isValidA1Range, { message: 'Expected an A1 range without a sheet prefix.' });
const singleCell = z.string().min(1).max(32).refine(isValidSingleCell, { message: 'Expected one A1 cell.' });
const imageRef = z.string().min(1).max(1024);
const rowHash = z.string().min(1).max(128);
const confirmationToken = z.string().min(1).max(2048).optional();
const deviceId = z.string().min(1).max(256).optional();

function resultIsFailure(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && (payload as { ok?: unknown }).ok === false;
}

function wrapHandler(
  definition: ToolDefinition,
  inputSchema: z.ZodTypeAny,
): (args: unknown) => Promise<XdtHelperToolResult> {
  return async (args: unknown) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = inputSchema.parse(args ?? {}) as Record<string, unknown>;
    } catch {
      return invalidArgs();
    }
    const payload = await definition.handler(parsed);
    return textResult(payload, resultIsFailure(payload));
  };
}

export function createFeishuLocalMcpServer(deps: FeishuLocalMcpDeps): HostToolMcpServer {
  const server = new McpServer({ name: 'cindy_feishu_local', version: '1.0.0' });
  const runner = new FeishuLocalRunner(deps.port);

  const definitions: ToolDefinition[] = [
    {
      name: 'status',
      category: 'discovery',
      description: 'Report the local Feishu CLI non-secret availability projection: installed, binary source, version, min supported version, user identity alias, auth state, scopes, supported operations, local/target device and a stable reasonCode. refresh_version=true is the only case that checks upstream version; the default is cached and performs no network request.' + REASON_TAIL,
      inputShape: {
        device_id: deviceId,
        capability_hint: z.enum(['sheet_image', 'cell_clear', 'any']).optional(),
        refresh_version: z.boolean().default(false),
      },
      handler: args => runner.status(args as unknown as FeishuLocalStatusInput),
    },
    {
      name: 'read_cells',
      category: 'sheets',
      description: 'Read a Feishu spreadsheet A1 range through the registered local CLI. Returns normalized cell values and a row_hash suitable for write-before-read checks. Read-only; raw CLI output is never returned.' + REASON_TAIL,
      inputShape: {
        spreadsheet,
        sheet: sheetShape,
        range: a1Range,
        include: z.array(z.enum(['value', 'formula', 'style', 'comment', 'data_validation'])).max(5).optional(),
        device_id: deviceId,
      },
      handler: args => runner.readCells(args as unknown as FeishuLocalReadCellsInput),
    },
    {
      name: 'set_cell_image',
      category: 'sheets',
      description: 'Embed a managed Cindy image reference into one Feishu spreadsheet cell. Requires a whole-row expected_row_hash from read_cells; row_range must cover the target cell; default dry_run returns a preview and confirmation_token; the write requires that same token and readback verify. The Host hands off the image into a temporary relative path; no raw absolute path is accepted.' + REASON_TAIL,
      inputShape: {
        spreadsheet,
        sheet: sheetShape,
        cell: singleCell,
        row_range: a1Range,
        expected_row_hash: rowHash,
        image_ref: imageRef,
        display_name: z.string().min(1).max(255).optional(),
        device_id: deviceId,
        dry_run: z.boolean().default(true),
        confirmation_token: confirmationToken,
        verify: z.boolean().default(true),
      },
      handler: args => runner.setCellImage(args as unknown as FeishuLocalSetCellImageInput),
    },
    {
      name: 'clear_cells',
      category: 'sheets',
      description: 'Clear Feishu spreadsheet cell content/formats with the CLI +cells-clear semantics, never by writing an empty string. This is an irreversible high-risk write: row_range must cover every target cell; it requires a whole-row expected_row_hash, a dry_run confirmation_token, confirm=true, and readback verify. Use scope=content to clear embedded cell images; floating objects require their own object API.' + REASON_TAIL,
      inputShape: {
        spreadsheet,
        sheet: sheetShape,
        range: a1Range,
        row_range: a1Range,
        expected_row_hash: rowHash,
        scope: z.enum(['content', 'formats', 'all']).default('content'),
        device_id: deviceId,
        dry_run: z.boolean().default(true),
        confirmation_token: confirmationToken,
        confirm: z.boolean().optional(),
        verify: z.boolean().default(true),
      },
      handler: args => runner.clearCells(args as unknown as FeishuLocalClearCellsInput),
    },
    {
      name: 'connect',
      category: 'auth',
      description: 'Request the Host-owned native setup card for the local Feishu CLI user device flow. The card shows the verification URL; device codes and tokens never enter chat, tool arguments, logs or the repository. Returns SETUP_REQUIRED while the card is pending.' + REASON_TAIL,
      inputShape: {
        reauthorize: z.boolean().optional(),
      },
      handler: args => {
        const sessionId = deps.getSessionId();
        return runner.connect({
          ...(sessionId ? { sessionId } : {}),
          reauthorize: (args as { reauthorize?: boolean }).reauthorize === true,
        });
      },
    },
  ];

  const schemas = new Map<string, z.ZodTypeAny>();
  for (const definition of definitions) {
    const inputSchema = z.object(definition.inputShape).strict();
    schemas.set(definition.name, inputSchema);
    server.registerTool(definition.name, {
      description: definition.description,
      inputSchema,
    }, wrapHandler(definition, inputSchema));
  }

  return Object.assign(server, {
    hostTools: {
      list: () => definitions.map(({ name, category }) => ({ name, category })),
      describe: (name: string) => {
        const definition = definitions.find(item => item.name === name);
        return definition ? { name: definition.name, category: definition.category } : undefined;
      },
      call: async (name: string, args?: Record<string, unknown>) => {
        const definition = definitions.find(item => item.name === name);
        const inputSchema = schemas.get(name);
        if (!definition || !inputSchema) return invalidArgs();
        return wrapHandler(definition, inputSchema)(args ?? {});
      },
      close: () => server.close(),
    },
  });
}
