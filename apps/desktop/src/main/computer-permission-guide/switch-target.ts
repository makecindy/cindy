import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findSystemSettingsWindowBounds } from './placement.js';

const SYSTEM_CUA_DRIVER_APP_EXECUTABLE = path.join(
  '/Applications',
  'CuaDriver.app',
  'Contents',
  'MacOS',
  'cua-driver',
);
const SYSTEM_CUA_DRIVER_CLI_EXECUTABLE = path.join(
  os.homedir(),
  '.local',
  'bin',
  'cua-driver',
);
const CONNECT_TIMEOUT_MS = 4_000;
const TOOL_TIMEOUT_MS = 8_000;
const CLOSE_TIMEOUT_MS = 1_000;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ComputerUseSystemWindowBounds = Rect;

/** Switch center relative to the System Settings window's top-left corner. */
export interface ComputerUseSwitchTarget {
  x: number;
  y: number;
  /** Current AX checkbox value when the driver exposes it. */
  enabled: boolean | null;
  /** Best-effort pane identity from the returned AX tree. */
  permission?: 'accessibility' | 'screenRecording';
}

export type ComputerUseSwitchLocationResult =
  | {
      status: 'found';
      target: ComputerUseSwitchTarget;
      systemWindowBounds?: ComputerUseSystemWindowBounds;
    }
  | { status: 'not-found'; systemWindowBounds?: ComputerUseSystemWindowBounds }
  | { status: 'unavailable'; systemWindowBounds?: ComputerUseSystemWindowBounds };

interface SwitchLocatorConnection {
  client: Client;
  transport: StdioClientTransport;
  session: string;
}

let switchLocatorConnection: SwitchLocatorConnection | null = null;
let switchLocatorOperationQueue: Promise<void> = Promise.resolve();

function serializeSwitchLocatorOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = switchLocatorOperationQueue.then(operation);
  switchLocatorOperationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRect(value: unknown): Rect | null {
  const object = objectValue(value);
  if (!object) return null;
  const x = finiteNumber(object.x);
  const y = finiteNumber(object.y);
  const width = finiteNumber(object.width ?? object.w);
  const height = finiteNumber(object.height ?? object.h);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function readArray(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  const object = objectValue(value);
  return object && Array.isArray(object[key]) ? object[key] : [];
}

function parseMcpResult(result: unknown): unknown {
  const object = objectValue(result);
  const structured = objectValue(object?.structuredContent);
  if (structured && Object.keys(structured).length > 0) return structured;
  const content = Array.isArray(object?.content) ? object.content : [];
  for (const item of content) {
    const row = objectValue(item);
    if (row?.type !== 'text' || typeof row.text !== 'string') continue;
    try {
      return JSON.parse(row.text) as unknown;
    } catch {
      continue;
    }
  }
  return null;
}

function parseSuccessfulMcpResult(result: unknown, toolName: string): unknown {
  if (objectValue(result)?.isError === true) {
    throw new Error(`CuaDriver MCP tool ${toolName} returned an error`);
  }
  return parseMcpResult(result);
}

function isExactCuaDriverSwitch(element: Record<string, unknown>): boolean {
  if (element.role !== 'AXCheckBox') return false;
  const label = typeof element.label === 'string' ? element.label : '';
  return label.replace(/_Toggle$/i, '').trim().toLocaleLowerCase() === 'cuadriver';
}

function readCheckboxValue(element: Record<string, unknown>): boolean | null {
  const candidates = [element.value, element.checked, element.is_checked, element.selected];
  for (const candidate of candidates) {
    if (typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate !== 0;
    if (typeof candidate === 'string') {
      const normalized = candidate.trim().toLocaleLowerCase();
      if (['1', 'true', 'on', 'yes', 'checked'].includes(normalized)) return true;
      if (['0', 'false', 'off', 'no', 'unchecked'].includes(normalized)) return false;
    }
  }
  return null;
}

function permissionFromText(value: unknown): ComputerUseSwitchTarget['permission'] {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized.includes('screen recording') || normalized.includes('screen capture')) {
    return 'screenRecording';
  }
  if (normalized.includes('accessibility')) return 'accessibility';
  return undefined;
}

function detectPermissionPane(value: unknown): ComputerUseSwitchTarget['permission'] {
  if (Array.isArray(value)) {
    for (const item of value) {
      const detected = detectPermissionPane(item);
      if (detected) return detected;
    }
    return undefined;
  }
  const object = objectValue(value);
  if (!object) return permissionFromText(value);
  for (const key of ['label', 'title', 'name', 'value', 'description']) {
    const detected = permissionFromText(object[key]);
    if (detected) return detected;
  }
  for (const child of Object.values(object)) {
    const detected = detectPermissionPane(child);
    if (detected) return detected;
  }
  return undefined;
}

function findSystemSettingsWindow(
  listWindowsResult: unknown,
): { window: Record<string, unknown>; bounds: ComputerUseSystemWindowBounds } | null {
  const windows = readArray(listWindowsResult, 'windows');
  const bounds = findSystemSettingsWindowBounds({ windows });
  if (!bounds) return null;
  const window = windows
    .map(objectValue)
    .find((candidate) => {
      const candidateBounds = readRect(candidate?.bounds);
      return Boolean(
        candidateBounds
        && candidateBounds.x === bounds.x
        && candidateBounds.y === bounds.y
        && candidateBounds.width === bounds.width
        && candidateBounds.height === bounds.height
      );
    });
  return window ? { window, bounds } : null;
}

/** Resolve the exact branded row without confusing it with Codex Computer Use. */
export function findComputerUseSwitchTarget(
  listWindowsResult: unknown,
  windowStateResult: unknown,
): ComputerUseSwitchTarget | null {
  const settingsWindow = findSystemSettingsWindow(listWindowsResult);
  if (!settingsWindow) return null;
  const windowBounds = settingsWindow.bounds;

  const target = readArray(windowStateResult, 'elements')
    .map(objectValue)
    .find((element) => element && isExactCuaDriverSwitch(element));
  if (!target) return null;
  const targetFrame = readRect(target.frame);
  if (!targetFrame || targetFrame.width <= 0 || targetFrame.height <= 1) return null;

  const x = targetFrame.x + targetFrame.width / 2 - windowBounds.x;
  const y = targetFrame.y + targetFrame.height / 2 - windowBounds.y;
  if (x < 0 || y < 0 || x > windowBounds.width || y > windowBounds.height) return null;
  const permission = detectPermissionPane(windowStateResult);
  return {
    x,
    y,
    enabled: readCheckboxValue(target),
    ...(permission ? { permission } : {}),
  };
}

function resolveSystemCuaDriverExecutable(): string | null {
  if (fs.existsSync(SYSTEM_CUA_DRIVER_APP_EXECUTABLE)) {
    return SYSTEM_CUA_DRIVER_APP_EXECUTABLE;
  }
  if (fs.existsSync(SYSTEM_CUA_DRIVER_CLI_EXECUTABLE)) {
    return SYSTEM_CUA_DRIVER_CLI_EXECUTABLE;
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function closeSwitchLocatorConnection(connection: SwitchLocatorConnection): Promise<void> {
  try {
    await withTimeout(
      connection.client.close(),
      CLOSE_TIMEOUT_MS,
      'switch locator close',
    );
  } catch {
    // Shutdown is best-effort; the cached connection has already been discarded.
  }
}

async function discardSwitchLocatorConnection(
  connection: SwitchLocatorConnection,
): Promise<void> {
  if (switchLocatorConnection === connection) {
    switchLocatorConnection = null;
  }
  await closeSwitchLocatorConnection(connection);
}

async function connectSwitchLocator(executable: string): Promise<SwitchLocatorConnection> {
  const transport = new StdioClientTransport({
    command: executable,
    args: ['mcp'],
    stderr: 'ignore',
  });
  const client = new Client({
    name: 'xdt-computer-permission-switch-locator',
    version: '0.1.0',
  });
  const connection = {
    client,
    transport,
    session: `xdt-permission-switch-${Date.now()}`,
  };
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'switch locator startup');
    switchLocatorConnection = connection;
    return connection;
  } catch (error) {
    await closeSwitchLocatorConnection(connection);
    throw error;
  }
}

async function getSwitchLocatorConnection(executable: string): Promise<SwitchLocatorConnection> {
  return switchLocatorConnection ?? connectSwitchLocator(executable);
}

async function locateComputerUseSwitchTargetSerialized(): Promise<ComputerUseSwitchLocationResult> {
  if (process.platform !== 'darwin') return { status: 'unavailable' };
  const executable = resolveSystemCuaDriverExecutable();
  if (!executable) return { status: 'unavailable' };

  const connection = await getSwitchLocatorConnection(executable);
  try {
    const windowsResult = parseSuccessfulMcpResult(await withTimeout(
      connection.client.callTool({
        name: 'list_windows',
        arguments: { on_screen_only: true, session: connection.session },
      }),
      TOOL_TIMEOUT_MS,
      'System Settings window lookup',
    ), 'list_windows');
    const settingsWindow = findSystemSettingsWindow(windowsResult);
    const pid = finiteNumber(settingsWindow?.window.pid);
    const windowId = finiteNumber(settingsWindow?.window.window_id);
    if (pid === null || windowId === null) {
      return {
        status: 'unavailable',
        ...(settingsWindow ? { systemWindowBounds: settingsWindow.bounds } : {}),
      };
    }

    const stateResult = parseSuccessfulMcpResult(await withTimeout(
      connection.client.callTool({
        name: 'get_window_state',
        arguments: {
          pid,
          window_id: windowId,
          include_screenshot: false,
          // Match the stable app row instead of the localized permission-pane
          // title, while avoiding a walk of the full 400-500 element tree.
          max_elements: 180,
          max_depth: 6,
          query: 'CuaDriver',
          session: connection.session,
        },
      }),
      TOOL_TIMEOUT_MS,
      'Computer Use switch lookup',
    ), 'get_window_state');
    const target = findComputerUseSwitchTarget(windowsResult, stateResult);
    if (target) {
      return {
        status: 'found',
        target,
        ...(settingsWindow ? { systemWindowBounds: settingsWindow.bounds } : {}),
      };
    }
    const stateObject = objectValue(stateResult);
    const elementCount = finiteNumber(stateObject?.element_count);
    return elementCount !== null && elementCount > 0
      ? {
          status: 'not-found',
          ...(settingsWindow ? { systemWindowBounds: settingsWindow.bounds } : {}),
        }
      : {
          status: 'unavailable',
          ...(settingsWindow ? { systemWindowBounds: settingsWindow.bounds } : {}),
        };
  } catch (error) {
    await discardSwitchLocatorConnection(connection);
    throw error;
  }
}

/** Read-only probe through the phase-one CuaDriver identity. */
export function locateComputerUseSwitchTarget(): Promise<ComputerUseSwitchLocationResult> {
  return serializeSwitchLocatorOperation(locateComputerUseSwitchTargetSerialized);
}

export function closeComputerUseSwitchLocator(): Promise<void> {
  return serializeSwitchLocatorOperation(async () => {
    const connection = switchLocatorConnection;
    switchLocatorConnection = null;
    if (!connection) return;
    await closeSwitchLocatorConnection(connection);
  });
}
