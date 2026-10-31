import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonObjectArg } from '../json-object-arg.js';
import { resolvePathInsideRoot, PathBoundaryError } from '../shared/assertInsidePath.js';
import {
  authorizeSessionPathOutsideWorkdir,
  authorizedSessionPathStillBound,
  resolveCanonicalSessionPath,
} from '../session-path-auth.js';
import type {
  ComputerMcpCallContext,
  ComputerMcpDeps,
  ComputerMcpToolName,
  LiziMcpSessionContext,
} from '../types.js';
import {
  callComputerTool,
  COMPUTER_TOOLS,
  COMPUTER_TOOL_NAMES,
  getComputerTool,
  POSTCHECK_ACTION_TOOLS,
} from "./tools.js";
import { logToolResultErrorCode } from "../tool-error-telemetry.js";
import { WindowSnapshotTracker } from "./snapshot-tracker.js";
import { computerResultOutcome, isUnavailableWindowObservation } from "./result.js";
import {
  canLocateRunningApp,
  exactInstalledAppBundle,
  exactRunningApp,
  isAppNameResolutionFailure,
  isWindowIdentityFailure,
  readForRecovery,
} from "./recovery.js";

export interface ComputerMcpServerOptions {
  sessionId?: string;
  getSessionContext?: () => LiziMcpSessionContext;
}

const DESCRIPTION_LIST =
  'Discover local desktop computer-use tools. These tools operate on the user desktop through the installed driver. ' +
  'Pass names to retrieve only the needed schemas; reuse them instead of guessing CLI flags. Use read-only status/list_windows/get_window_state before input.';

const DESCRIPTION_CALL =
  'Invoke a local desktop computer-use tool. After status/permission checks, include session_goal in the first call\'s args as a short English name for the overall objective (not the current step); omit it thereafter. Arguments are validated before dispatching to the host driver.';

function textResult(value: unknown, isError?: boolean) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value),
      },
    ],
    ...(isError ? { isError: true as const } : {}),
  };
}

const SESSION_AWARE_TOOLS = new Set<ComputerMcpToolName>([
  'list_windows',
  'get_window_state',
  'verify_state',
  'click',
  'double_click',
  'right_click',
  'drag',
  'type_text',
  'set_value',
  'press_key',
  'hotkey',
  'scroll',
  'move_cursor',
  'get_agent_cursor_state',
]);

const SESSION_LIFECYCLE_TOOLS = new Set<ComputerMcpToolName>([
  'start_recording',
]);

/**
 * LLM-supplied local filesystem path args per tool. The driver writes/reads
 * these on the user's disk, so an unconstrained absolute path is a
 * prompt-injection write/read primitive. Every listed arg is resolved and
 * constrained to the session workingDir before dispatch (see guardPathArgs).
 * Omitting the arg leaves the driver's own default behavior untouched.
 */
const COMPUTER_PATH_ARGS: Partial<Record<ComputerMcpToolName, readonly string[]>> = {
  get_window_state: ['screenshot_out_file'],
  click: ['debug_image_out'],
  start_recording: ['output_dir'],
  replay_trajectory: ['dir'],
};

/** 接受 element_index 的动作工具——只有它们参与快照代际校验(见 snapshot-tracker.ts)。 */
const ELEMENT_INDEX_ACTION_TOOLS = new Set<ComputerMcpToolName>([
  'click',
  'double_click',
  'right_click',
  'type_text',
  'set_value',
  'press_key',
  'scroll',
]);

const MAX_REPLAY_TURNS = 1_000;
const MAX_REPLAY_DIRECTORY_ENTRIES = 10_000;
const MAX_REPLAY_ACTION_BYTES = 256 * 1024;
const MAX_REPLAY_TOTAL_ACTION_BYTES = 2 * 1024 * 1024;
const MAX_REPLAY_TOTAL_DELAY_MS = 5 * 60 * 1_000;
const MAX_REPLAY_WALL_CLOCK_MS = 10 * 60 * 1_000;
const MAX_REPLAY_RESULT_SUMMARY_CHARS = 2_048;
const MAX_REPLAY_TOTAL_RESULT_CHARS = 64 * 1024;
const REPLAY_READ_FLAGS =
  fsConstants.O_RDONLY |
  (process.platform === 'win32'
    ? 0
    : (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));

interface ReplayTrajectoryAction {
  turn: string;
  tool: ComputerMcpToolName;
  args: Record<string, unknown>;
  authorizedOutsidePaths: Map<string, AuthorizedOutsidePath>;
}

interface ComputerDispatchOptions {
  pathWorkingDirOverride?: string;
  preAuthorizedOutsidePaths?: Map<string, AuthorizedOutsidePath>;
}

type ComputerMcpTextResult = ReturnType<typeof textResult>;

type ReplayTrajectoryPreparation =
  | { error: ComputerMcpTextResult }
  | {
      directory: string;
      workingRoot: string;
      actions: ReplayTrajectoryAction[];
      delayMs: number;
      stopOnError: boolean;
    };

function serializeJsonSchema(schema: z.ZodObject<z.ZodRawShape>): unknown {
  try {
    return z.toJSONSchema(schema);
  } catch {
    return '<schema serialization failed>';
  }
}

function validationError(name: string, schema: z.ZodObject<z.ZodRawShape>, error: z.ZodError) {
  return textResult(
    {
      ok: false,
      errorCode: 'INVALID_ARGS',
      data: {
        tool: name,
        validation_errors: error.issues,
        schema: serializeJsonSchema(schema),
      },
    },
    true,
  );
}

/** Values retained so INVALID_ARGS can explain an alias/canonical mismatch. */
interface CompatibilityAliasConflict {
  alias: string;
  canonical: string;
  aliasValue: unknown;
  canonicalValue: unknown;
}

/**
 * Normalizes only aliases observed in real failed Computer Use calls. An alias
 * is removed only when the canonical arg is absent or equal; conflicting valid
 * values are rejected, while invalid types fall through to strict Zod parsing.
 * If cua-driver adopts either alias as a real field, remove that alias here
 * before exposing the new driver schema so we never shadow a canonical field.
 */
function normalizeCompatibilityArgs(
  name: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; conflict?: CompatibilityAliasConflict } {
  const normalized = { ...args };

  if (name === 'list_windows' && typeof normalized.app === 'string') {
    if (normalized.process_name === undefined || normalized.process_name === normalized.app) {
      normalized.process_name = normalized.app;
      delete normalized.app;
    } else if (typeof normalized.process_name === 'string') {
      return {
        args: normalized,
        conflict: {
          alias: 'app',
          canonical: 'process_name',
          aliasValue: normalized.app,
          canonicalValue: normalized.process_name,
        },
      };
    }
  }

  if (name === 'get_window_state' && normalized.screenshot === true) {
    if (normalized.capture_mode === undefined || normalized.capture_mode === 'vision') {
      normalized.capture_mode = 'vision';
      delete normalized.screenshot;
    } else if (normalized.capture_mode === 'som' || normalized.capture_mode === 'ax') {
      return {
        args: normalized,
        conflict: {
          alias: 'screenshot',
          canonical: 'capture_mode',
          aliasValue: true,
          canonicalValue: normalized.capture_mode,
        },
      };
    }
  }

  return { args: normalized };
}

/** Returns alias conflicts through the same schema-bearing INVALID_ARGS shape. */
function compatibilityAliasConflictError(
  name: string,
  schema: z.ZodObject<z.ZodRawShape>,
  conflict: CompatibilityAliasConflict,
) {
  return textResult(
    {
      ok: false,
      errorCode: 'INVALID_ARGS',
      data: {
        tool: name,
        validation_errors: [{
          path: [conflict.alias],
          message:
            `Compatibility alias ${conflict.alias} conflicts with ${conflict.canonical}; use only ${conflict.canonical}.`,
          alias_value: conflict.aliasValue,
          canonical_value: conflict.canonicalValue,
        }],
        schema: serializeJsonSchema(schema),
      },
    },
    true,
  );
}

function withSessionArg(
  name: ComputerMcpToolName,
  args: Record<string, unknown>,
  sessionId?: string,
): Record<string, unknown> {
  if (!sessionId) {
    return args;
  }
  if (name === 'get_agent_cursor_state' || name === 'move_cursor') {
    return {
      ...args,
      cursor_id: sessionId,
      ...(name === 'move_cursor' ? { session: sessionId } : {}),
    };
  }
  if (!SESSION_AWARE_TOOLS.has(name) && !SESSION_LIFECYCLE_TOOLS.has(name)) {
    return args;
  }
  return {
    ...args,
    session: sessionId,
  };
}

function readCallContext(options: ComputerMcpServerOptions): ComputerMcpCallContext | undefined {
  const sessionContext = options.getSessionContext?.();
  const sessionId = sessionContext?.sessionId ?? options.sessionId;
  const agentKind = sessionContext?.agentKind;
  return sessionId || agentKind
    ? {
        ...(sessionId ? { sessionId } : {}),
        ...(agentKind ? { agentKind } : {}),
      }
    : undefined;
}

function readSessionId(options: ComputerMcpServerOptions): string | undefined {
  return readCallContext(options)?.sessionId;
}

function isInsideDir(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

type AuthorizedOutsidePath = {
  path: string;
  isCurrent?: () => boolean;
};

function authorizedDirPath(
  authorizedOutsidePaths: Map<string, AuthorizedOutsidePath>,
  key = 'dir',
): string | undefined {
  return authorizedOutsidePaths.get(key)?.path;
}

function outsideGrantExpired(grant?: AuthorizedOutsidePath): boolean {
  return grant?.isCurrent?.() === false;
}

function staleOutsideGrantResult(tool: string, arg: string) {
  return textResult(
    {
      ok: false,
      errorCode: 'PATH_NOT_ALLOWED',
      data: {
        tool,
        arg,
        message: '任务权限已变化，这次越界路径授权已失效。请用当前任务权限重试。',
      },
    },
    true,
  );
}

function reboundOutsideGrantResult(tool: string, arg: string) {
  return textResult(
    {
      ok: false,
      errorCode: 'PATH_NOT_ALLOWED',
      data: {
        tool,
        arg,
        message: '已授权路径在回放前发生变化，已停止读取。请用当前任务权限重试。',
      },
    },
    true,
  );
}

function staleAuthorizedOutsideGrant(
  authorizedOutsidePaths: Map<string, AuthorizedOutsidePath>,
  tool: string,
): ComputerMcpTextResult | null {
  for (const [key, authorized] of authorizedOutsidePaths) {
    if (outsideGrantExpired(authorized)) return staleOutsideGrantResult(tool, key);
  }
  return null;
}

async function replayDirGrantStillBound(
  workingDir: string,
  authorizedOutsidePaths: Map<string, AuthorizedOutsidePath>,
): Promise<ComputerMcpTextResult | null> {
  const dirGrant = authorizedOutsidePaths.get('dir');
  if (!dirGrant) return null;
  if (outsideGrantExpired(dirGrant)) return staleOutsideGrantResult('replay_trajectory', 'dir');
  if (!await authorizedPathStillBound(workingDir, dirGrant)) {
    return reboundOutsideGrantResult('replay_trajectory', 'dir');
  }
  if (outsideGrantExpired(dirGrant)) return staleOutsideGrantResult('replay_trajectory', 'dir');
  return null;
}

async function authorizedPathStillBound(
  workingDir: string,
  authorized: AuthorizedOutsidePath,
): Promise<boolean> {
  return authorizedSessionPathStillBound(workingDir, authorized.path);
}

async function resolveReplayBoundPath(
  workingRoot: string,
  inputPath: string,
  authorizedRoot?: string,
): Promise<string> {
  if (!authorizedRoot) return resolvePathInsideRoot(workingRoot, inputPath);
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workingRoot, inputPath);
  let real: string;
  try {
    real = await fs.realpath(resolved);
  } catch {
    if (!isInsideDir(authorizedRoot, resolved)) {
      throw new PathBoundaryError(`路径越界: "${inputPath}" 不在已授权回放目录内`);
    }
    return resolved;
  }
  if (!isInsideDir(authorizedRoot, real)) {
    throw new PathBoundaryError(`路径越界: "${inputPath}" 不在已授权回放目录内`);
  }
  return resolved;
}

export function createComputerMcpServer(
  deps: ComputerMcpDeps,
  options: ComputerMcpServerOptions = {},
): McpServer {
  const server = new McpServer({ name: 'cindy_computer', version: '0.1.0' });
  // 快照代际状态。claude 路径下每 session 一个 server 实例;codex HTTP bridge 下
  // 单实例跨 session 共享,所以 tracker 内部按 sessionId 分键。
  const snapshotTracker = new WindowSnapshotTracker();

  server.tool('list_tools', DESCRIPTION_LIST, {
    names: z.array(z.enum(COMPUTER_TOOL_NAMES)).min(1).max(COMPUTER_TOOL_NAMES.length).optional(),
  }, async ({ names }) =>
    textResult({
      ok: true,
      tools: COMPUTER_TOOLS.filter((tool) => !names || names.includes(tool.name)).map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly === true,
        inputSchema: z.toJSONSchema(z.object(tool.inputShape).strict()),
      })),
      workflow:
        'Start with status and check_permissions. Reuse these schemas; CLI flags are not MCP arguments. Find the exact pid/window_id with list_windows, optionally query/workspace_root/process_name (for example, {"process_name":"Simulator"}); reuse known identities instead of guessing app names. Inspect with get_window_state (include_screenshot:false for text), then use an action with observe:{} to return the next usable text snapshot in the same call (observe:{include_screenshot:true} for visual evidence), or postcondition for an explicit assertion. Keep query/max_elements/max_depth stable; narrow with query and broaden only if needed. Targeted actions require pid; include window_id whenever known, always for coordinates. Prefer the latest element_token or snapshot_id plus element_index. Re-observe on STALE_SNAPSHOT. A delivered/unverifiable action is not proof of success: assess the observation before continuing. This MCP manages a stable session automatically. If using the native CLI instead, repeat the same non-default session on EVERY observation and action, then end_session; CLI invocations without it are separate leases. Prefer element actions; foreground input already activates its target, so do not also bring_to_front unless it must stay frontmost between calls. Never replay input after cancellation or uncertain delivery. Record/replay only when explicitly requested.',
    }),
  );

  server.tool(
    'call_tool',
    DESCRIPTION_CALL,
    {
      name: z.enum(COMPUTER_TOOL_NAMES).describe('Tool name from list_tools'),
      args: jsonObjectArg('Arguments object for the selected tool'),
    },
    async ({ name, args }, extra) => {
      const result = await handleCallTool(name, args, extra.signal);
      // errorCode 遥测:UNKNOWN_TOOL / INVALID_ARGS / COMPUTER_DRIVER_ERROR 返回给
      // 模型自纠之前在这里落一条日志(见 tool-error-telemetry.ts)。
      logToolResultErrorCode({
        logger: deps.logger,
        server: 'cindy_computer',
        tool: name,
        result,
        sessionId: readSessionId(options),
      });
      return result;
    },
  );

  async function handleCallTool(
    name: string,
    args: Record<string, unknown> | undefined,
    signal?: AbortSignal,
    dispatchOptions?: ComputerDispatchOptions,
  ): Promise<ReturnType<typeof textResult>> {
    const def = getComputerTool(name);
    if (!def) {
      return textResult({ ok: false, errorCode: 'UNKNOWN_TOOL', data: { requested: name } }, true);
    }

    const schema = z.object(def.inputShape).strict();
    const normalized = normalizeCompatibilityArgs(name, args ?? {});
    if (normalized.conflict) {
      return compatibilityAliasConflictError(name, schema, normalized.conflict);
    }
    const parsed = schema.safeParse(normalized.args);
    if (!parsed.success) {
      return validationError(name, schema, parsed.error);
    }
    if (signal?.aborted) return replayCancelledResult();
    const callContext = readCallContext(options);
    const sessionId = callContext?.sessionId;
    const parsedData = parsed.data as Record<string, unknown>;

    // Resolve every local path before a guard reads it. In particular,
    // trajectory inspection must never follow a model-supplied path outside
    // the current task working directory. Keep the grant map on this call so
    // concurrent Codex HTTP dispatches cannot steal each other's authorized root.
    const authorizedOutsidePaths = new Map(dispatchOptions?.preAuthorizedOutsidePaths);
    const pathGuardError = await guardPathArgs(
      name as ComputerMcpToolName,
      parsedData,
      dispatchOptions?.pathWorkingDirOverride,
      authorizedOutsidePaths,
    );
    if (pathGuardError) return pathGuardError;

    if (name === 'replay_trajectory') {
      return replayTrajectoryWithGuards(parsedData, signal, authorizedOutsidePaths);
    }

    // 快照代际护栏:element_index 指向"某次 get_window_state 的第几项",观察和
    // 动作之间 UI 树变化时会静默作用到错误元素。带 snapshot_id 的动作在此校验
    // 它是否仍是目标窗口最新观察;不带的放行(过渡兼容)但打遥测日志。
    const staleResult = checkSnapshotFreshness(
      name as ComputerMcpToolName,
      parsedData,
      sessionId,
    );
    if (staleResult) return staleResult;
    const secureFieldResult = await checkSecureField(name as ComputerMcpToolName, parsedData, sessionId);
    if (secureFieldResult) return secureFieldResult;
    const postcondition = parsedData.postcondition;
    const observe = parsedData.observe as Record<string, unknown> | undefined;
    delete parsedData.postcondition; // Cindy-owned verification, never part of driver action args.
    delete parsedData.observe;
    if (observe && postcondition) {
      return textResult({ ok: false, errorCode: 'INVALID_ARGS', data: {
        message: 'Use observe for a fresh snapshot or postcondition for an assertion, not both.',
      } }, true);
    }
    if ((postcondition || observe) && typeof parsedData.window_id !== "number") {
      return textResult(
        {
          ok: false,
          errorCode: "INVALID_ARGS",
          data: {
            message:
              "postcondition/observe requires an exact window_id or a fresh element snapshot identifying the window.",
          },
        },
        true,
      );
    }
    const observationScope = snapshotTracker.observationScope(sessionId, parsedData.pid as number, parsedData.window_id as number);
    if (typeof parsedData.snapshot_id === "string") {
      const driverId = snapshotTracker.driverSnapshotId(
        sessionId,
        parsedData.snapshot_id,
      );
      if (driverId) parsedData.snapshot_id = driverId;
      else delete parsedData.snapshot_id; // Legacy drivers have no native snapshot ids.
    }
    if (name === 'set_value' && parsedData.element_index === undefined && parsedData.element_token === undefined) {
      return textResult({ ok: false, errorCode: 'INVALID_ARGS', data: { message: 'set_value requires element_token or element_index.' } }, true);
    }
    if (name === 'verify_state' || name === 'get_window_state') {
      snapshotTracker.invalidate(sessionId, parsedData.pid as number, parsedData.window_id as number);
    }
    if (signal?.aborted) return replayCancelledResult();

    const workingDir = dispatchOptions?.pathWorkingDirOverride
      ?? options.getSessionContext?.().workingDir
      ?? '';
    for (const [key, authorized] of authorizedOutsidePaths) {
      if (outsideGrantExpired(authorized)) {
        return staleOutsideGrantResult(name, key);
      }
      if (!workingDir || !await authorizedPathStillBound(workingDir, authorized)) {
        return textResult(
          {
            ok: false,
            errorCode: 'PATH_NOT_ALLOWED',
            data: {
              tool: name,
              arg: key,
              message: '已授权路径在派发前发生变化，已停止写入。请用当前任务权限重试。',
            },
          },
          true,
        );
      }
    }
    const staleAfterBind = staleAuthorizedOutsideGrant(authorizedOutsidePaths, name);
    if (staleAfterBind) return staleAfterBind;

    const parsedArgs = withSessionArg(
      name as ComputerMcpToolName,
      parsedData,
      sessionId,
    );
    // Both delivered and uncertain actions honor an explicit observation request.
    // Keep its normal read guards and registration in one path; never replay input.
    const readActionObservation = async () => {
      const read = await handleCallTool('get_window_state', {
        ...observationScope,
        ...observe,
        pid: parsedData.pid,
        window_id: parsedData.window_id,
        include_screenshot: observe?.include_screenshot ?? false,
        ...(typeof parsedData.session === 'string' ? { session: parsedData.session } : {}),
      }, signal, dispatchOptions);
      return JSON.parse(read.content[0].text) as Record<string, unknown>;
    };

    try {
      const data = await callComputerTool(
        deps,
        name as ComputerMcpToolName,
        parsedArgs,
        { ...callContext, signal },
      );
      if (
        name === 'get_window_state' &&
        isUnavailableWindowObservation(data, parsedData)
      ) {
        invalidateWindowSnapshot(name, parsedData, sessionId);
        const recovery = isWindowIdentityFailure(data)
          ? await rediscoverWindow(parsedData, { ...callContext, signal })
          : undefined;
        return textResult(
          {
            ok: false,
            tool: name,
            errorCode: 'CUA_UNAVAILABLE',
            hint: 'The requested window observation failed. Do not reuse earlier snapshot IDs, element indices or coordinates. Check status/check_permissions and refresh list_windows for the target; after the window or capture state recovers, call get_window_state again. Repeated capture failure requires recovery before further actions.',
            data,
            ...(recovery ? { recovery } : {}),
          },
          true,
        );
      }
      let outcome = computerResultOutcome(name, data);
      const recovery =
        name !== "get_window_state" && isWindowIdentityFailure(data)
          ? await rediscoverWindow(parsedData, { ...callContext, signal })
          : undefined;
      const postcheck =
        !recovery &&
        !observe &&
        POSTCHECK_ACTION_TOOLS.has(name as ComputerMcpToolName) &&
        outcome.ok &&
        (postcondition || outcome.outcome?.status === "unknown")
          ? await checkActionState(parsedData, postcondition, {
              ...callContext,
              signal,
            })
          : undefined;
      // Use the normal explicit-read path: host session ownership, secure-field
      // frames, output handling and fresh element registration remain identical.
      // A returned observation is evidence, never a reason to replay the input.
      const observation = observe && !recovery && outcome.ok && !signal?.aborted
        ? await readActionObservation()
        : undefined;
      if (postcondition && postcheck) {
        const checked = computerResultOutcome("verify_state", postcheck.data);
        // An interrupted multi-chunk input is not a completed action, even if a
        // weak predicate happens to match the already-written prefix.
        const remaining = (data as { remaining_chars?: number } | null)
          ?.remaining_chars;
        if (postcheck.ok && !(typeof remaining === "number" && remaining > 0))
          outcome = checked;
        else if (!postcheck.ok) outcome = checked;
      }
      if (signal?.aborted)
        throw Object.assign(
          new Error("Computer Use cancelled during recovery"),
          { outcomeUnknown: !def.readOnly },
        );
      const snapshotId = recovery
        ? undefined
        : recordWindowSnapshot(
            name as ComputerMcpToolName,
            parsedData,
            data,
            sessionId,
          );
      return textResult(
        {
          ...outcome,
          tool: name,
          ...(snapshotId ? { snapshot_id: snapshotId } : {}),
          data: withoutDuplicateElements(name, data),
          ...(recovery ? { recovery } : {}),
          ...(postcheck ? { postcheck } : {}),
          ...(observation ? { observation } : {}),
        },
        !outcome.ok,
      );
    } catch (err) {
      const errorCode = signal?.aborted
        ? "REQUEST_CANCELLED"
        : typeof (err as { code?: unknown })?.code === "string"
          ? (err as { code: string }).code
          : "COMPUTER_DRIVER_ERROR";
      const windowUnresolved = isWindowIdentityFailure(err);
      invalidateWindowSnapshot(name, parsedData, sessionId);
      if (
        (windowUnresolved ||
          signal?.aborted ||
          (err as { outcomeUnknown?: boolean })?.outcomeUnknown) &&
        typeof parsedData.pid === "number" &&
        typeof parsedData.window_id === "number"
      ) {
        snapshotTracker.invalidate(
          sessionId,
          parsedData.pid,
          parsedData.window_id,
        );
      }
      const recovery =
        windowUnresolved && !signal?.aborted
          ? await rediscoverWindow(parsedData, { ...callContext, signal })
          : undefined;
      const shouldObserveUnknownAction =
        !recovery &&
        !signal?.aborted &&
        errorCode !== "REQUEST_CANCELLED" &&
        POSTCHECK_ACTION_TOOLS.has(name as ComputerMcpToolName) &&
        (err as { outcomeUnknown?: boolean })?.outcomeUnknown;
      const observation = observe && shouldObserveUnknownAction
        ? await readActionObservation()
        : undefined;
      const postcheck = !observe && shouldObserveUnknownAction
        ? await checkActionState(parsedData, postcondition, {
            ...callContext,
            signal,
          })
        : undefined;
      const installedDiscovery =
        name === "launch_app" &&
        !signal?.aborted &&
        isAppNameResolutionFailure(parsedData, err)
          ? await readForRecovery(
              deps,
              "list_apps",
              {},
              { ...callContext, signal },
            )
          : undefined;
      const bundleId = installedDiscovery?.ok
        ? exactInstalledAppBundle(
            parsedData.name as string,
            installedDiscovery.data,
          )
        : undefined;
      if (bundleId && !signal?.aborted) {
        // The first call explicitly failed before launching. Resolve the name
        // once, preserving URLs/options; no recursive fallback after this call.
        try {
          const data = await callComputerTool(
            deps,
            "launch_app",
            { ...parsedData, bundle_id: bundleId },
            { ...callContext, signal },
          );
          if (signal?.aborted)
            throw Object.assign(new Error("Application launch cancelled"), {
              code: "REQUEST_CANCELLED",
              outcomeUnknown: true,
            });
          const outcome = computerResultOutcome("launch_app", data);
          return textResult(
            {
              ...outcome,
              tool: name,
              data,
              recovery: {
                resolved_bundle_id: bundleId,
                discovery: installedDiscovery,
              },
            },
            !outcome.ok,
          );
        } catch (launchError) {
          return textResult(
            {
              ok: false,
              errorCode:
                typeof (launchError as { code?: unknown })?.code === "string"
                  ? (launchError as { code: string }).code
                  : "COMPUTER_DRIVER_ERROR",
              data: {
                message:
                  launchError instanceof Error
                    ? launchError.message
                    : String(launchError),
                ...((launchError as { outcomeUnknown?: boolean })
                  ?.outcomeUnknown
                  ? { outcome_unknown: true }
                  : {}),
              },
              recovery: {
                original_error:
                  err instanceof Error ? err.message : String(err),
                discovery: installedDiscovery,
                resolved_bundle_id: bundleId,
                retry_exhausted: true,
              },
            },
            true,
          );
        }
      }
      const appDiscovery =
        name === "launch_app" &&
        !signal?.aborted &&
        canLocateRunningApp(parsedData, err)
          ? await readForRecovery(
              deps,
              "list_windows",
              withSessionArg("list_windows", {}, sessionId),
              { ...callContext, signal },
            )
          : undefined;
      const located = appDiscovery?.ok
        ? exactRunningApp(parsedData.name as string, appDiscovery.data)
        : undefined;
      if (located && !signal?.aborted) {
        return textResult({
          ok: true,
          tool: name,
          data: {
            ...located,
            located: true,
            launched: false,
            source: "running_windows",
          },
          recovery: {
            original_error: {
              code: errorCode,
              message: err instanceof Error ? err.message : String(err),
            },
            discovery: appDiscovery,
          },
        });
      }
      return textResult(
        {
          ok: false,
          errorCode,
          ...(recovery ? { recovery } : {}),
          ...(postcheck ? { postcheck } : {}),
          ...(observation ? { observation } : {}),
          ...(appDiscovery || installedDiscovery
            ? {
                recovery: {
                  discovery: appDiscovery,
                  installed_discovery: installedDiscovery,
                  next_step: "choose_application",
                  target_selected: false,
                },
              }
            : {}),
          data: {
            message: err instanceof Error ? err.message : String(err),
            ...((err as { inputProgress?: unknown })?.inputProgress
              ? { input_progress: (err as { inputProgress: unknown }).inputProgress }
              : {}),
            ...((err as { outcomeUnknown?: boolean })?.outcomeUnknown
              ? { outcome_unknown: true, next_step: "fresh_state" }
              : {}),
            ...(windowUnresolved
              ? {
                  next_step: "list_windows",
                  hint: "Rediscover the target PID/window, then take fresh get_window_state before acting. Do not reuse old element references or automatically switch to a similar window.",
                }
              : {}),
          },
        },
        true,
      );
    }
  }

  async function rediscoverWindow(
    args: Record<string, unknown>,
    context: ComputerMcpCallContext,
  ) {
    if (typeof args.pid === "number" && typeof args.window_id === "number") {
      snapshotTracker.invalidate(context.sessionId, args.pid, args.window_id);
    }
    // Enumerate afresh without the obsolete PID filter so a dev restart is
    // visible. Candidates are evidence for the agent, not permission to retarget.
    const discovery = await readForRecovery(
      deps,
      "list_windows",
      withSessionArg("list_windows", {}, context.sessionId),
      context,
    );
    return {
      requested_target: { pid: args.pid, window_id: args.window_id },
      discovery,
      target_selected: false,
      next_step: "get_window_state",
    };
  }

  async function checkActionState(
    args: Record<string, unknown>,
    postcondition: unknown,
    context: ComputerMcpCallContext,
  ) {
    if (typeof args.pid !== "number" || typeof args.window_id !== "number") {
      return readForRecovery(
        deps,
        "list_windows",
        withSessionArg("list_windows", { pid: args.pid }, context.sessionId),
        context,
      );
    }
    const scope = snapshotTracker.observationScope(context.sessionId, args.pid, args.window_id);
    snapshotTracker.invalidate(context.sessionId, args.pid, args.window_id);
    const tool = postcondition ? "verify_state" : "get_window_state";
    const readArgs = {
      pid: args.pid,
      window_id: args.window_id,
      ...(postcondition
        ? {
            expect: postcondition,
            timeout_ms: 1500,
            stable_samples: 2,
            include_screenshot: false,
          }
        // Automatic evidence must not create unmanaged screenshots of user windows.
        // It is never reused for element actions, so the compact tree is enough.
        : {
            ...scope,
            include_screenshot: false,
            tree_format: "markdown",
            // CUA 0.37's structured diff fails its own output validation. Only
            // non-reusable Markdown evidence uses since; actionable reads stay full.
            ...(scope ? { since: 'latest' } : {}),
          }),
    };
    const read = await readForRecovery(
      deps,
      tool,
      withSessionArg(tool, readArgs, context.sessionId),
      context,
    );
    if (tool === "get_window_state" && read.ok) {
      if (isUnavailableWindowObservation(read.data, readArgs))
        return { ...read, ok: false };
      // This is post-action evidence, not a reusable element observation. A late
      // automatic read must not supersede another caller's newer explicit state.
      return {
        ...read,
        reusable_snapshot: false,
        next_step: "get_window_state",
      };
    }
    return read;
  }

  function invalidateWindowSnapshot(
    name: string,
    args: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    if (
      name === 'get_window_state' &&
      typeof args.pid === 'number' &&
      typeof args.window_id === 'number'
    ) {
      snapshotTracker.invalidate(sessionId, args.pid, args.window_id);
    }
  }

  function trajectoryValidationFailedResult(message: string, turn?: string) {
    return textResult(
      {
        ok: false,
        errorCode: 'TRAJECTORY_VALIDATION_FAILED',
        data: {
          message,
          ...(turn ? { turn } : {}),
        },
      },
      true,
    );
  }

  function replayCancelledResult() {
    return textResult(
      {
        ok: false,
        errorCode: 'REQUEST_CANCELLED',
        data: { message: 'Trajectory replay stopped because the request was cancelled.' },
      },
      true,
    );
  }

  function replayBudgetExceededResult() {
    return textResult(
      {
        ok: false,
        errorCode: 'REPLAY_BUDGET_EXCEEDED',
        data: { message: 'Trajectory replay exceeded Cindy\'s bounded execution budget.' },
      },
      true,
    );
  }

  async function readBoundedReplayAction(
    actionFile: Awaited<ReturnType<typeof fs.open>>,
    signal?: AbortSignal,
  ): Promise<{ text: string; bytes: number }> {
    const chunks: Buffer[] = [];
    let position = 0;
    while (position <= MAX_REPLAY_ACTION_BYTES) {
      if (signal?.aborted) throw new DOMException('Replay cancelled', 'AbortError');
      const remaining = MAX_REPLAY_ACTION_BYTES + 1 - position;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await actionFile.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position > MAX_REPLAY_ACTION_BYTES) {
      throw new Error('Recorded action exceeds the per-action byte limit.');
    }
    return {
      text: Buffer.concat(chunks, position).toString('utf8'),
      bytes: position,
    };
  }

  async function waitForReplayDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
    if (delayMs <= 0) return signal?.aborted !== true;
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function prepareReplayTrajectory(
    parsedData: Record<string, unknown>,
    signal: AbortSignal | undefined,
    authorizedOutsidePaths: Map<string, AuthorizedOutsidePath>,
  ): Promise<ReplayTrajectoryPreparation> {
    const directory = parsedData.dir;
    const workingDir = options.getSessionContext?.().workingDir ?? '';
    if (typeof directory !== 'string' || !workingDir) {
      return {
        error: trajectoryValidationFailedResult(
          'Cindy could not safely resolve the trajectory directory.',
        ),
      };
    }

    let workingRoot: string;
    let trajectoryRoot: string;
    const candidates: string[] = [];
    try {
      workingRoot = await fs.realpath(workingDir);
      // handleCallTool already constrained `directory` against the original
      // workingDir spelling. Canonicalize both sides before comparing again so
      // a legitimate symlinked workspace (including macOS /var -> /private/var)
      // is not rejected by a lexical alias mismatch.
      trajectoryRoot = await fs.realpath(directory);
      const authorizedRoot = authorizedDirPath(authorizedOutsidePaths);
      if (authorizedRoot) {
        const rebound = await replayDirGrantStillBound(workingDir, authorizedOutsidePaths);
        if (rebound) return { error: rebound };
        if (!isInsideDir(authorizedRoot, trajectoryRoot)) {
          throw new PathBoundaryError('回放目录不再匹配已授权路径');
        }
      } else {
        await resolvePathInsideRoot(workingRoot, trajectoryRoot);
      }

      let entryCount = 0;
      const trajectoryDirectory = await fs.opendir(trajectoryRoot);
      for await (const entry of trajectoryDirectory) {
        if (signal?.aborted) return { error: replayCancelledResult() };
        entryCount += 1;
        if (entryCount > MAX_REPLAY_DIRECTORY_ENTRIES) {
          return {
            error: trajectoryValidationFailedResult(
              `Trajectory directory exceeds the ${MAX_REPLAY_DIRECTORY_ENTRIES}-entry safety limit.`,
            ),
          };
        }
        if (!entry.name.startsWith('turn-')) continue;
        candidates.push(entry.name);
        if (candidates.length > MAX_REPLAY_TURNS) {
          return {
            error: trajectoryValidationFailedResult(
              `Trajectory exceeds the ${MAX_REPLAY_TURNS}-turn safety limit.`,
            ),
          };
        }
      }
      candidates.sort();
    } catch (error) {
      if (signal?.aborted) return { error: replayCancelledResult() };
      deps.logger?.warn('failed to inspect Computer Use trajectory directory', {
        directory,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        error: trajectoryValidationFailedResult(
          'Cindy could not read the trajectory directory before replay.',
        ),
      };
    }

    const actions: ReplayTrajectoryAction[] = [];
    let totalActionBytes = 0;
    for (const turn of candidates) {
      try {
        if (signal?.aborted) return { error: replayCancelledResult() };
        const rebound = await replayDirGrantStillBound(workingDir, authorizedOutsidePaths);
        if (rebound) return { error: rebound };
        const turnPath = await resolveReplayBoundPath(
          workingRoot,
          path.join(trajectoryRoot, turn),
          authorizedDirPath(authorizedOutsidePaths),
        );
        if (!(await fs.lstat(turnPath)).isDirectory()) {
          return {
            error: trajectoryValidationFailedResult(
              'Recorded turn must be a real directory, not a file or symbolic link.',
              turn,
            ),
          };
        }

        const actionPath = await resolveReplayBoundPath(
          workingRoot,
          path.join(turnPath, 'action.json'),
          authorizedDirPath(authorizedOutsidePaths),
        );
        if ((await fs.lstat(actionPath)).isSymbolicLink()) {
          return {
            error: trajectoryValidationFailedResult(
              'Recorded action must be a real file, not a symbolic link.',
              turn,
            ),
          };
        }
        const canonicalActionPath = await fs.realpath(actionPath);
        await resolveReplayBoundPath(
          workingRoot,
          canonicalActionPath,
          authorizedDirPath(authorizedOutsidePaths),
        );
        const actionFile = await fs.open(actionPath, REPLAY_READ_FLAGS);
        let actionText: string;
        try {
          const stat = await actionFile.stat();
          if (!stat.isFile() || stat.size > MAX_REPLAY_ACTION_BYTES) {
            return {
              error: trajectoryValidationFailedResult(
                'The recorded action is not a bounded regular JSON file.',
                turn,
              ),
            };
          }
          const currentCanonicalPath = await fs.realpath(actionPath);
          await resolveReplayBoundPath(
            workingRoot,
            currentCanonicalPath,
            authorizedDirPath(authorizedOutsidePaths),
          );
          const currentStat = await fs.stat(currentCanonicalPath);
          if (currentStat.dev !== stat.dev || currentStat.ino !== stat.ino) {
            return {
              error: trajectoryValidationFailedResult(
                'The recorded action changed while Cindy was opening it.',
                turn,
              ),
            };
          }
          const boundedAction = await readBoundedReplayAction(actionFile, signal);
          totalActionBytes += boundedAction.bytes;
          if (totalActionBytes > MAX_REPLAY_TOTAL_ACTION_BYTES) {
            return {
              error: trajectoryValidationFailedResult(
                `Trajectory exceeds the ${MAX_REPLAY_TOTAL_ACTION_BYTES}-byte aggregate safety limit.`,
                turn,
              ),
            };
          }
          actionText = boundedAction.text;
        } finally {
          await actionFile.close();
        }

        const rawAction: unknown = JSON.parse(actionText);
        if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) {
          return {
            error: trajectoryValidationFailedResult(
              'The recorded action must be a JSON object.',
              turn,
            ),
          };
        }
        const action = rawAction as Record<string, unknown>;
        const tool = action.tool;
        if (typeof tool !== 'string' || tool === 'replay_trajectory') {
          return {
            error: trajectoryValidationFailedResult(
              'Nested or unnamed trajectory replay actions are not allowed.',
              turn,
            ),
          };
        }
        const definition = getComputerTool(tool);
        if (!definition) {
          return {
            error: trajectoryValidationFailedResult(
              `Recorded tool ${tool} is not exposed by this Cindy version.`,
              turn,
            ),
          };
        }
        const toolName = tool as ComputerMcpToolName;
        const rawArgs = action.arguments ?? {};
        if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
          return {
            error: trajectoryValidationFailedResult(
              'Recorded tool arguments must be a JSON object.',
              turn,
            ),
          };
        }
        const normalized = normalizeCompatibilityArgs(tool, rawArgs as Record<string, unknown>);
        if (normalized.conflict) {
          return {
            error: trajectoryValidationFailedResult(
              `Recorded tool ${tool} contains conflicting compatibility arguments.`,
              turn,
            ),
          };
        }
        const parsed = z.object(definition.inputShape).strict().safeParse(normalized.args);
        if (!parsed.success) {
          return {
            error: trajectoryValidationFailedResult(
              `Recorded tool ${tool} does not match the current Cindy schema.`,
              turn,
            ),
          };
        }
        const args = parsed.data as Record<string, unknown>;
        const nestedGrants = new Map<string, AuthorizedOutsidePath>();
        const nestedPathError = await guardPathArgs(toolName, args, workingRoot, nestedGrants);
        if (nestedPathError) return { error: nestedPathError };
        actions.push({ turn, tool: toolName, args, authorizedOutsidePaths: nestedGrants });
      } catch (error) {
        if (signal?.aborted) return { error: replayCancelledResult() };
        deps.logger?.warn('failed to validate Computer Use trajectory action', {
          directory,
          turn,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          error: trajectoryValidationFailedResult(
            'Cindy could not safely validate this recorded action.',
            turn,
          ),
        };
      }
    }

    if (actions.length === 0) {
      return {
        error: trajectoryValidationFailedResult(
          'No replayable turn directories were found in the trajectory.',
        ),
      };
    }
    const delayMs = typeof parsedData.delay_ms === 'number' ? parsedData.delay_ms : 500;
    if (delayMs * Math.max(actions.length - 1, 0) > MAX_REPLAY_TOTAL_DELAY_MS) {
      return {
        error: trajectoryValidationFailedResult(
          `Trajectory exceeds the ${MAX_REPLAY_TOTAL_DELAY_MS}-millisecond aggregate delay limit.`,
        ),
      };
    }
    return {
      directory,
      workingRoot,
      actions,
      delayMs,
      stopOnError: parsedData.stop_on_error !== false,
    };
  }

  function serializeReplaySummaryValue(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return String(value);
    }
  }

  function replayResultSummary(result: ComputerMcpTextResult, maxChars: number): string {
    const raw = result.content.find((block) => block.type === 'text')?.text ?? '';
    let summary = raw;
    try {
      const payload: unknown = JSON.parse(raw);
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const envelope = payload as Record<string, unknown>;
        const data = envelope.data;
        if (envelope.ok === true && Object.hasOwn(envelope, 'data')) {
          // Match the driver's replay contract: summarize the recorded tool's
          // own result, not Cindy's surrounding { ok, tool, data } envelope.
          summary = serializeReplaySummaryValue(data);
        } else if (typeof envelope.errorCode === 'string') {
          const message = data && typeof data === 'object' && !Array.isArray(data)
            ? (data as Record<string, unknown>).message
            : undefined;
          if (envelope.errorCode === 'COMPUTER_DRIVER_ERROR' && typeof message === 'string') {
            summary = message;
          } else {
            summary = typeof message === 'string'
              ? `${envelope.errorCode}: ${message}`
              : envelope.errorCode;
          }
        }
      }
    } catch {
      // Preserve non-JSON text returned by an older or custom host.
    }
    if (summary.length <= maxChars) return summary;
    if (maxChars <= 1) return summary.slice(0, maxChars);
    return `${summary.slice(0, maxChars - 1)}…`;
  }

  async function replayTrajectoryWithGuards(
    parsedData: Record<string, unknown>,
    signal: AbortSignal | undefined,
    authorizedOutsidePaths: Map<string, AuthorizedOutsidePath>,
  ) {
    const prepared = await prepareReplayTrajectory(parsedData, signal, authorizedOutsidePaths);
    if ('error' in prepared) return prepared.error;

    const startedAt = Date.now();
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    let resultSummaryChars = 0;
    const turns: Array<{
      turn: string;
      tool: ComputerMcpToolName;
      ok: boolean;
      result_summary: string;
    }> = [];
    let firstFailure: { turn: string; tool: ComputerMcpToolName; error: string } | undefined;

    for (const [index, action] of prepared.actions.entries()) {
      if (signal?.aborted) return replayCancelledResult();
      const rebound = await replayDirGrantStillBound(
        options.getSessionContext?.().workingDir ?? '',
        authorizedOutsidePaths,
      );
      if (rebound) return rebound;
      if (Date.now() - startedAt >= MAX_REPLAY_WALL_CLOCK_MS) {
        return replayBudgetExceededResult();
      }
      attempted += 1;
      // Re-enter Cindy's normal dispatch path immediately before every action.
      // This closes both PID-reuse and mutable-action-file races that a single
      // preflight followed by the driver's nested replay would leave open.
      const result = await handleCallTool(action.tool, action.args, signal, {
        // Preflight normalized nested path arguments against this canonical
        // root. Reuse it so a symlink spelling of the session workingDir does
        // not make those immutable absolute paths look lexically out of scope.
        pathWorkingDirOverride: prepared.workingRoot,
        preAuthorizedOutsidePaths: action.authorizedOutsidePaths,
      });
      if (signal?.aborted) return replayCancelledResult();
      const payload = JSON.parse(result.content[0].text) as { outcome?: { status?: string }; data?: { outcome_unknown?: boolean } };
      const outcomeUnknown = payload.outcome?.status === 'unknown' || payload.data?.outcome_unknown === true;
      const isError = result.isError === true || outcomeUnknown;
      const summaryBudget = Math.max(
        0,
        Math.min(
          MAX_REPLAY_RESULT_SUMMARY_CHARS,
          MAX_REPLAY_TOTAL_RESULT_CHARS - resultSummaryChars,
        ),
      );
      const summary = replayResultSummary(result, summaryBudget);
      resultSummaryChars += summary.length;
      turns.push({
        turn: action.turn,
        tool: action.tool,
        ok: !isError,
        result_summary: summary,
      });
      if (isError) {
        failed += 1;
        firstFailure ??= {
          turn: action.turn,
          tool: action.tool,
          error: summary,
        };
        if (prepared.stopOnError || outcomeUnknown) break;
      } else {
        succeeded += 1;
      }
      if (index < prepared.actions.length - 1) {
        const completedDelay = await waitForReplayDelay(prepared.delayMs, signal);
        if (!completedDelay) return replayCancelledResult();
      }
    }

    return textResult({
      ok: true,
      tool: 'replay_trajectory',
      data: {
        directory: prepared.directory,
        attempted,
        succeeded,
        failed,
        stop_on_error: prepared.stopOnError,
        turns,
        ...(firstFailure ? { first_failure: firstFailure } : {}),
      },
    });
  }

  /**
   * 把工具入参里的本地文件路径约束到 session workingDir。返回 null 放行(路径
   * 已被替换为约束后的绝对路径),返回结果对象表示以 PATH_NOT_ALLOWED 拒绝。
   * 无 workingDir 时对显式传入的路径 fail-closed(driver 侧无 in-package 默认可回落,
   * 缺省 arg 时才由 driver 自己决定默认,不受影响)。
   */
  async function guardPathArgs(
    name: ComputerMcpToolName,
    parsedData: Record<string, unknown>,
    workingDirOverride: string | undefined,
    authorizedOutsidePaths: Map<string, AuthorizedOutsidePath>,
  ) {
    const argNames = COMPUTER_PATH_ARGS[name];
    if (!argNames) return null;
    const workingDir = workingDirOverride ?? options.getSessionContext?.().workingDir ?? '';
    for (const key of argNames) {
      const value = parsedData[key];
      if (typeof value !== 'string' || value.length === 0) continue;
      if (!workingDir || workingDir.trim().length === 0) {
        return textResult(
          {
            ok: false,
            errorCode: 'PATH_NOT_ALLOWED',
            data: {
              tool: name,
              arg: key,
              message: key === 'screenshot_out_file'
                ? '当前会话无 workingDir，出于安全禁止写入该本地路径。请省略 screenshot_out_file 由 driver 使用默认路径；如需显式路径，请在具有 workingDir 的会话中使用其内部路径。'
                : '当前会话无 workingDir，出于安全禁止写入/读取该本地路径。',
            },
          },
          true,
        );
      }
      try {
        parsedData[key] = await resolvePathInsideRoot(workingDir, value);
      } catch (e) {
        if (e instanceof PathBoundaryError) {
          const sessionContext = options.getSessionContext?.();
          const abs = await resolveCanonicalSessionPath(workingDir, value);
          const existing = authorizedOutsidePaths.get(key);
          if (
            existing
            && existing.path === abs
            && existing.isCurrent?.() !== false
            && await authorizedPathStillBound(workingDir, existing)
          ) {
            parsedData[key] = abs;
            continue;
          }
          const auth = await authorizeSessionPathOutsideWorkdir({
            sessionId: sessionContext?.sessionId,
            sessionInstanceId: sessionContext?.sessionInstanceId,
            workingDir,
            remoteHostId: sessionContext?.remoteHostId,
            path: abs,
            toolName: `cindy-computer:${name}`,
            operation: name === 'replay_trajectory' ? 'read' : 'write',
          });
          if (auth.allowed) {
            parsedData[key] = abs;
            authorizedOutsidePaths.set(key, {
              path: abs,
              ...(auth.isCurrent ? { isCurrent: auth.isCurrent } : {}),
            });
            continue;
          }
          return textResult(
            {
              ok: false,
              errorCode: 'PATH_NOT_ALLOWED',
              data: {
                tool: name,
                arg: key,
                message: key === 'screenshot_out_file'
                  ? `${auth.reason} 也可省略 screenshot_out_file 由 driver 使用默认路径。`
                  : auth.reason,
              },
            },
            true,
          );
        }
        throw e;
      }
    }
    return null;
  }

  /**
   * element_index 动作的快照新鲜度校验。返回 null 表示放行;
   * 返回结果对象表示直接以 STALE_SNAPSHOT 拒绝(不派发 driver)。
   */
  function checkSnapshotFreshness(
    name: ComputerMcpToolName,
    parsedData: Record<string, unknown>,
    sessionId: string | undefined,
  ) {
    if (!ELEMENT_INDEX_ACTION_TOOLS.has(name)) return null;
    if (typeof parsedData.element_index !== 'number' && typeof parsedData.element_token !== 'string') return null;
    const pid = parsedData.pid as number;
    const windowId = typeof parsedData.window_id === 'number' ? parsedData.window_id : undefined;

    let snapshotId = typeof parsedData.snapshot_id === 'string' ? parsedData.snapshot_id : undefined;
    if (typeof parsedData.element_token === 'string') {
      const ref = snapshotTracker.elementReference(sessionId, parsedData.element_token, snapshotId);
      if (!ref || (typeof parsedData.element_index === 'number' && ref.index !== parsedData.element_index)
        || (snapshotId && !snapshotTracker.sameSnapshot(sessionId, snapshotId, ref.snapshotId))) {
        return textResult({ ok: false, errorCode: 'STALE_SNAPSHOT', data: { message: 'Unknown or conflicting element token. Call get_window_state again.' } }, true);
      }
      snapshotId = ref.snapshotId;
      if (windowId === undefined) parsedData.window_id = ref.windowId;
    }
    if (!snapshotId) {
      // 过渡兼容:老调用方 / 未升级的 agent 不带 snapshot_id,放行但留痕,
      // 后续可据此评估何时收紧为强制。
      deps.logger?.warn('element_index action without snapshot_id', {
        server: 'cindy_computer',
        tool: name,
        ...(sessionId ? { sessionId } : {}),
      });
      return null;
    }

    const verdict = snapshotTracker.validate(sessionId, snapshotId, pid, windowId);
    if (verdict.ok) {
      parsedData.window_id ??= snapshotTracker.windowId(sessionId, snapshotId);
      return null;
    }
    return textResult(
      {
        ok: false,
        errorCode: 'STALE_SNAPSHOT',
        data: {
          tool: name,
          snapshot_id: snapshotId,
          reason: verdict.reason,
          hint:
            'The element reference does not identify the latest observation of this window. Call get_window_state again, then use its top-level snapshot_id with element_index or element_token. Supplying that snapshot_id is required when the driver reuses tokens between observations.',
        },
      },
      true,
    );
  }

  /**
   * 代输入 hint: a password field is the owner's to fill. Typing into one from
   * the agent would put the secret in the model's context, so refuse and point
   * at ask_owner (kind fill). Runs after the freshness check resolved the target.
   */
  async function checkSecureField(
    name: ComputerMcpToolName,
    parsedData: Record<string, unknown>,
    sessionId: string | undefined,
  ) {
    if ((name !== 'type_text' && name !== 'set_value') || !deps.isSecureTarget) return null;
    const pid = parsedData.pid as number;
    let snapshotId = typeof parsedData.snapshot_id === 'string' ? parsedData.snapshot_id : undefined;
    let index = typeof parsedData.element_index === 'number' ? parsedData.element_index : undefined;
    if (typeof parsedData.element_token === 'string') {
      const ref = snapshotTracker.elementReference(sessionId, parsedData.element_token, snapshotId);
      if (ref) {
        snapshotId = ref.snapshotId;
        index = ref.index;
      }
    }
    const windowId = typeof parsedData.window_id === 'number' ? parsedData.window_id : undefined;
    const frame = index === undefined ? undefined : snapshotTracker.elementFrame(sessionId, pid, windowId, index, snapshotId);
    // An element we cannot place is not guessed at; plain typing goes to the focused element.
    if (index !== undefined && !frame) return null;
    const point = frame ? { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 } : undefined;
    const secure = await deps.isSecureTarget({ pid, ...(point ? { point } : {}) }).catch(() => false);
    if (!secure) return null;
    return textResult(
      {
        ok: false,
        errorCode: 'SECURE_FIELD',
        data: {
          tool: name,
          message: 'This element is a password field. Cindy does not let the agent type into password fields.',
          hint: 'Call ask_owner with kind="fill" and this pid and window as target so the owner fills it from their phone or another computer; leave the window as it is until it ends.',
        },
      },
      true,
    );
  }

  /** get_window_state 成功观察后登记新一代快照;其余工具或观察失败时返回 null。 */
  function recordWindowSnapshot(
    name: ComputerMcpToolName,
    parsedData: Record<string, unknown>,
    data: unknown,
    sessionId: string | undefined,
  ): string | null {
    if (name !== 'get_window_state') return null;
    if (typeof parsedData.pid !== 'number' || typeof parsedData.window_id !== 'number') return null;
    // driver 层失败(data.ok === false)不算一次有效观察,不发新代。
    if (!data || typeof data !== 'object' || Array.isArray(data) || !computerResultOutcome(name, data).ok) {
      return null;
    }
    const snapshotId = snapshotTracker.record(sessionId, parsedData.pid, parsedData.window_id, {
      ...(typeof parsedData.query === 'string' ? { query: parsedData.query } : {}),
      ...(typeof parsedData.max_elements === 'number' ? { max_elements: parsedData.max_elements } : {}),
      ...(typeof parsedData.max_depth === 'number' ? { max_depth: parsedData.max_depth } : {}),
    });
    const driverSnapshotId = readDriverSnapshotId(data);
    if (driverSnapshotId) {
      snapshotTracker.registerAlias(snapshotId, driverSnapshotId);
    }
    snapshotTracker.recordElements(snapshotId, (data as { elements?: unknown })?.elements);
    return snapshotId;
  }

  return server;
}


/**
 * Cindy asks drivers for both tree formats to register element tokens and frames.
 * The model reads the compact Markdown rows; the structured copy stays host-side.
 */
function withoutDuplicateElements(name: string, data: unknown): unknown {
  if (name !== 'get_window_state' || !data || typeof data !== 'object' || Array.isArray(data)) return data;
  // A degraded read can carry elements with an empty tree; they are then the only targets.
  const markdown = (data as { tree_markdown?: unknown }).tree_markdown;
  if (typeof markdown !== 'string' || markdown.trim().length === 0) return data;
  if (!('elements' in data)) return data;
  const { elements: _elements, ...rest } = data as Record<string, unknown>;
  return rest;
}

function readDriverSnapshotId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const direct = (data as { snapshot_id?: unknown }).snapshot_id;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct;

  const elements = (data as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) return null;
  for (const element of elements) {
    if (!element || typeof element !== 'object') continue;
    const token = (element as { element_token?: unknown }).element_token;
    if (typeof token !== 'string') continue;
    const colonIndex = token.indexOf(':');
    if (colonIndex > 0) return token.slice(0, colonIndex);
  }
  return null;
}
