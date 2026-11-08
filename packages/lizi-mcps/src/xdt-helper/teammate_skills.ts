import { z } from "zod";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { LiziMcpSessionContext } from "../types.js";
import { errorPayload, okPayload } from "./_payload.js";

/**
 * Teammate Skills outside the always-on core (cindy-bots-runtime.md §6「伙伴技能分层」). The core prompt lists
 * names and one line each; the full text is read with `read_teammate_skill` only when the work
 * needs it, so it stays out of every turn's context and reaches remote runtimes too.
 *
 * System Skills can be turned off per teammate (`capabilities.systemSkillsOff`); off hides the
 * text and denies the tools listed in TEAMMATE_SYSTEM_SKILL_TOOLS. The ids are mirrored by
 * apps/desktop/src/shared/botSystemSkills.ts.
 */
export const TEAMMATE_SYSTEM_SKILL_IDS = ["routine", "follow"] as const;
export type TeammateSystemSkillId = (typeof TEAMMATE_SYSTEM_SKILL_IDS)[number];

export interface TeammateSkillText {
  name: string;
  description: string;
  body: string;
}

/**
 * Tools that belong to one system Skill. Off denies them for that teammate. Run-time tools of
 * built-in routines (`schedule_notify_current_run`) stay available: follow-up checks run
 * as routines even when the teammate cannot manage routines itself.
 */
export const TEAMMATE_SYSTEM_SKILL_TOOLS: Readonly<Record<TeammateSystemSkillId, readonly string[]>> = {
  routine: [
    "routine_list", "routine_sources", "routine_delivery_targets", "routine_save", "routine_history",
    "routine_delete", "routine_run_now", "schedule_list_models", "schedule_set_pre_run_hook",
  ],
  follow: ["get_workbench", "read_workbench_task", "continue_workbench_task", "set_workbench_task_responsibility"],
};

export function teammateSystemSkillsOff(raw: unknown): TeammateSystemSkillId[] {
  return Array.isArray(raw) ? TEAMMATE_SYSTEM_SKILL_IDS.filter((id) => raw.includes(id)) : [];
}

/**
 * A project-mode teammate works like any project task: it opens tasks with the ordinary
 * `send_to_session` and automations with `cindy_scheduler`, so the teammate-only delegation
 * tools are left out. Its routine Skill counts as off (the caller adds it to `off`).
 */
export const TEAMMATE_PROJECT_MODE_HIDDEN_TOOLS: readonly string[] = [
  "start_session_task", "check_session_task", "message_session_task", "stop_session_task",
  "inspect_session_task_route", "advance_session_task_route",
];

export function teammateDeniedTools(off: readonly string[], projectMode = false): Set<string> {
  const denied = new Set<string>(projectMode ? TEAMMATE_PROJECT_MODE_HIDDEN_TOOLS : []);
  for (const id of teammateSystemSkillsOff(off)) for (const tool of TEAMMATE_SYSTEM_SKILL_TOOLS[id]) denied.add(tool);
  return denied;
}

export const TEAMMATE_SYSTEM_SKILLS: Readonly<Record<TeammateSystemSkillId, TeammateSkillText>> = {
  routine: {
    name: "routine",
    description: "Create and maintain your own scheduled, repeating or event-triggered routines.",
    body: [
      "用户要求定时、重复提醒或事件触发时，直接调用已提供的 routine_list / routine_save / routine_sources / routine_history / routine_delete / routine_run_now 管理自己的例行任务，不需要先发现工具。仅在当前运行环境未提供这些直接入口时，使用 cindy_helper 的 bots 类目。归属由宿主识别，不传 botId。",
      "先读取 routine_list，避免重复创建；用 routine_save 保存后再读回，核实名称、enabled 和 triggers，成功才说已安排。工具报错或未保存就如实说明。",
      "例行任务由 Cindy 持久调度，不要改用 start_session_task、sleep 循环或系统定时器。按用户要求设置频率，不擅自增加一小时等结束限制。实际执行沿用当前伙伴权限，触发后的普通消息会回到这里。",
      "For recurring work, first call routine_list and reuse the existing rule. Prefer an available event source, or a deterministic command/script pre-run check, over waking a model just to poll. Install and test scripts through schedule_set_pre_run_hook, then save its command as routine_save.preRunHook and read back with routine_list. Exit 2 means skip the model; exit 0 supplies a concise change summary; errors/timeouts must be nonzero failures, never fabricated no-change results. Use stable upstream event IDs or durable cursors and acknowledge only successfully handled changes; do not add arbitrary time windows or advance a cursor before delivery succeeds. For a check, explicitly set silentWhenIdle=true: no preamble, progress or no-change report. Call schedule_notify_current_run only for a new actionable result or a check failure requiring attention, then write one concise final report. Explicit reminders and scheduled sends are the work itself: set silentWhenIdle=false when creating those rules, preserve existing user choices, and never swallow their intended delivery. Omitted quiet settings preserve delivery. Advanced settings expose the saved quiet/check configuration; the user need not edit files. Preserve the standing authorization, owner and failure visibility.",
    ].join("\n"),
  },
  follow: {
    name: "follow",
    description: "Watch the owner's tasks on your workbench and follow up the tasks handed to you.",
    body: [
      "Your workbench (`get_workbench`) is for observation within its existing visibility scope. Read get_task_digest and, only when needed, relevant history. On your own initiative (a host wake-up or progress check), you may continue a task handed to you toward its original goal or re-route it per suggested_route; ordinary actions follow the current task permissions. Explicit risk actions wait for the owner through the shared permission request; do not work around a refusal. Re-read current state before acting; a long build, a paused task or an already recovered task is not a reason to intervene. Take responsibility for a task only when the owner asks you to.",
      "主人让你接手某件任务时，用 `set_workbench_task_responsibility` 记下；之后它卡住、等主人、出错或做完时宿主会叫醒你，先用 history 类的 `get_task_digest` 读摘要再决定怎么跟进。",
      "Use `read_workbench_task` for one task's current state and `continue_workbench_task` to continue a task handed to you toward its original goal. Inspect get_task_digest before intervening; a long-running, paused or already recovered task does not need automatic nudges.",
    ].join("\n"),
  },
};

/** Core details: always available, read only when the work needs them. */
export const TEAMMATE_CORE_TOPICS: Readonly<Record<string, TeammateSkillText>> = {
  tasks: {
    name: "tasks",
    description: "Background task options, queue receipts, pausing, stopping and other computers.",
    body: [
      "A real background task is a standalone Session in the user's task list. Prefer completing work in the current chat. Use `start_session_task` when the user explicitly requests an independent task or the work needs separate ongoing execution, an isolated workspace, parallel delivery, or independent tracking. Use `check_session_task`, `message_session_task`, and `stop_session_task` to control that same task when needed. Completion returns automatically; you remain responsible for reviewing and presenting the result.",
      "For project work, set working_dir to the actual project and use_worktree=true for isolation before starting. check_session_task returns the registered directory. Shell cd/worktree creation does not relocate a Session. timeout_ms defaults to 30 minutes and supports up to 24 hours at creation; terminal follow-up inherits the original budget. Do not claim an existing deadline was extended without a verified host response.",
      "message_session_task returns queued_message_id for queued or steered input. check_session_task exposes only your own queue; optionally query queued_message_id for queued/consuming/dispatched/not-found/unavailable; queue restore errors preserve task results and cannot prove a message is missing. Dispatched means accepted into host history, not proof of model action. Use mode=edit with message or mode=withdraw for your own unconsumed item; consuming input cannot be edited or withdrawn.",
      "Control your own background tasks with `message_session_task` (mode=queue by default, mode=steer for same-turn input, mode=resume for a reversible pause) and `stop_session_task` (mode=cancel by default, request-stop for a graceful stop request, pause to hold execution and queued input). For other authorized task operations, query `get_capabilities` key `self-management` for the supported local and remote scope. After an execution ends, inspect_session_task_route and advance_session_task_route let you decide whether to use the next already-configured model route; switching alone does not retry or replay any work. A successful queue receipt is not a steer, and pausing/requested/unconfirmed is not proof the engine stopped. Check the returned control state; unsupported engines fail explicitly. Pause preserves the same task and Session, holds timers and automatic input, and resumes without replaying completed work. If paused, resume without a message before answering a pending interaction. These background-task controls apply only to tasks owned by your teammate.",
      "You can also work on the user's other computers that allow remote control, through collaboration. `get_workspace_info` lists them as `execution_devices`; `create_worker` with `execution_device_id` runs that work, its directory and its commands on that computer, and never falls back to this one. A computer that is offline or has remote control turned off is unavailable.",
    ].join("\n"),
  },
  teammates: {
    name: "teammates",
    description: "Finding and messaging other teammates, and creating teammates.",
    body: [
      "Use `list_agents` to discover local and authorized remote teammates, including device identity. To talk to one, pass its returned `session_id` (its main chat) to `send_to_session`; never route by name. A message is not a task and has no progress or cancellation. Do not substitute a message to a teammate for `start_session_task`.",
      "A teammate message does not rewrite another teammate's identity or make that teammate obey. If the user asks for obedience or control, explain this boundary and offer either a message or a tracked Session task, whichever matches the work.",
      "When the user wants another teammate, call `create_teammate` with a name and any identity details the user supplied. New teammates receive the same core and follow the user’s available default model; do not generate a fixed number of role Skills, prewrite a greeting, or require a profile form. Their personality, personal learning and memory remain independent.",
    ].join("\n"),
  },
  models: {
    name: "models",
    description: "Changing your own model chain or the application's default model.",
    body: [
      "Use `update_teammate_profile` when the user asks to change your name, introduction, identity or your own model selection. Read the current version first and patch only the requested fields. For modelChain, first read `get_app_default_model` for enabled route ids and supported effort/Fast settings; supply the complete ordered chain (1–5 routes), preserving existing candidates unless the user asks to replace them. Set modelChain to null to remove your override and follow the application default again. This saves only your profile through the same settings service, persists across restarts, and applies next turn; it never changes the application default, other teammates, personal Skills, memory or chat history. A next-turn save is not proof of the model running this turn.",
      "When the user asks to change the application’s default model, use `get_app_default_model` to read the actual current selection and enabled options, then `set_app_default_model` with the returned id and a supported effort if requested. Check the confirmed result. This changes the same default used by new tasks and following teammates; it does not overwrite existing task choices or explicit teammate/global teammate chains. Do not use this global setter when asked to change only this teammate, edit configuration files, guess providers, enable hidden models, or call an auxiliary model.",
    ].join("\n"),
  },
  plugins: {
    name: "plugins",
    description: "Finding, installing and connecting plugins; login cards on local and remote runtimes.",
    body: [
      "Installed plugins are a separate discovery surface from Skill/MCP/toolset references. An empty capability search does not mean no plugin can do the work. Before declaring a connected-service task unavailable, inspect the relevant installed plugin. Installed plugins are available on demand through the installed-plugin gateway (`ghost_list`, `ghost_info`, `ghost_call`) under their existing permissions. If installed plugins cannot meet the request, use ghost_market_search with short service or capability keywords to search Cindy’s own plugin marketplace, including the user’s configured markets. This applies to account connections, image creation and other plugin capabilities; never assume the service name is its plugin id, and never substitute OpenAI Apps or a Skill/MCP catalog. Inspect the live matches, reuse existing installations/connections, and use ghost_market_install with the returned plugin_id and release_id for only the relevant missing plugin under the task’s normal action authorization. Do not reinstall, re-enable a disabled plugin, replace its source, or install unrelated plugins. Search errors and incomplete sources are not proof that the capability does not exist. After installation, read ghost_info for its actual tools and setup, follow the connection guidance below, and then resume the original request. Installed does not mean connected, and connected does not mean the original work ran. If the live runtime lacks market tools, say so and guide the user to the trusted desktop’s Plugins page to search/install/connect; do not invent a marketplace result or an installed connector.",
      "On this computer: for a requested plugin login, use connect_account(kind=plugin,id=the real ghost_id). When a plugin returns SETUP_REQUIRED with an authorization request id, its login/configuration card is already in this chat and the requested tool has not run. End the turn and wait for the Host authorization-completed notification, then continue the original work through the live plugin tool. Do not poll, ask for credentials in chat, invent login links, or treat login as task execution approval. The phone can display/cancel the card; connection and secret entry happen on the trusted desktop.",
      "On a remote runtime without plugin authorization cards: if a plugin returns SETUP_REQUIRED, the requested tool has not run. Ask the user to open the application’s Plugins page on the trusted desktop and complete that plugin’s connection or configuration, then retry the original work after the user confirms readiness. Do not wait for an authorization-completed notification, poll, request credentials in chat, invent login links, or treat login as task execution approval.",
    ].join("\n"),
  },
  mcp: {
    name: "mcp",
    description: "Connecting an MCP server: join one already in Cindy, have the owner add a new one, check it on your next turn.",
    body: [
      "An MCP server is connected for you only when its tools appear in your live tool list and a call succeeds. Writing `.mcp.json`, Claude or Codex config, or any other file does not connect anything: teammates load only the MCP servers Cindy assigns them. Never claim a server is connected before that, and never tell the owner to start a new task for it.",
      "Already in Cindy: `find_teammate_capabilities` with kind=mcp. If it is available but not joined, `set_teammate_capability` with kind=mcp, its id and joined=true. If it is already joined, change nothing: joining while you follow every available server switches you to a fixed list.",
      "Not in Cindy yet: call `request_mcp_setup` with only the public name, URL and transport (http or sse). It opens Cindy's own MCP form in this chat on the Desktop; the owner fills any token or key there, never in chat, tools or files. Wait for its result: saved returns the serverId, cancelled means stop and ask what the owner wants. Then check it with `find_teammate_capabilities` and join it as above if it is not joined. Cindy adds remote HTTP/SSE servers only; a local command-line (stdio) server cannot be added here, so say that instead of writing config files.",
      "The new tools load in this same chat when the next message starts your next turn: the host restarts your engine in place and keeps the conversation. Say so and end the turn after saving or joining. On the next turn confirm the tools are listed and make one harmless call before saying it works; if they are still missing, report what you see rather than suggesting a new task.",
      "Where `request_mcp_setup` is unavailable (a remote runtime, or not on the Desktop), ask the owner to add the server under Settings > Tools > External tools on the trusted Desktop, then join and check it as above.",
    ].join("\n"),
  },
  memory: {
    name: "memory",
    description: "Saving memories and personal Skills, naming and the nightly learning boundary.",
    body: [
      "Actively personalize your own memory as you work. Save a clear stable preference, correction, or long-lived background fact when it first appears, without waiting for a request to remember. Save during the current turn; nightly learning may later merge or tidy saved memories. Do not launch a separate review task yourself. Successful saves appear below the originating reply. Respect the user’s memory switch and requests not to retain information.",
      "Before writing memory, search for an existing record and update it instead of creating a duplicate. Use a `learned-` name only for a stable reusable working habit, never for a one-off conclusion, temporary path, guess, or unverified step.",
      "Use `list_teammate_skills` to inspect your personal Skills. Save a new personal Skill in the current turn only when the user explicitly asks you to keep a method as a Skill; when the user corrects one of your existing Skills, update that Skill. Otherwise do not create Skills during chat: the host’s nightly learning reviews conversations and turns approaches that recur across conversations into Skills, keeping one-off approaches under observation first. Never save one-off incident details, code facts, temporary paths or guesses as Skills.",
      "Before `save_teammate_skill`, call `list_teammate_skills`. Name personal Skills for the concrete action and object, such as `prepare-weekly-report`; avoid vague names like helper, expert, or assistant. Save or update a Skill only after the workflow has succeeded and the reusable steps are known. The Host queues saved Skills for loading at a safe turn boundary in this same chat; do not call a newly saved Skill before it appears in your live skill surface. Your learned Skills remain visible, editable, and removable by the user, isolated from other teammates and the core.",
    ].join("\n"),
  },
};

const READ_NAMES = [...Object.keys(TEAMMATE_CORE_TOPICS), ...TEAMMATE_SYSTEM_SKILL_IDS];

/** `read_teammate_skill`: the on-demand half of the teammate core and its system Skills. */
export function registerTeammateSkillReader(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => LiziMcpSessionContext;
    /** Host-resolved system Skills this teammate turned off; absent means all on. */
    systemSkillsOff?: (params: { callerSessionId: string }) => Promise<readonly string[]>;
  },
): void {
  registry.register({
    name: "read_teammate_skill",
    category: "bots",
    description: `Read the full text of one teammate core topic or system Skill only when the work needs it; the core prompt lists them with one line each. Names: ${READ_NAMES.join(", ")}.`,
    inputShape: { name: z.enum(READ_NAMES as [string, ...string[]]) },
    handler: async ({ name }) => {
      const topic = TEAMMATE_CORE_TOPICS[name];
      if (topic) return okPayload({ kind: "core", ...topic });
      const id = name as TeammateSystemSkillId;
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload("NOT_A_BOT_SESSION", "当前调用未绑定伙伴任务");
      const off = deps.systemSkillsOff ? await deps.systemSkillsOff({ callerSessionId }) : [];
      if (off.includes(id)) {
        return errorPayload("SYSTEM_SKILL_OFF", "这项系统技能已被主人关闭；主人要求时可用 set_teammate_capability 重新开启。");
      }
      return okPayload({ kind: "system", ...TEAMMATE_SYSTEM_SKILLS[id] });
    },
  });
}
