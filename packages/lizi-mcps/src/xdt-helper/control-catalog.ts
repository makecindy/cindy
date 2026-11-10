import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { RuntimeCapabilityReader } from './get_capabilities.js';

/** Metadata only. Execution stays with each registered domain handler. */
interface Control {
  key: string; domain: string; title: string; summary: string; aliases: string[];
  server?: string; tools?: string[]; section?: string; notes?: string;
  delegate?: { server: string; tool: string; args: Record<string, unknown> };
}
const domains = [
  ['application', '应用设置', '语言、通知、窗口、快捷键、日志和更新偏好'],
  ['appearance', '外观', '主题、字体、布局、壁纸和导入资源'],
  ['models', '模型', '供应商、默认模型、型号参数、辅助与视觉模型'],
  ['teammates', '伙伴', '资料、人设、模型、能力、记忆、渠道和生命周期'],
  ['automations', '自动化', '时间、时区、模型、脚本、投递与暂停恢复'],
  ['projects', '项目', '项目归属、工作目录、环境和默认配置'],
  ['tasks', '任务', '单任务运行设置、权限、模型和上下文窗口'],
  ['groups-and-sharing', '群与共享', '群设置、成员、通知、分工与共享权限'],
  ['devices', '设备', '电脑、远控、中转与 SSH 连接'],
  ['tools-and-extensions', '工具与扩展', '内建工具、MCP、Skill、插件与 Pi 扩展'],
  ['media-and-input', '语音与输入', '麦克风、语音词典、音效和输入行为'],
  ['runtimes-and-storage', '运行环境与存储', 'Pi 更新、运行资源、清理与回收'],
  ['accounts-and-mobile', '账号与手机', '账号连接和手机自身的本地设置'],
] as const;
const setting = (key: string, domain: string, title: string, summary: string, section: string, aliases: string[], reset = true): Control =>
  ({ key, domain, title, summary, section, aliases, server: 'cindy_helper', tools: ['get_app_settings', 'update_app_settings', ...(reset ? ['reset_app_settings'] : [])] });
const helper = (key: string, domain: string, title: string, summary: string, tools: string[], aliases: string[], notes?: string): Control =>
  ({ key, domain, title, summary, tools, aliases, notes, server: 'cindy_helper' });
export const CONTROL_CATALOG: readonly Control[] = [
  helper('devices.remote-consent', 'devices', '远程控制授权请求', '请求同账号在线电脑弹出本机确认窗口，由用户开启持续有效的远程控制设置。', ['request_remote_control'], ['远程控制', '授权', '弹窗', 'remote control', 'consent'], '使用 list_machines 的精确设备 ID；只有目标电脑返回 enabled 才能继续原操作。拒绝、超时或旧版无响应不代表同意。'),
  setting('application.preferences', 'application', '语言、主题与通知', '发送快捷键、链接打开方式、动效、消息导航和首页偏好。', 'preferences', ['language', 'theme', 'notification', '语言', '主题', '通知', '快捷键', '动效', '链接'], false),
  setting('appearance.wallpaper', 'appearance', '字体与内置壁纸', '字体、字号、窗口缩放、内置壁纸及效果；自定义图片导入另查 appearance.assets。', 'appearance', ['wallpaper', 'font', '壁纸', '背景', '字体', '字号', '缩放']),
  setting('projects.git-safety', 'projects', 'Git 安全快照', 'Git 自动快照开关。', 'git-safety', ['git', '快照']),
  setting('tasks.goal-defaults', 'tasks', '目标模式默认限制', '以后启动目标模式的轮数、token 预算与无进展限制。', 'goal-defaults', ['goal', '目标模式', '预算']),
  setting('runtimes.resources', 'runtimes-and-storage', '运行资源', '命令并发、进程优先级、工具链线程。', 'agent-resources', ['resource', '并发', '资源', '线程']),
  setting('application.memory', 'application', '全局记忆开关', 'Cindy 与各 Harness 的记忆开关，不是单个伙伴的记忆。', 'memory', ['memory', '全局记忆']),
  setting('models.subagents', 'models', '子代理模型', '子代理模型与 Codex 智能调配。', 'subagent-models', ['subagent', '子代理', '智能调配']),
  setting('models.auxiliary', 'models', '辅助模型', '辅助模型优先与备用。', 'auxiliary-models', ['auxiliary', '辅助模型']),
  setting('models.vision', 'models', '视觉桥', '视觉桥开关、目标模型与主备用视觉模型。', 'vision-bridge', ['vision', '视觉桥']),
  helper('models.configuration', 'models', '模型与供应商配置', '本机 API 连接添加、安全密钥输入、型号发现与连接验证；型号参数、供应商启停及 Claude/Codex 多订阅账号。', ['list_model_providers', 'get_model_configuration', 'set_model_configuration', 'configure_model_provider', 'configure_model_connection'], ['model', 'provider', '模型', '供应商', '上下文', '压缩', '价格', '订阅', '账号', 'Claude', 'Codex', '负载均衡']),
  helper('models.default', 'models', '默认模型', '普通任务的新任务默认选择；伙伴调用时依其原默认模型语义。', ['get_app_default_model', 'set_app_default_model'], ['default model', '默认模型'], '单个伙伴覆盖请查 teammates.profile；不要把新任务默认和伙伴默认混为同一设置。'),
  helper('teammates.profile', 'teammates', '当前伙伴资料与模型', '修改当前调用任务绑定的伙伴资料和模型链。', ['get_teammate_state', 'update_teammate_profile'], ['teammate', 'companion', 'bot', '伙伴', '人设', '伙伴模型', '伙伴默认模型'], '仅绑定该伙伴的任务可用；不是任意 botId 管理接口。使用 expectedVersion；运行中切模遵循原安全边界。'),
  helper('teammates.capabilities', 'teammates', '伙伴能力与技能', '查询并选择当前伙伴的 Skill、MCP、工具和特性。', ['find_teammate_capabilities', 'set_teammate_capability', 'list_teammate_skills', 'read_teammate_skill', 'save_teammate_skill'], ['伙伴能力', '伙伴技能', 'capability']),
  helper('teammates.management', 'teammates', '伙伴创建与管理入口', '发现伙伴与主力电脑；创建及管理能力依当前身份。', ['create_teammate', 'list_agents', 'get_teammate_home', 'move_teammate_home'], ['创建伙伴', '主力电脑', '伙伴设置']),
  { key: 'automations.schedule', domain: 'automations', title: '自动化设置与运行', summary: '时间、时区、模型、脚本、位置、暂停与恢复。', aliases: ['automation', 'schedule', 'cron', '自动化', '定时', '时间'], server: 'cindy_scheduler', tools: ['schedule_list', 'schedule_get', 'schedule_update', 'schedule_create', 'schedule_pause', 'schedule_resume', 'schedule_run_now', 'schedule_list_models'], notes: 'intervalMs 非空时优先于 cronExpr；改时间需同时核对时区和 nextFireAt。保存不会立即运行；run_now 是独立动作。' },
  helper('projects.management', 'projects', '项目管理', '查询、创建、修改和删除已登记项目。', ['list_projects', 'create_project', 'rename_project', 'remove_project'], ['project', '项目', '工作目录']),
  helper('tasks.runtime', 'tasks', '任务运行设置', '当前/指定任务的 Harness、模型、权限和运行状态。', ['get_session_runtime', 'set_session_runtime', 'get_current_session_id'], ['task', 'session', '任务', '思考', '权限', 'harness']),
  { key: 'devices.ssh', domain: 'devices', title: 'SSH 连接与设备名字', summary: 'SSH 主机的查询、创建、改名、修改和移除。', aliases: ['ssh', '主机', '设备名字', '设备名', '改名'], server: 'cindy_ssh', tools: ['ssh_list_hosts', 'ssh_add_host', 'ssh_update_host', 'ssh_remove_host', 'ssh_reload_config'], notes: '显示名与连接 alias 区分；改名不修改远端机器 hostname。' },
  { key: 'tools.plugins', domain: 'tools-and-extensions', title: '插件及插件自身设置', summary: '按插件实时详情、手册和工具查询；保留 namespace 与实例身份。', aliases: ['plugin', '插件'], delegate: { server: 'cindy', tool: 'ghost_list', args: {} } },
  helper('tools.mcp', 'tools-and-extensions', '连接 MCP', '使用宿主的 MCP 配置表单。', ['request_mcp_setup'], ['mcp', '外部工具']),
  helper('tools.skills', 'tools-and-extensions', 'Skill 管理', '按当前宿主提供的 Skill 能力发现。', ['search_skills', 'start_skill_learning', 'publish_skill'], ['skill', '技能']),
  helper('runtimes.pi', 'runtimes-and-storage', 'Pi 托管运行环境', '读取版本、检查和安装托管 Pi；复用现有内核管理器。', ['get_pi_runtime', 'update_pi_runtime'], ['pi', '升级 pi', '更新 pi', '运行环境'], '更新不是改 JSON；正在运行的进程与后续任务使用版本分别报告。'),
  helper('application.update', 'application', 'Cindy 应用更新', '检查并通过内置更新器安装。', ['check_app_update', 'install_app_update'], ['cindy 更新', 'cindy 升级', 'app update'], '安装沿用内置更新器确认，不下载替换当前宿主。'),
  // Explicit gaps remain discoverable. Metadata must never imply a working mutation.
  ...[
    ['application.window', 'application', '窗口行为与开机启动', '唤醒、菜单栏、关闭窗口和激活点击', '窗口 开机 菜单栏 wake startup'],
    ['appearance.assets', 'appearance', '自定义壁纸和主题导入', '自定义媒体与主题的导入管理', '自定义壁纸 壁纸图片 导入主题 custom wallpaper'],
    ['groups.settings', 'groups-and-sharing', '群与共享设置', '群成员、分工、通知和共享权限', '群 共享 group sharing'],
    ['devices.remote-settings', 'devices', '远程控制与中转配置', '远控开关、中转服务和设备管理', '远程控制 中转 relay'],
    ['input.voice', 'media-and-input', '语音与输入设置', '麦克风、语言、词典、音效和配件', '语音 麦克风 词典 voice microphone'],
    ['storage.management', 'runtimes-and-storage', '存储与回收设置', '缓存、清理、回收与存储告警', '缓存 清理 回收 storage'],
    ['mobile.preferences', 'accounts-and-mobile', '手机本地设置', '发起请求的手机自身偏好，不是被控电脑的偏好', '手机 iphone android mobile'],
    ['accounts.settings', 'accounts-and-mobile', '账号资料与连接', '账号设置与安全连接流程', '账号 登录 account login'],
  ].map(([key, domain, title, summary, words]): Control => ({ key, domain, title, summary, aliases: words.split(' ') })),
];

export const controlQueryShape = {
  key: z.string().min(1).max(160).optional(),
  category: z.string().max(80).optional(),
  toolQuery: z.string().trim().min(1).max(200).optional(),
  operation: z.string().max(160).optional().describe('详情中已列出的工具名；只展开这一操作的完整 schema。'),
  cursor: z.string().max(512).optional(),
};
export type ControlQuery = { key?: string; category?: string; toolQuery?: string; operation?: string; cursor?: string };
interface ToolInfo { name: string; description: string; inputSchema?: unknown; }
interface Deps {
  registry: XdtHelperToolRegistry;
  allowedNames(): Promise<ReadonlySet<string>>;
  readRuntime?: RuntimeCapabilityReader;
  scopeKey(): string;
  local?(): boolean;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const payload = (raw: unknown): Record<string, unknown> | undefined => {
  if (!raw || typeof raw !== 'object') return;
  const data = raw as Record<string, unknown>;
  const blocks = data.content as Array<{ type: string; text?: string }> | undefined;
  if (!Array.isArray(blocks)) return data;
  const text = blocks.find(block => block.type === 'text')?.text;
  try { return text ? JSON.parse(text) : undefined; } catch { return; }
};
const error = (errorCode: string, message: string) => ({ ok: false, errorCode, message });

/** No nested business calls: discovery reads schema, never invokes a mutating handler. */
export function createControlReader(deps: Deps) {
  function localTool(name: string, detail: boolean, allowed: ReadonlySet<string>): ToolInfo | undefined {
    const tool = deps.registry.get(name);
    if (!tool || tool.hidden || !allowed.has(name)) return;
    return { name, description: tool.description, ...(detail ? { inputSchema: z.toJSONSchema(z.strictObject(tool.inputShape)) } : {}) };
  }
  async function toolsFor(control: Control, detail: boolean, allowed: ReadonlySet<string>) {
    if (deps.local?.() === false && (control.section || control.key === 'models.configuration' || control.key === 'runtimes.pi'))
      return { tools: [] as ToolInfo[], reason: 'requires_local_task' };
    if (!control.server) return { tools: [] as ToolInfo[], reason: 'not_exposed' };
    if (control.server === 'cindy_helper') {
      const tools = (control.tools ?? []).map(name => localTool(name, detail, allowed)).filter((tool): tool is ToolInfo => !!tool);
      return { tools, reason: tools.length ? 'available' : 'unavailable_in_context' };
    }
    if (!deps.readRuntime) return { tools: [] as ToolInfo[], reason: 'runtime_discovery_unavailable' };
    const runtime = payload(await deps.readRuntime({ server: control.server, category: control.server === 'cindy_scheduler' ? 'scheduler' : 'ssh' }).catch(() => undefined));
    if (!runtime?.ok) return { tools: [] as ToolInfo[], reason: 'unavailable_in_context' };
    const discovery = payload(runtime.discovery);
    const all = Array.isArray(discovery?.tools) ? discovery.tools as ToolInfo[] : [];
    const tools = all.filter(tool => control.tools?.includes(tool.name));
    if (detail) return { tools: await Promise.all(tools.map(async tool => {
      const read = payload(await deps.readRuntime!({ server: control.server, toolName: tool.name }).catch(() => undefined));
      const described = payload(read?.discovery);
      return described?.ok && described.tool ? described.tool as unknown as ToolInfo : tool;
    })), reason: tools.length ? 'available' : 'unavailable_in_context' };
    return { tools, reason: tools.length ? 'available' : 'unavailable_in_context' };
  }
  return async (query: ControlQuery): Promise<Record<string, unknown>> => {
    if (query.key && query.toolQuery) return error('INVALID_ARGS', 'key 与 toolQuery 不能同时使用。');
    if (query.operation && !query.key) return error('INVALID_ARGS', 'operation 需要明确的 key。');
    if (query.category && !domains.some(([id]) => id === query.category)) return error('UNKNOWN_DOMAIN', '请查询 control 目录取得领域 ID。');
    // New registered helper operations stay searchable without adding another
    // prompt paragraph or waiting for a hand-written product topic.
    const represented = new Set(CONTROL_CATALOG.filter(item => item.server === 'cindy_helper').flatMap(item => item.tools ?? []));
    const nativeDomains: Record<string, string> = { settings: 'application', bots: 'teammates', control: 'tasks', history: 'tasks', skills: 'tools-and-extensions', app_update: 'application' };
    const allowed = await deps.allowedNames();
    const native = deps.registry.list().filter(tool => !represented.has(tool.name) && allowed.has(tool.name))
      .map(tool => helper(`native.${tool.name}`, nativeDomains[tool.category] ?? 'application', tool.name,
        tool.description.slice(0, 180), [tool.name], [tool.name]));
    const catalog = [...CONTROL_CATALOG, ...native];
    const next = (key: string) => ({ server: 'cindy_helper', tool: 'list_tools', args: { key } });
    if (query.key) {
      if (query.cursor) return error('INVALID_ARGS', '单项详情不接受列表游标。');
      const control = catalog.find(item => item.key === query.key);
      if (!control || (query.category && query.category !== control.domain)) return error('UNKNOWN_CONTROL', '未找到能力；用 list_tools({query}) 搜索。');
      if (query.operation && !control.tools?.includes(query.operation)) return error('UNKNOWN_OPERATION', '请先读取该能力列出的操作。');
      if (control.delegate) return { ok: true, control: { key: control.key, title: control.title, kind: 'delegate', summary: control.summary, availability: 'delegated', next: control.delegate } };
      const scoped = query.operation ? { ...control, tools: [query.operation] } : control;
      // Full schemas are fetched only for an explicit operation; overview stays compact.
      const found = await toolsFor(scoped, !!query.operation, allowed);
      const operations = found.tools.map(tool => ({ name: tool.name, description: query.operation ? tool.description : tool.description.slice(0, 180),
        call: { server: control.server, tool: 'call_tool', args: { name: tool.name, ...(control.section ? { args: { section: control.section } } : {}) } },
        ...(query.operation ? { inputSchema: tool.inputSchema, schemaComplete: !!tool.inputSchema }
          : { describe: { server: 'cindy_helper', tool: 'call_tool', args: { name: 'get_capabilities', args: { scope: 'control', key: control.key, operation: tool.name } } } }),
      }));
      return { ok: true, control: { key: control.key, domain: control.domain, kind: control.section ? 'settings' : 'operations', title: control.title, summary: control.summary, availability: found.reason,
        scope: '以原生工具 schema 和目标端结果为准；默认本机，不代表发消息的手机。',
        ...(control.notes ? { notes: control.notes } : {}), operations,
        missingOperations: (scoped.tools ?? []).filter(name => !found.tools.some(tool => tool.name === name)),
        definitionRevision: hash([control, operations]),
        ...(control.section ? { settingsSchema: { server: 'cindy_helper', tool: 'call_tool', args: { name: 'get_app_settings', args: { section: control.section } } } } : {}),
        recovery: '恢复默认、撤销和外部操作恢复以领域声明为准；本目录不提供全局事务或回滚。',
      } };
    }
    if (!query.category && !query.toolQuery && !query.cursor) return { ok: true, domains: domains.map(([id, title, summary]) => ({ id, title, summary })),
      next: 'call_tool({name:"get_capabilities",args:{scope:"control",category:<id>}})', coverage: '包含独立界面；每项详情说明实际接通情况，不代表全量设置均已开放。' };
    const term = query.toolQuery?.toLowerCase().trim();
    const score = (item: Control) => {
      if (!term) return 1;
      if (item.key === term) return 100;
      // Agents often search with the exact tool name a prompt gave them.
      if (item.tools?.includes(term)) return 90;
      const words = [item.key, item.title, ...item.aliases].map(word => word.toLowerCase());
      return (item.summary.toLowerCase().includes(term) ? 1 : 0) + words.reduce((n, word) => n + (word.includes(term) || term.includes(word) ? Math.min(word.length, 20) : 0), 0);
    };
    const matching = catalog.filter(item => !query.category || item.domain === query.category)
      .map(item => ({ item, score: score(item) })).filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score || a.item.key.localeCompare(b.item.key)).map(row => row.item);
    const fingerprint = hash([deps.scopeKey(), query.category, term, catalog]);
    let offset = 0;
    if (query.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
        if (cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > matching.length) throw new Error();
        offset = cursor.offset;
      } catch { return error('INVALID_CURSOR', '游标已失效或查询条件已改变，请重新查询。'); }
    }
    const page = matching.slice(offset, offset + 5);
    const items = await Promise.all(page.map(async item => ({ key: item.key, title: item.title, summary: item.summary,
      availability: item.delegate ? 'delegated' : (await toolsFor(item, false, allowed)).reason,
      next: next(item.key),
    })));
    return { ok: true, items, total: matching.length, complete: offset + items.length >= matching.length,
      nextCursor: offset + items.length < matching.length ? Buffer.from(JSON.stringify({ fingerprint, offset: offset + items.length })).toString('base64url') : null,
      scope: '当前任务工具面；离线或未接通不等于产品不支持。',
    };
  };
}
