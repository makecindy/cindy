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

export const COMPUTER_TOOLS: readonly ComputerToolDef[] = [
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
      'Launch or locate a desktop application without stealing focus. Prefer this over shell open/Start-Process for GUI apps. For iOS work, use cindy_ios_simulator for Cindy\'s embedded viewer; launching Xcode or macOS Simulator.app is unavailable until Cindy can issue an explicit host authorization. Use list_windows with {"process_name":"Simulator"} for read-only external Simulator window discovery.',
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
    description: 'List installed and running desktop applications.',
    readOnly: true,
    inputShape: {},
  },
  {
    name: 'list_windows',
    description:
      'List known top-level desktop windows. Use only for external desktop UI work; Cindy iOS app work should use cindy_ios_simulator and its embedded viewer. For an explicitly requested external Simulator.app window, filter with {"process_name":"Simulator"}. Hosts may enrich results with process provenance and generic identity hints.',
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
      'Inspect one window and return its accessibility tree/screenshot state. Use {"capture_mode":"vision"} for a screenshot and normally omit screenshot_out_file so the driver uses its default path. Call before element-indexed actions. The result carries a snapshot_id; pass it to element-indexed actions so actions taken on an outdated view of the window are rejected as STALE_SNAPSHOT instead of hitting the wrong element.',
    readOnly: true,
    inputShape: {
      pid: z.number().int().positive(),
      window_id: z.number().int().nonnegative(),
      capture_mode: z.enum(['som', 'vision', 'ax']).optional(),
      query: z.string().optional(),
      screenshot_out_file: z.string().optional(),
      session: z.string().optional(),
    },
  },
  {
    name: 'click',
    description:
      'Click a target app by element_index+window_id or by window-local coordinates. Always include pid and include window_id for coordinates. Requires a prior get_window_state for element indices.',
    inputShape: {
      pid: z.number().int().positive(),
      window_id: z.number().int().nonnegative().optional(),
      element_index: z.number().int().nonnegative().optional(),
      x: z.number().optional(),
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
      x: z.number().optional(),
      y: z.number().optional(),
      modifier: z.array(z.string()).optional(),
      snapshot_id: SNAPSHOT_ID_ARG,
      session: z.string().optional(),
    },
  },
  {
    name: 'drag',
    description: 'Drag from one window-local coordinate to another. Use after get_window_state or zoom.',
    inputShape: {
      pid: z.number().int().positive(),
      window_id: z.number().int().nonnegative().optional(),
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
      'Type or set text in the target app. Always include pid and include window_id when targeting a specific window.',
    inputShape: {
      pid: z.number().int().positive(),
      text: z.string(),
      element_index: z.number().int().nonnegative().optional(),
      window_id: z.number().int().nonnegative().optional(),
      delay_ms: z.number().int().min(0).max(200).optional(),
      snapshot_id: SNAPSHOT_ID_ARG,
      session: z.string().optional(),
    },
  },
  {
    name: 'set_value',
    description:
      'Set a text field value through accessibility. Prefer this for minimized/background text fields when typing cannot commit.',
    inputShape: {
      pid: z.number().int().positive(),
      window_id: z.number().int().nonnegative(),
      element_index: z.number().int().nonnegative(),
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
      window_id: z.number().int().nonnegative().optional(),
      snapshot_id: SNAPSHOT_ID_ARG,
      session: z.string().optional(),
    },
  },
  {
    name: 'hotkey',
    description: 'Press a keyboard shortcut in the target app, e.g. ["cmd","c"].',
    inputShape: {
      pid: z.number().int().positive(),
      keys: z.array(z.string()).min(2),
      window_id: z.number().int().nonnegative().optional(),
      session: z.string().optional(),
    },
  },
  {
    name: 'scroll',
    description: 'Scroll a target element or window-local coordinate.',
    inputShape: {
      pid: z.number().int().positive(),
      window_id: z.number().int().nonnegative().optional(),
      element_index: z.number().int().nonnegative().optional(),
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
