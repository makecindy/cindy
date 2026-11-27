import { z } from 'zod';
import type { ComputerMcpCallContext, ComputerMcpDeps, ComputerMcpToolName } from '../types.js';

export interface ComputerToolDef {
  name: ComputerMcpToolName;
  description: string;
  inputShape: z.ZodRawShape;
  readOnly?: boolean;
}

/**
 * element_index 动作共用的快照 id 参数。get_window_state 每次成功观察都会返回
 * 一个新 snapshot_id;动作携带它即可在服务端做代际校验(过期 → STALE_SNAPSHOT,
 * 见 server.ts),避免观察和动作之间 UI 树变化时静默作用到错误元素。
 */
const SNAPSHOT_ID_ARG = z
  .string()
  .optional()
  .describe(
    'snapshot_id returned by the get_window_state call this element_index comes from. Recommended whenever element_index is used: if the window has been observed again since, the action is rejected with STALE_SNAPSHOT so you can re-observe instead of acting on the wrong element.',
  );

const ELEMENT_TOKEN_ARG = z.string().min(1).optional().describe(
  'element_token from the latest get_window_state: `<data.snapshot_id>:<row>` for a tree_markdown row [row], or elements[].element_token when listed. Never invent or reuse it after another observation.',
);

const DESKTOP_TARGET_ARG = z.object({
  kind: z.literal('desktop'),
  display_id: z.literal('primary'),
}).strict().optional().describe('Explicit full-display pointer target for menu-bar/status items. Requires user-authorized foreground control and a fresh get_desktop_state capture_id. Never inferred from a window action failure.');

export function isDesktopComputerTarget(args: Record<string, unknown>): boolean {
  return (args.target as { kind?: unknown } | undefined)?.kind === 'desktop';
}

/** Keep the new global-pointer route distinct from legacy exact-window input. */
export function computerPointerTargetError(name: string, args: Record<string, unknown>): string | undefined {
  if (name !== 'click' && name !== 'drag') return;
  if (!isDesktopComputerTarget(args)) {
    if (typeof args.pid !== 'number') return 'Window input requires pid; use an explicit desktop target for the menu bar.';
    if (args.capture_id !== undefined) return 'capture_id is only accepted with an explicit desktop target.';
    return;
  }
  if ((args.target as { display_id?: unknown }).display_id !== 'primary')
    return 'Desktop input requires display_id:"primary".';
  const windowFields = ['pid', 'window_id', 'element_index', 'element_token', 'snapshot_id', 'from_zoom', 'action', 'debug_image_out', 'observe', 'postcondition'];
  if (windowFields.some((key) => args[key] !== undefined))
    return 'Desktop input cannot mix window/element targets or window observations. Read get_desktop_state afterwards.';
  if (args.delivery_mode !== 'foreground' || typeof args.capture_id !== 'string' || !args.capture_id)
    return 'Desktop input requires explicit delivery_mode:"foreground" and the capture_id from a fresh get_desktop_state.';
  const coordinates = name === 'drag' ? ['from_x', 'from_y', 'to_x', 'to_y'] : ['x', 'y'];
  if (coordinates.some((key) => typeof args[key] !== 'number' || !Number.isFinite(args[key]) || (args[key] as number) < 0))
    return 'Desktop pointer coordinates must be nonnegative pixels from the matching desktop screenshot.';
}

const POSTCONDITION = z
  .array(
    z
      .object({
        element: z
          .object({
            selector: z
              .object({
                role: z.string().min(1).optional(),
                label_contains: z.string().min(1).optional(),
              })
              .strict(),
            exists: z.literal(true).optional(),
            enabled: z.boolean().optional(),
            selected: z.boolean().optional(),
            value_equals: z.string().optional(),
          })
          .strict()
          .optional(),
        window: z
          .object({
            exists: z.boolean().optional(),
            bounds: z
              .object({
                x: z.number(),
                y: z.number(),
                width: z.number(),
                height: z.number(),
                tolerance_px: z.number().min(0).max(100).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine(
        (value) => Boolean(value.element) !== Boolean(value.window),
        "Specify one element or window predicate",
      ),
  )
  .min(1)
  .max(8);

/** These input actions may be followed by one read-only postcondition check. */
export const POSTCHECK_ACTION_TOOLS = new Set<ComputerMcpToolName>([
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "set_value",
  "press_key",
  "hotkey",
  "scroll",
]);

/** Keep an action's follow-up read in the same bounded window scope. */
export const WINDOW_READ_SCOPE = {
  query: z.string().optional(),
  max_elements: z.number().int().positive().max(2000).optional().describe('Maximum AX nodes to walk (host default 200). Keep this and query/max_depth stable across rereads; increase only when truncated.'),
  max_depth: z.number().int().positive().optional().describe('Maximum AX tree depth (host default 15).'),
};

const COMPUTER_TOOL_DEFINITIONS: readonly ComputerToolDef[] = [
  {
    name: 'status',
    description: 'Check whether the local computer-use driver is installed and callable.',
    readOnly: true,
    inputShape: {},
  },
  {
    name: 'check_permissions',
    description:
      'Check OS-level permissions required by cua-driver without opening system permission prompts.',
    readOnly: true,
    inputShape: {
      prompt: z.literal(false).optional(),
    },
  },
  {
    name: 'get_accessibility_tree',
    description:
      'Return a lightweight desktop snapshot of running apps and visible windows. Use this for fast discovery before heavier per-window inspection.',
    readOnly: true,
    inputShape: {},
  },
  {
    name: 'launch_app',
    description:
      'Launch or locate an application without stealing focus. Prefer bundle_id when known. On an explicit name-resolution failure, Cindy tries a unique exact-name bundle from list_apps once; for a plain name it can also locate a unique running process through list_windows (e.g. {"process_name":"Simulator"}). Located is not newly launched; URL, launch-option and new-instance requests are never replaced by locating.',
    inputShape: {
      name: z.string().optional(),
      bundle_id: z.string().optional(),
      urls: z.array(z.string()).optional(),
      electron_debugging_port: z.number().int().optional(),
      webkit_inspector_port: z.number().int().optional(),
      creates_new_application_instance: z.boolean().optional(),
      additional_arguments: z.array(z.string()).optional(),
    },
  },
  {
    name: 'list_apps',
    description: 'List installed and running desktop applications. Takes no filters; do not pass running_only. Reuse a known pid from list_windows rather than guessing an app bundle ID.',
    readOnly: true,
    inputShape: {},
  },
  {
    name: 'list_windows',
    description:
      'List known top-level windows. Use before choosing a target window; for example, {"process_name":"Simulator"}. Hosts may enrich results with process provenance and generic identity hints.',
    readOnly: true,
    inputShape: {
      on_screen_only: z.boolean().optional(),
      pid: z.number().int().positive().optional(),
      query: z.string().optional(),
      workspace_root: z.string().optional(),
      process_name: z.string().optional(),
    },
  },
  {
    name: 'get_window_state',
    description:
      'Inspect one exact window before acting. A tree_markdown row [N] is element_index N: act on it with the top-level snapshot_id plus element_index, or with its element_token. include_screenshot:false returns only the accessibility tree; request an image when visual grounding is needed. query, max_elements and max_depth bound the observation. Omit screenshot_out_file for a host-managed temporary image.',
    readOnly: true,
    inputShape: {
      pid: z.number().int().positive(),
      window_id: z.number().int().nonnegative(),
      capture_mode: z.enum(['som', 'vision', 'ax']).optional(),
      include_screenshot: z.boolean().optional(),
      ...WINDOW_READ_SCOPE,
      screenshot_out_file: z.string().optional(),
      session: z.string().optional(),
    },
  },
  {
    name: 'get_desktop_state',
    description: 'Capture the primary display for explicitly authorized desktop control (menu bar/status items). Use the returned image pixels and capture_id with click/drag target:{kind:"desktop",display_id:"primary"}. Read again after each action; a window screenshot cannot authorize desktop input.',
    readOnly: true,
    inputShape: {
      max_image_dimension: z.number().int().min(0).max(8192).optional(),
      screenshot_out_file: z.string().optional(),
      session: z.string().optional(),
    },
  },
  {
    name: 'verify_state',
    description: 'Verify a bounded postcondition against an exact window after an action. Only status:satisfied proves the condition; unknown is not success. This observation invalidates previous element references: get_window_state again before the next element action.',
    readOnly: true,
    inputShape: {
      pid: z.number().int().positive(),
      window_id: z.number().int().nonnegative(),
      expect: POSTCONDITION,
      stable_samples: z.number().int().min(1).max(5).optional(),
      timeout_ms: z.number().int().min(0).max(10000).optional(),
      include_screenshot: z
        .literal(false)
        .optional()
        .describe("Use get_window_state for a host-managed screenshot."),
    },
  },
  {
    name: 'click',
    description:
      'Click a window by element or window-local coordinates. Always include pid for window input. For menu-bar/status items outside a window, use explicit target:{kind:"desktop",display_id:"primary"}, capture_id and screenshot pixels from get_desktop_state, with delivery_mode:"foreground" after user authorization. Do not reuse window elements for desktop input.',
    inputShape: {
      pid: z.number().int().positive().optional(),
      target: DESKTOP_TARGET_ARG,
      capture_id: z.string().min(1).optional(),
      window_id: z.number().int().nonnegative().optional(),
      element_index: z.number().int().nonnegative().optional(),
      x: z.number().optional(),
      element_token: ELEMENT_TOKEN_ARG,
      delivery_mode: z.enum(['background', 'foreground']).optional(),
      y: z.number().optional(),
      action: z.string().optional(),
      count: z.number().int().positive().optional(),
      modifier: z.array(z.string()).optional(),
      from_zoom: z.boolean().optional(),
      debug_image_out: z.string().optional(),
      snapshot_id: SNAPSHOT_ID_ARG,
      session: z.string().optional(),
    },
  },
  {
    name: 'double_click',
    description:
      'Double-click a target element or window-local coordinate. Always include pid and include window_id for coordinates.',
    inputShape: {
      pid: z.number().int().positive(),
      window_id: z.number().int().nonnegative().optional(),
      element_index: z.number().int().nonnegative().optional(),
      element_token: ELEMENT_TOKEN_ARG,
      delivery_mode: z.enum(['background', 'foreground']).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      snapshot_id: SNAPSHOT_ID_ARG,
      session: z.string().optional(),
    },
  },
  {
    name: 'right_click',
    description:
      'Right-click a target element or window-local coordinate. Always include pid and include window_id for coordinates.',
    inputShape: {
      pid: z.number().int().positive(),
      window_id: z.number().int().nonnegative().optional(),
      element_index: z.number().int().nonnegative().optional(),
      element_token: ELEMENT_TOKEN_ARG,
      delivery_mode: z.enum(['background', 'foreground']).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      modifier: z.array(z.string()).optional(),
      snapshot_id: SNAPSHOT_ID_ARG,
      session: z.string().optional(),
    },
  },
  {
    name: "drag",
    description:
      'Drag within a window after get_window_state/zoom (pid required). For menu-bar rearrangement, explicitly use target:{kind:"desktop",display_id:"primary"}, a fresh get_desktop_state capture_id, its screenshot pixels and delivery_mode:"foreground" after user authorization. Window failures never automatically escalate to desktop input.',
    inputShape: {
      pid: z.number().int().positive().optional(),
      target: DESKTOP_TARGET_ARG,
      capture_id: z.string().min(1).optional(),
      window_id: z.number().int().nonnegative().optional(),
      delivery_mode: z.enum(['background', 'foreground']).optional(),
      from_x: z.number(),
      from_y: z.number(),
      to_x: z.number(),
      to_y: z.number(),
      duration_ms: z.number().int().min(0).max(10000).optional(),
      steps: z.number().int().min(1).max(200).optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      modifier: z.array(z.string()).optional(),
      from_zoom: z.boolean().optional(),
      session: z.string().optional(),
    },
  },
  {
    name: 'type_text',
    description:
      'Type text into the focused element of the target app by keystrokes. Always include pid and include window_id when targeting a specific window. Not for Electron/browser/web-content fields: background delivery is refused there and foreground keystrokes are unreliable; use set_value with the field\'s element_token instead. A refusal (background_unavailable, type_text_incomplete, USER_INPUT_ACTIVE) is a result to report, never to replace with shell-simulated keys.',
    inputShape: {
      pid: z.number().int().positive(),
      text: z.string(),
      delivery_mode: z.enum(['background', 'foreground']).optional(),
      element_index: z.number().int().nonnegative().optional(),
      element_token: ELEMENT_TOKEN_ARG,
      window_id: z.number().int().nonnegative().optional(),
      delay_ms: z.number().int().min(0).max(200).optional(),
      snapshot_id: SNAPSHOT_ID_ARG,
      session: z.string().optional(),
    },
  },
  {
    name: 'set_value',
    description:
      'Set a text field value through accessibility, without focus or keystrokes. Preferred for Electron/browser/web-content text fields (verified on Cindy\'s own composer: the field updates and its send button enables) and for minimized/background fields. Requires element_token from the latest get_window_state (query:"AXTextArea" or "AXTextField" finds it). Replaces the whole value; confirm with observe:{}.',
    inputShape: {
      pid: z.number().int().positive(),
      window_id: z.number().int().nonnegative(),
      element_index: z.number().int().nonnegative().optional(),
      element_token: ELEMENT_TOKEN_ARG,
      value: z.string(),
      snapshot_id: SNAPSHOT_ID_ARG,
      session: z.string().optional(),
    },
  },
  {
    name: 'press_key',
    description: 'Press a single key in the target app.',
    inputShape: {
      pid: z.number().int().positive(),
      key: z.string(),
      modifiers: z.array(z.string()).optional(),
      element_index: z.number().int().nonnegative().optional(),
      element_token: ELEMENT_TOKEN_ARG,
      delivery_mode: z.enum(['background', 'foreground']).optional(),
      window_id: z.number().int().nonnegative().optional(),
      snapshot_id: SNAPSHOT_ID_ARG,
      session: z.string().optional(),
    },
  },
  {
    name: 'hotkey',
    description: 'Press a keyboard shortcut in the target app, e.g. ["cmd","c"]. Session-level chords (lock screen, log out, sleep) are refused with HOTKEY_BLOCKED.',
    inputShape: {
      pid: z.number().int().positive(),
      keys: z.array(z.string()).min(2),
      delivery_mode: z.enum(['background', 'foreground']).optional(),
      window_id: z.number().int().nonnegative().optional(),
      session: z.string().optional(),
    },
  },
  {
    name: 'scroll',
    description:
      'Scroll a target element or a point from the latest window screenshot. For nested Windows web scrollers, use x/y: an element without a UIA scroll action can fall back to the window center. Supply both x and y with an exact window_id, without element_index/element_token. Coordinates use the returned screenshot pixels, not screen coordinates. Inspect the result with observe:{}; delivery alone does not confirm scrolling.',
    inputShape: {
      pid: z.number().int().positive(),
      window_id: z.number().int().nonnegative().optional(),
      element_index: z.number().int().nonnegative().optional(),
      element_token: ELEMENT_TOKEN_ARG,
      x: z.number().optional(),
      y: z.number().optional(),
      delivery_mode: z.enum(['background', 'foreground']).optional(),
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().min(1).max(50).optional(),
      by: z.enum(['line', 'page']).optional(),
      snapshot_id: SNAPSHOT_ID_ARG,
      session: z.string().optional(),
    },
  },
  {
    name: 'zoom',
    description:
      'Capture a zoomed region from a window screenshot for pixel-level targeting. Use screenshot pixel bounds x1,y1,x2,y2.',
    readOnly: true,
    inputShape: {
      pid: z.number().int().positive().optional(),
      window_id: z.number().int().nonnegative(),
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
    },
  },
  {
    name: 'get_screen_size',
    description: 'Return screen dimensions for the current desktop.',
    readOnly: true,
    inputShape: {},
  },
  {
    name: 'get_cursor_position',
    description: 'Return the current pointer position. Read-only; does not move the cursor.',
    readOnly: true,
    inputShape: {},
  },
  {
    name: 'move_cursor',
    description:
      'Move the visible agent cursor overlay to screen coordinates without moving the real mouse pointer.',
    inputShape: {
      x: z.number(),
      y: z.number(),
      cursor_id: z.string().optional(),
      session: z.string().optional(),
    },
  },
  {
    name: 'get_agent_cursor_state',
    description: 'Return the current agent cursor overlay state for this session or cursor id.',
    readOnly: true,
    inputShape: {
      cursor_id: z.string().optional(),
    },
  },
  {
    name: 'start_recording',
    description:
      'Start trajectory recording to an explicit output directory. Records subsequent computer-use action turns for debugging or replay.',
    inputShape: {
      output_dir: z.string(),
      record_video: z.boolean().optional(),
      session: z.string().optional(),
    },
  },
  {
    name: 'stop_recording',
    description:
      'Stop trajectory recording and finalize video output when video recording was enabled.',
    inputShape: {},
  },
  {
    name: 'replay_trajectory',
    description:
      'Replay a previously recorded trajectory directory. Use only when the user explicitly asks to replay/debug a recording.',
    inputShape: {
      dir: z.string(),
      delay_ms: z.number().int().min(0).max(10000).optional(),
      stop_on_error: z.boolean().optional(),
    },
  },
];

/** Name the whole computer-use objective once; the host owns stable routing. */
export const COMPUTER_TOOLS: readonly ComputerToolDef[] =
  COMPUTER_TOOL_DEFINITIONS.map((tool) => ({
    ...tool,
    inputShape: !["status", "check_permissions", "replay_trajectory"].includes(
      tool.name,
    )
      ? {
          ...tool.inputShape,
          ...(POSTCHECK_ACTION_TOOLS.has(tool.name)
            ? {
                postcondition: POSTCONDITION.optional().describe(
                  "Optional expected final state, using verify_state predicates. Cindy checks it once after delivery (requires an exact window). Without it, unknown delivery gets one fresh observation but is never declared successful. Actions are never replayed automatically.",
                ),
                observe: z.object({
                  ...WINDOW_READ_SCOPE,
                  include_screenshot: z.boolean().optional(),
                }).strict().optional().describe(
                  'Read the same window once after delivery, returning observation with a fresh usable snapshot. Use {} for text; include_screenshot:true for visual evidence. Omitted query/max_elements/max_depth inherit the last explicit read. Mutually exclusive with postcondition. Does not replay actions or prove the goal succeeded.',
                ),
              }
            : {}),
          session_goal: z
            .string()
            .trim()
            .min(1)
            .max(80)
            .optional()
            .describe(
              'On your FIRST computer-use call, provide a short English name for the overall goal of this run (e.g. "Submit expense report" or "Configure notifications"), not the current click or typing step. Use English because the native cursor font does not support CJK text. The host sets the driver session name once and keeps it for the run; omit this field on later calls. Never include credentials or internal IDs.',
            ),
        }
      : tool.inputShape,
  }));

export const COMPUTER_TOOL_NAMES = COMPUTER_TOOLS.map((tool) => tool.name) as [
  ComputerMcpToolName,
  ...ComputerMcpToolName[],
];

export function getComputerTool(name: string): ComputerToolDef | undefined {
  return COMPUTER_TOOLS.find((tool) => tool.name === name);
}

export async function callComputerTool(
  deps: ComputerMcpDeps,
  name: ComputerMcpToolName,
  args: Record<string, unknown>,
  context?: ComputerMcpCallContext,
): Promise<unknown> {
  if (name === 'status') {
    return deps.getStatus();
  }
  if (name === 'check_permissions') {
    const status = await deps.getStatus();
    return {
      ok: true,
      permissionState: status.permissionState,
      permissions: status.permissions,
      daemonRunning: status.daemonRunning,
    };
  }
  return context ? deps.callTool(name, args, context) : deps.callTool(name, args);
}
