import {
  FEISHU_LOCAL_CAPABILITIES,
  FEISHU_LOCAL_MIN_VERSION,
  FEISHU_LOCAL_REQUIRED_SCOPES,
  a1RangeCovers,
  buildClearCellsArgs,
  buildReadCellsArgs,
  buildSetCellImageArgs,
  isValidImageRef,
  mapCliFailure,
  parseA1Cell,
  parseA1Range,
  parseCellValues,
  rowHash,
  type FeishuLocalSheetRef,
} from './descriptor.js';
import type {
  FeishuLocalAuthState,
  FeishuLocalBinaryProbe,
  FeishuLocalCliResult,
  FeishuLocalError,
  FeishuLocalHostPort,
  FeishuLocalImageHandoff,
  FeishuLocalReasonCode,
  FeishuLocalResult,
  FeishuLocalStatus,
  FeishuLocalUpdateProbe,
} from './types.js';
import { decodeConfirmationToken, encodeConfirmationToken } from '../xdt-helper/_confirmation_token.js';

const STATUS_CACHE_TTL_MS = 60_000;

type CapabilityHint = 'sheet_image' | 'cell_clear' | 'any';

interface TargetInfo {
  local: boolean;
  target_device: string;
  device_id: string;
}

interface BaseStatus {
  deviceId: string;
  probe: FeishuLocalBinaryProbe;
  auth: FeishuLocalAuthState;
  update: FeishuLocalUpdateProbe | null;
  reasonCode: FeishuLocalReasonCode;
}

export interface FeishuLocalStatusInput {
  device_id?: string;
  capability_hint?: CapabilityHint;
  refresh_version?: boolean;
}

export interface FeishuLocalReadCellsInput {
  spreadsheet: string;
  sheet: FeishuLocalSheetRef;
  range: string;
  include?: readonly ('value' | 'formula' | 'style' | 'comment' | 'data_validation')[];
  device_id?: string;
}

export interface FeishuLocalSetCellImageInput {
  spreadsheet: string;
  sheet: FeishuLocalSheetRef;
  cell: string;
  row_range: string;
  expected_row_hash: string;
  image_ref: string;
  display_name?: string;
  device_id?: string;
  dry_run?: boolean;
  confirmation_token?: string;
  verify?: boolean;
}

export interface FeishuLocalClearCellsInput {
  spreadsheet: string;
  sheet: FeishuLocalSheetRef;
  range: string;
  row_range: string;
  expected_row_hash: string;
  scope?: 'content' | 'formats' | 'all';
  device_id?: string;
  dry_run?: boolean;
  confirmation_token?: string;
  confirm?: boolean;
  verify?: boolean;
}

export interface FeishuLocalConnectRequest {
  sessionId?: string;
  reauthorize?: boolean;
}

type ConfirmationPayload = Record<string, string>;

function error(reason_code: FeishuLocalReasonCode, message: string, target_device?: string): FeishuLocalError {
  return target_device === undefined
    ? { ok: false, reason_code, message }
    : { ok: false, reason_code, message, target_device };
}

function hasRequiredScopes(scopes: readonly string[]): boolean {
  return FEISHU_LOCAL_REQUIRED_SCOPES.every(scope => scopes.includes(scope));
}

const FORMAT_KEYS = ['style', 'format', 'textStyle', 'cellStyle', 'data_validation'] as const;

function isEmptyCell(cell: unknown): boolean {
  if (cell === null || cell === undefined || cell === '') return true;
  if (typeof cell === 'object' && !Array.isArray(cell)) {
    return Object.values(cell as Record<string, unknown>).every(value => isEmptyCell(value));
  }
  return false;
}

function isClearedValues(values: unknown[][]): boolean {
  return values.every(row => row.every(cell => isEmptyCell(cell)));
}

function hasVerifiableCells(values: unknown[][]): boolean {
  return values.length > 0 && values.some(row => Array.isArray(row) && row.length > 0);
}

function hasResidualFormats(values: unknown[][]): boolean {
  return values.some(row => row.some(cell => {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return false;
    const record = cell as Record<string, unknown>;
    return FORMAT_KEYS.some(key => {
      const value = record[key];
      return value !== null && value !== undefined &&
        (typeof value !== 'object' || Object.keys(value as Record<string, unknown>).length > 0);
    });
  }));
}

function hasEmbeddedImage(values: unknown[][]): boolean {
  const text = JSON.stringify(values).toLowerCase();
  return text.includes('embed-image') || text.includes('file_token') || text.includes('image_token');
}

function samePayload(actual: ConfirmationPayload | null, expected: ConfirmationPayload): boolean {
  if (!actual) return false;
  return Object.keys(expected).every(key => actual[key] === expected[key]);
}

export class FeishuLocalRunner {
  private cachedBase: { expiresAt: number; value: BaseStatus } | null = null;

  constructor(private readonly port: FeishuLocalHostPort) {}

  private async target(requested?: string): Promise<TargetInfo> {
    const device_id = await this.port.deviceId();
    const target_device = requested ?? device_id;
    return { local: !requested || requested === device_id, target_device, device_id };
  }

  private async readBaseStatus(refreshVersion: boolean): Promise<BaseStatus> {
    const now = Date.now();
    if (!refreshVersion && this.cachedBase && this.cachedBase.expiresAt > now) return this.cachedBase.value;
    const [deviceId, probe, auth] = await Promise.all([
      this.port.deviceId(),
      this.port.probeBinary(),
      this.port.readAuth(),
    ]);
    const update = refreshVersion ? await this.port.checkUpdate() : null;
    let reasonCode: FeishuLocalReasonCode = 'OK';
    if (!probe.installed) reasonCode = 'LOCAL_CLI_NOT_INSTALLED';
    else if (!probe.version_supported) reasonCode = 'LOCAL_CLI_VERSION_UNSUPPORTED';
    else if (auth.reason_code === 'SETUP_REQUIRED' || auth.reason_code === 'SETUP_UNAVAILABLE' || auth.reason_code === 'CLI_FAILED') {
      reasonCode = auth.reason_code;
    }
    else if (auth.state === 'missing' || auth.state === 'expired') reasonCode = 'NOT_AUTHORIZED';
    else if (auth.state === 'scope_missing' || !hasRequiredScopes(auth.scopes)) reasonCode = 'SCOPE_MISSING';
    const value: BaseStatus = { deviceId, probe, auth, update, reasonCode };
    if (reasonCode === 'SETUP_REQUIRED' || reasonCode === 'SETUP_UNAVAILABLE' || reasonCode === 'CLI_FAILED') {
      this.cachedBase = null;
    } else {
      this.cachedBase = { expiresAt: now + STATUS_CACHE_TTL_MS, value };
    }
    return value;
  }

  private async ensureReady(target: TargetInfo): Promise<FeishuLocalError | null> {
    if (!target.local) return error('TARGET_DEVICE_UNAVAILABLE', 'Remote Feishu CLI execution is not available in this version.', target.target_device);
    const base = await this.readBaseStatus(false);
    if (base.reasonCode === 'OK') return null;
    const messages: Record<FeishuLocalReasonCode, string> = {
      OK: 'Ready.',
      PLUGIN_UNSUPPORTED_BUT_LOCAL_CLI_AVAILABLE: 'The plugin does not expose this operation, but the local CLI does.',
      LOCAL_CLI_NOT_INSTALLED: 'The local Feishu CLI is not installed.',
      LOCAL_CLI_VERSION_UNSUPPORTED: 'The local Feishu CLI version is outside the trusted range.',
      NOT_AUTHORIZED: 'The local Feishu CLI user authorization is missing or expired.',
      SCOPE_MISSING: 'The local Feishu CLI user token is missing a required scope.',
      TARGET_DEVICE_UNAVAILABLE: 'Remote Feishu CLI execution is not available.',
      ROW_CHANGED: 'The target row changed after the preview.',
      PATH_HANDOFF_REJECTED: 'The image handoff reference was rejected.',
      VERIFY_FAILED: 'The write could not be verified by readback.',
      CONFIRMATION_REQUIRED: 'A matching dry-run confirmation token is required.',
      INVALID_ARGS: 'The tool arguments are invalid.',
      CLI_FAILED: 'The local Feishu CLI command failed.',
      SETUP_REQUIRED: 'A native setup card is required.',
      SETUP_UNAVAILABLE: 'A native setup card is unavailable in this host.',
    };
    return error(base.reasonCode, messages[base.reasonCode], target.target_device);
  }

  private cliError(result: FeishuLocalCliResult, target_device: string): FeishuLocalError {
    if (result.reasonCode) return error(result.reasonCode, 'Feishu CLI command failed; raw output was withheld.', target_device);
    const mapped = mapCliFailure(result.stdout, result.stderr, result.exitCode);
    return error(mapped.reasonCode, mapped.message, target_device);
  }

  private async readValues(
    input: Pick<FeishuLocalReadCellsInput, 'spreadsheet' | 'sheet' | 'range' | 'include'>,
    target_device: string,
  ): Promise<{ ok: true; values: unknown[][]; row_hash: string } | FeishuLocalError> {
    const result = await this.port.runCli({
      argv: buildReadCellsArgs(input),
      withCredential: true,
    });
    if (!result.ok) return this.cliError(result, target_device);
    if (result.outputTruncated) {
      return error('CLI_FAILED', 'Feishu CLI output was truncated; raw output was withheld.', target_device);
    }
    const values = parseCellValues(result.stdout);
    if (values === null) {
      return error('CLI_FAILED', 'Feishu CLI returned an unparseable cell payload; raw output was withheld.', target_device);
    }
    if (!hasVerifiableCells(values)) {
      return error('CLI_FAILED', 'Feishu CLI returned no verifiable cell values; raw output was withheld.', target_device);
    }
    return { ok: true, values, row_hash: rowHash(values) };
  }

  async status(input: FeishuLocalStatusInput = {}): Promise<FeishuLocalStatus | FeishuLocalError> {
    const target = await this.target(input.device_id);
    if (!target.local) {
      return {
        ok: true,
        device_id: target.device_id,
        installed: false,
        binary_source: 'unavailable',
        version: null,
        min_supported_version: FEISHU_LOCAL_MIN_VERSION,
        version_supported: false,
        identity_alias: null,
        auth_state: 'missing',
        scopes: [],
        capabilities: FEISHU_LOCAL_CAPABILITIES,
        target_device: target.target_device,
        reason_code: 'TARGET_DEVICE_UNAVAILABLE',
      };
    }
    const base = await this.readBaseStatus(input.refresh_version === true);
    const hint = input.capability_hint;
    const reason_code: FeishuLocalReasonCode = base.reasonCode === 'OK' && hint !== undefined
      ? 'PLUGIN_UNSUPPORTED_BUT_LOCAL_CLI_AVAILABLE'
      : base.reasonCode;
    return {
      ok: true,
      device_id: target.device_id,
      installed: base.probe.installed,
      binary_source: base.probe.binary_source,
      version: base.probe.version,
      min_supported_version: FEISHU_LOCAL_MIN_VERSION,
      version_supported: base.probe.version_supported,
      identity_alias: base.auth.identity_alias,
      auth_state: base.auth.state,
      scopes: base.auth.scopes,
      capabilities: FEISHU_LOCAL_CAPABILITIES,
      target_device: target.target_device,
      reason_code,
      ...(base.update?.latest_version ? { latest_version: base.update.latest_version } : {}),
    };
  }

  async readCells(input: FeishuLocalReadCellsInput): Promise<FeishuLocalResult<{
    values: unknown[][];
    row_hash: string;
    target_device: string;
  }>> {
    const target = await this.target(input.device_id);
    const ready = await this.ensureReady(target);
    if (ready) return ready;
    const values = await this.readValues(input, target.target_device);
    if (!values.ok) return values;
    return {
      ok: true,
      reason_code: 'OK',
      values: values.values,
      row_hash: values.row_hash,
      target_device: target.target_device,
    };
  }

  async setCellImage(input: FeishuLocalSetCellImageInput): Promise<FeishuLocalResult<{
    preview?: { cell: string; row_range: string; image_ref: string };
    confirmation_token?: string;
    verified?: boolean;
    target_device: string;
  }>> {
    const target = await this.target(input.device_id);
    const ready = await this.ensureReady(target);
    if (ready) return ready;
    if (!isValidImageRef(input.image_ref)) {
      return error('PATH_HANDOFF_REJECTED', 'image_ref must be a managed Cindy media reference.', target.target_device);
    }
    const rowBounds = parseA1Range(input.row_range);
    const cellBounds = parseA1Cell(input.cell);
    if (!rowBounds || !cellBounds || !a1RangeCovers(rowBounds, cellBounds)) {
      return error('INVALID_ARGS', 'row_range must cover the target cell; re-read the whole containing range.', target.target_device);
    }
    let handoff: FeishuLocalImageHandoff | undefined;
    try {
      handoff = await this.port.resolveImage(input.image_ref);
    } catch {
      return error('PATH_HANDOFF_REJECTED', 'The managed image reference could not be handed off.', target.target_device);
    }
    try {
      const row = await this.readValues({
        spreadsheet: input.spreadsheet,
        sheet: input.sheet,
        range: input.row_range,
      }, target.target_device);
      if (!row.ok) return row;
      if (row.row_hash !== input.expected_row_hash) {
        return error('ROW_CHANGED', 'The target row changed after the preview.', target.target_device);
      }
      const payload: ConfirmationPayload = {
        spreadsheet: input.spreadsheet,
        sheet_id: input.sheet.sheet_id ?? '',
        sheet_name: input.sheet.sheet_name ?? '',
        cell: input.cell,
        row_range: input.row_range,
        expected_row_hash: input.expected_row_hash,
        image_ref: input.image_ref,
        display_name: input.display_name ?? '',
        device_id: target.device_id,
      };
      const purpose = 'set_cell_image';
      const dryRun = input.dry_run !== false;
      const argv = buildSetCellImageArgs({
        spreadsheet: input.spreadsheet,
        sheet: input.sheet,
        cell: input.cell,
        imagePath: handoff.relativePath,
        ...(input.display_name ? { displayName: input.display_name } : {}),
        dryRun,
      });
      if (dryRun) {
        const preview = await this.port.runCli({ argv, cwd: handoff.cwd, withCredential: true });
        if (!preview.ok) return this.cliError(preview, target.target_device);
        return {
          ok: true,
          reason_code: 'OK',
          preview: { cell: input.cell, row_range: input.row_range, image_ref: input.image_ref },
          confirmation_token: encodeConfirmationToken(purpose, payload),
          target_device: target.target_device,
        };
      }
      const tokenPayload = input.confirmation_token
        ? decodeConfirmationToken<ConfirmationPayload>(purpose, input.confirmation_token,
          (value): value is ConfirmationPayload => !!value && typeof value === 'object' && !Array.isArray(value))
        : null;
      if (!samePayload(tokenPayload, payload)) {
        return error('CONFIRMATION_REQUIRED', 'A matching dry-run confirmation token is required.', target.target_device);
      }
      const write = await this.port.runCli({ argv, cwd: handoff.cwd, withCredential: true });
      if (!write.ok) return this.cliError(write, target.target_device);
      let verified = false;
      if (input.verify !== false) {
        const readback = await this.readValues({
          spreadsheet: input.spreadsheet,
          sheet: input.sheet,
          range: input.cell,
        }, target.target_device);
        if (!readback.ok) return readback;
        if (!hasEmbeddedImage(readback.values)) {
          return error('VERIFY_FAILED', 'The target cell did not contain an embedded image after the write.', target.target_device);
        }
        verified = true;
      }
      return { ok: true, reason_code: 'OK', verified, target_device: target.target_device };
    } finally {
      if (handoff) await handoff.cleanup();
    }
  }

  async clearCells(input: FeishuLocalClearCellsInput): Promise<FeishuLocalResult<{
    preview?: { range: string; row_range: string; scope: string };
    confirmation_token?: string;
    verified?: boolean;
    target_device: string;
  }>> {
    const target = await this.target(input.device_id);
    const ready = await this.ensureReady(target);
    if (ready) return ready;
    const scope = input.scope ?? 'content';
    const dryRun = input.dry_run !== false;
    const rowBounds = parseA1Range(input.row_range);
    const targetBounds = parseA1Range(input.range);
    if (!rowBounds || !targetBounds || !a1RangeCovers(rowBounds, targetBounds)) {
      return error('INVALID_ARGS', 'row_range must cover every target cell; re-read the whole containing range.', target.target_device);
    }
    const row = await this.readValues({
      spreadsheet: input.spreadsheet,
      sheet: input.sheet,
      range: input.row_range,
    }, target.target_device);
    if (!row.ok) return row;
    if (row.row_hash !== input.expected_row_hash) {
      return error('ROW_CHANGED', 'The target row changed after the preview.', target.target_device);
    }
    const payload: ConfirmationPayload = {
      spreadsheet: input.spreadsheet,
      sheet_id: input.sheet.sheet_id ?? '',
      sheet_name: input.sheet.sheet_name ?? '',
      range: input.range,
      row_range: input.row_range,
      expected_row_hash: input.expected_row_hash,
      scope,
      device_id: target.device_id,
    };
    const purpose = 'clear_cells';
    const argv = buildClearCellsArgs({
      spreadsheet: input.spreadsheet,
      sheet: input.sheet,
      range: input.range,
      scope,
      dryRun,
      confirmed: input.confirm === true,
    });
    if (dryRun) {
      const preview = await this.port.runCli({ argv, withCredential: true });
      if (!preview.ok) return this.cliError(preview, target.target_device);
      return {
        ok: true,
        reason_code: 'OK',
        preview: { range: input.range, row_range: input.row_range, scope },
        confirmation_token: encodeConfirmationToken(purpose, payload),
        target_device: target.target_device,
      };
    }
    const tokenPayload = input.confirmation_token
      ? decodeConfirmationToken<ConfirmationPayload>(purpose, input.confirmation_token,
        (value): value is ConfirmationPayload => !!value && typeof value === 'object' && !Array.isArray(value))
      : null;
    if (input.confirm !== true || !samePayload(tokenPayload, payload)) {
      return error('CONFIRMATION_REQUIRED', 'Clearing requires confirm=true and a matching dry-run confirmation token.', target.target_device);
    }
    const write = await this.port.runCli({ argv, withCredential: true });
    if (!write.ok) return this.cliError(write, target.target_device);
    let verified = false;
    if (input.verify !== false) {
      const needsFormats = scope !== 'content';
      const readback = await this.readValues({
        spreadsheet: input.spreadsheet,
        sheet: input.sheet,
        range: input.range,
        ...(needsFormats ? { include: ['style', 'data_validation'] as const } : {}),
      }, target.target_device);
      if (!readback.ok) return readback;
      if (!hasVerifiableCells(readback.values)) {
        return error('VERIFY_FAILED', 'The clear operation could not be verified by readback.', target.target_device);
      }
      if (scope === 'formats') {
        if (hasResidualFormats(readback.values)) {
          return error('VERIFY_FAILED', 'The target range still contained cell formats after the clear operation.', target.target_device);
        }
      } else {
        if (!isClearedValues(readback.values)) {
          return error('VERIFY_FAILED', 'The target range was not empty after the clear operation.', target.target_device);
        }
        if (scope === 'all' && hasResidualFormats(readback.values)) {
          return error('VERIFY_FAILED', 'The target range still contained cell formats after the clear operation.', target.target_device);
        }
      }
      verified = true;
    }
    return { ok: true, reason_code: 'OK', verified, target_device: target.target_device };
  }

  async connect(input: FeishuLocalConnectRequest): Promise<FeishuLocalResult<{ message: string }>> {
    this.cachedBase = null;
    if (!input.sessionId) {
      return error('SETUP_UNAVAILABLE', 'A native setup card is unavailable for this task.');
    }
    const result = await this.port.requestSetup({
      sessionId: input.sessionId,
      reauthorize: input.reauthorize === true,
    });
    if (result.ok) return { ok: true, reason_code: 'OK', message: 'Feishu Local CLI setup completed.' };
    return {
      ok: false,
      reason_code: result.reasonCode ?? 'SETUP_UNAVAILABLE',
      message: result.message ?? 'Feishu Local CLI setup is unavailable.',
    };
  }
}
