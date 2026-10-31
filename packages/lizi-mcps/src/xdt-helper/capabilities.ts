/**
 * xdt-helper/capabilities.ts
 * ---------------------------------------------------------------------------
 * Cindy 用户视角能力清单的"单一事实源"。
 *
 * 编辑规则:
 *  - one-liner 给模型用,要让模型一眼判断要不要拉 detail。控制在 ~50 字。
 *  - detail 是模型回答用户时的事实素材,不是写给用户读的。3-6 句,讲清:能做什么、
 *    用户怎么触达、当前限制(如有)。模型自己组织语言转述。
 *  - 半成品 / 未启用功能不要进这个清单(用户问的是"现在能做什么")。
 *  - 新增 bucket 时 key 用英文短 slug,与 router 路径 / IPC channel 名近似但不强绑定。
 *
 * Bucket 分类原则:
 *  - "用户产品功能" 一类一个 bucket(ai-chat / session-management / scheduler 等)
 *  - "外部数据源 / 服务接入" 各自独立 bucket(jira / google / ai-art);大多已迁为插件,经 ghost_* 调用
 *  - 飞书较特殊:"基础接入(机器人/通知/xd-feishu 插件)" 与 "IM 接管桌面任务" 拆两个 bucket,
 *    因为后者是 Cindy 最差异化的能力,值得独立索引项让模型一眼能查到。
 */

import { RICH_ANSWER_GUIDE } from '@cindy/maker-shared/rich-answer-guide';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

export interface CapabilityEntry {
  key: string;
  title: string;
  oneLiner: string;
  detail: string;
}

export const CAPABILITIES: readonly CapabilityEntry[] = [
  {
    key: 'rich-answers',
    title: '流式正文与可组合组件',
    oneLiner: '模型可自由组合正文图文、图表与交互控件，增量更新；按需查询组件协议，不要求另存 HTML。',
    detail: RICH_ANSWER_GUIDE,
  },
  {
    key: 'grok-login',
    title: 'Grok / SuperGrok 授权登录',
    oneLiner: 'Grok 有浏览器跳转和设备短码两种登录方式；agent 可发授权页与短码并查询完成状态。',
    detail: [
      '浏览器跳转登录在「设置 → 模型供应商」的 Grok 连接中可用；仅伙伴对话可调用 cindy 网关的 connect_account({kind:"host", id:"grok"}) 弹出连接卡，普通任务请使用设置页或下述设备码登录。',
      '设备码登录适合远程协助：agent 通过 cindy_helper 的 ask_owner（kind="connect"，service="grok"）取得 xAI 授权页和短码，发给用户；用户在授权页输入短码并确认，Cindy 在本机自动轮询并保存凭证。',
      'agent 可用 get_grok_login_status 查询连接状态，用户要求停止时可用 cancel_grok_device_login。长期 access token 和 refresh token 不会出现在工具返回值或聊天里；不要要求用户粘贴长期凭证。',
    ].join(' '),
  },
  {
    key: 'about-cindy',
    title: `${BRAND_NAME} 自身信息(产品身份 / 开源仓库 / 源码位置)`,
    oneLiner: `${BRAND_NAME} 是什么、谁做的、开不开源、源码在哪、agent 跑在哪、版本号怎么查, 以及模型接入(官方服务 / 复用 Coding Plan / 自带 API key / 本地模型)与分区域官网下载定价。`,
    detail: [
      `【是什么】${BRAND_NAME} 是 XD Inc. 出品的开源 AI 助手(open-source AI assistant), 以桌面 / 移动客户端形态交付, 源码 https://github.com/makecindy/cindy (Apache-2.0)。官网分区域: 中国大陆 https://cindy.cn, 国际版 https://cindy.app —— 给下载 / 定价链接前先确认用户所在区域, 不要一律给国际版。`,
      `【身份归本条, 执行位置不归】问"你是谁 / 你是什么"以本条为准, 不要用训练数据猜, 也不要凭工作目录路径或工具名反推。但 ${BRAND_NAME} 只是编排方(管会话、工具、上下文与 memory; 底层 harness 是 Claude Code 或 Codex, 可中途切换且上下文连续), 不代表代码在哪执行: agent 进程与 workdir 可能在本机, 也可能在 SSH 远程工作区的远端主机(文件与进程都在远端), 或经设备互联隧道驱动的被控桌面端。问"你跑在哪 / 文件在哪台机器"时以当前会话实际工作区为准, 拿不准就说明, 不要断言。`,
      `【源码范围】该仓库是客户端本体(desktop、mobile 及共享 packages 的 pnpm monorepo), 服务端不在其中也不开源。安装版不携带源码, agent 侧无法推断用户是否 clone 过、clone 在哪: 要读改源码就让用户给路径或用工程模式打开, 不要假设固定路径, 更不要因为工作目录里出现品牌名就断定当前目录是源码仓库。`,
      `【查源码排障】帮助文档(get_capabilities scope=help)没写到、或要确认 ${BRAND_NAME} 某个入口或行为的实际实现时, 可以只读查看 GitHub 上与用户版本对应的源码: 每个发布版本都有 tag(如 v0.1.118-beta; 当前版本号用 check_app_update 的 currentVersion 取), 用 gh 或网页按 tag 读取, 不要拿最新 main 对照旧版本。回答时说明结论来自源码; 服务端行为不在仓库里, 查不到就直说。`,
      `【版本号不要猜】本条不含版本号。所有版本都显示在侧栏左下角账号卡片上; CN 版的"设置 → 关于"也有, 国际版该页不展示(只有更新开关与 agent 二进制版本), 别把用户支使过去空找。agent 自己要版本号就调 check_app_update 读 currentVersion。用 submit_github_issue 提反馈时客户端版本 / OS / 界面语言由系统自动附加, 不用 agent 填。`,
      `【模型怎么来】登录官方 ${BRAND_NAME} 服务按量透明扣费、授权已付费的 Claude Code / Codex Coding Plan 继续用(不重复付费)、接自己的 API key, 或跑本地模型。价格见对应区域官网。`,
    ].join(' '),
  },
  {
    key: 'computer-use',
    title: 'Computer Use(操作本机桌面:窗口、点击、输入、截图)',
    oneLiner:
      '桌面操作只走 cindy_computer;工具列表里没有它就是 Computer Use 没开,引导用户到「设置 → 内置工具」开启并授权,不用 shell 模拟键鼠。',
    detail: [
      `【怎么判断没开】cindy_computer 这个 MCP 只在 Computer Use 开启时注册;当前工具列表里找不到 mcp__cindy_computer__* 时,说明用户没开,不是 ${BRAND_NAME} 没有这个能力。不要改用 osascript 按键、cliclick、CGEvent 脚本或 cua-driver CLI 代替,这些会被拒绝。`,
      '【怎么引导】告诉用户这一步需要操作桌面,请在「设置 → 内置工具 → Computer Use」打开开关;macOS 还会要求授予「辅助功能」和「屏幕录制」权限,设置页里有逐步引导。给用户这条链接可直接跳到那一页:cindy://settings/builtin-tools(桌面端点击即打开;手机或 IM 里收到时回到电脑上点)。开关和权限都要用户本人操作,agent 不能代为开启。',
      '【开启之后】Codex 任务的工具桥会自动刷新;Claude Code 任务的 MCP 列表在任务启动时固定,开启后让用户再发一条消息或新建任务,然后用 cindy_computer 的 list_tools 确认它已出现,再继续。',
      '【能做什么】list_windows / get_window_state 读窗口与无障碍树和截图,click / set_value / type_text / press_key / hotkey / scroll 操作目标窗口。Electron 与网页里的文本用 set_value;iOS 模拟器窗口不接受合成输入,用 xcrun simctl 或 AXe;有人正在用电脑时前台输入会被拒(USER_INPUT_ACTIVE),锁屏类快捷键被拒(HOTKEY_BLOCKED)。',
    ].join(' '),
  },
  {
    key: 'self-management',
    title: '自我管理(Agent 管理用户自己的任务 / 定时任务 / 项目 / 伙伴)',
    oneLiner:
      '用户本人能对自己的任务、定时任务、项目、伙伴做的操作，Agent 有哪些对应工具、哪些能管到另一台电脑。',
    detail: [
      '【任务链接】已知任务 id 时调用 history/get_task_digest，返回的 sessionUrl 可直接写成 [任务标题](sessionUrl)。list_sessions、search_chat_history、get_chat_history 的任务元数据也附带 sessionUrl，含所属电脑，支持桌面与手机打开。',
      '【原则】用户本人能做的操作(含跨电脑)，Agent 也应有对应工具；是否执行由权限档与自动审核决定。数据保存在各自的电脑上：下结论「没有 / 没人在跟」之前，先确认查的是不是只有本机。',
      '【任务】cindy_helper history 类：list_sessions / search_chat_history(device=local|all|<deviceId>)、get_chat_history(deviceId::sessionId)、get_task_digest(一件任务的 ≤2KB 摘要：状态、已持续分钟、最后的要求与回答、待答问题、错误、模型路线与建议换到的下一条、PR、排队数；deviceId::sessionId 只读)、list_history_devices 可跨电脑；list_workdirs、list_session_queue 仅本机。handoff 类 send_to_session：发给既有任务可跨电脑(deviceId::sessionId)，新建任务仅本机。control 类 archive_sessions / unarchive_sessions 可跨电脑(deviceId::sessionId，单次限定一台电脑)；改名、移动、标签、排队消息、插话、停止、运行设置、list_projects 与项目增删改仅本机。',
      '【定时任务】cindy_scheduler：schedule_list / get / list_runs(device=local|all|<deviceId>，list 可用 query 做文本筛选)与 schedule_update / pause / resume / delete / run_now / schedule_create / schedule_move(device 或 sourceDevice/targetDevice=<deviceId>)可跨电脑；schedule_set_pre_run_hook、当前运行的通知设置仅本机；本机定时任务可用 agentDeviceId 让每次新建的任务在其它电脑或分享来的供应商上运行（schedule_list_models 查位置与模型）。',
      '【伙伴】cindy_helper bots 类(仅伙伴任务可见)：list_agents / send_to_agent 可跨电脑(deviceId::botId)；get_teammate_home / move_teammate_home 查看与更换任一伙伴的主力电脑(跨电脑，更换按权限档)；资料、能力、待办、后台任务仅本机。list_teammate_projects / set_teammate_project 读取与修改自身关联项目，资料按需读取，关联不授予任务责任或执行权限。',
      '【自动跟进】宿主在任务卡住、等主人、出错、撞用量上限、做完时叫醒负责跟进的伙伴(内置例行任务)。伙伴先 get_task_digest 读摘要，再用 continue_workbench_task 让任务继续、send_to_session 代答低风险问题、set_session_runtime 换到 suggested_route(仅本机)、update_teammate_todo 记下要主人处理的事。get_workbench 是工作台「一眼」(等你 / 在做，仅本机投影)；负责「自动跟进所有任务」的伙伴可读取与继续另一台在线电脑上的任务(read_workbench_task / continue_workbench_task 传 deviceId::sessionId)，别的伙伴开的任务默认只读不继续(TASK_FOLLOWED_BY_OTHER_BOT，主人可在那位伙伴的设置里交出来)；其它伙伴只碰自己开的或接手的任务。',
      '【跨电脑的前提】对方电脑在线、同一账号、已开启远程控制。离线、未开启、版本不支持或超时会按电脑写明原因，结果里的 partial=true 表示有电脑没查到。',
      '【尚无工具】在另一台电脑上新建任务、管理另一台电脑上的任务(改名 / 停止 / 队列)与项目；这些用户可在远程控制里手动完成。定时任务可以 schedule_create(device=) 新建到另一台电脑，或 schedule_move 把已有闹钟迁过去。',
    ].join(' '),
  },
  {
    key: 'ai-chat',
    title: 'AI 对话',
    oneLiner: '在任务里与 Claude Code / Codex / Pi agent 实时对话,支持代码执行、工具调用、图片与文件输入。',
    detail: [
      `${BRAND_NAME} 的核心入口:基于 Claude Agent SDK 接入 Claude Code,基于自建 AppServer 接入 Codex,另有 Pi;三种 Harness 在同一任务界面里使用,每个任务互相独立、可并行。`,
      '输入支持文本、粘贴 / 拖入图片(PNG / JPEG / WEBP / GIF)、@ 引用文件与附加参考目录。Markdown 渲染、代码高亮、表格、流式输出齐全,长任务做了渲染窗口优化避免卡顿。输入框「+」菜单里可开「计划模式」(先出计划再执行)与「协同模式」。',
      '对话记录持久化在本地 SQLite;侧栏「搜索」可按标题或内容找任务(默认含已归档)。',
    ].join(' '),
  },
  {
    key: 'agent-switching',
    title: 'Agent(Harness)切换',
    oneLiner: '任务进行中可在 Claude Code / Codex / Pi 之间切换,新引擎通过交接摘要续接。',
    detail: [
      '在输入框的模型选择里换到另一 Harness 的模型即切换;会弹「切换 Agent？」确认(可勾「下次不再提醒」):新 Agent 引擎通过交接摘要续接,思考内容等不能保证完美继承;切回时仍可继续原引擎会话;切换会让 prompt 缓存中断一次,可能增加 Token 消耗。',
      '任务正在运行时切换会先登记,下一条消息发出时生效。SSH 远程任务暂不支持切换 Harness(可换同一 Harness 下的模型,或新建所需 Harness 的 SSH 任务)。',
      'agent 可用 cindy_helper control 类 set_session_runtime(harness + model)为本机任务登记切换,下一条消息发送时生效。',
    ].join(' '),
  },
  {
    key: 'collab-mode',
    title: '协同模式(Lead + Worker 双 session 编排)',
    oneLiner: 'Lead session 旁起一个独立完整的 Worker session, Lead 通过 worker_* MCP 工具向 Worker 派活, agent 可自行开/关。',
    detail: [
      `【是什么】${BRAND_NAME} 业务层在用户的 Lead session 旁边独立创建一个完整的 Worker session(独立 SDK 进程、独立对话历史、独立工具集), Lead 通过 worker_* MCP 工具向 Worker 派任务。UI 上以 split-pane 双栏呈现。`,
      '【怎么开】用户表达"用 worker / 协同模式 / 独立 agent / 派一个 agent 帮我 X"等意图时, Lead 调 start_team 工具创建 team, 再调 create_worker 工具添加 worker。worker 创建后可通过 send_to_worker 派活, 通过 list_workers 查看所有 worker, 通过 switch_focus 切换 focused worker。',
      '【怎么关】用户表达"够了 / 关掉 worker / 不要协同了"时, Lead 调 end_team 结束整个 team(归档所有 worker), 或调 archive_worker 归档单个 worker。Lead 自身保留可继续单 session 对话。',
      '【硬边界】Worker session 不能再开 team(嵌套禁止, 返 WORKER_CANNOT_NEST);Claude Code / Codex / Pi 本地项目或对话 session 都可以作为 Lead 调 start_team,也都可以作为 Worker;SSH 远程 Lead 与 Worker 当前只支持 Claude Code / Codex;Worker 不能结束自己所在 team(返 WORKER_CANNOT_DISABLE);要求 Lead session 有 workingDir。',
      '【Worker 放在哪】create_worker / create_workers 可让 Worker 继承 Lead 目录、用显式 working_dir 共用已有目录、或 new_worktree 新建独立 worktree(仅本机,归档时回收);也可用 execution_device_id 放到同账号另一台在线且开启远程控制的电脑上运行(get_workspace_info 的 execution_devices 列出可选电脑)。',
      '【工具归属】18 个 team 工具(start_team / create_worker / create_workers / send_to_worker / interrupt_worker / get_worker_queue_status / update_queued_message / cancel_queued_message / merge_queued_messages / steer_queued_message / move_queued_message / list_workers / switch_focus / idle_worker / end_team / archive_worker / update_worker / list_available_models)及诊断用的 get_workspace_info / worker_status / read_worker(Worker 完成会自动回报,不要用后两者轮询)在独立的 cindy_orca server 直接顶层注册, 对应可关的「协同模式」开关(设置 →「工具」→「内置工具」)。通用 session handoff 原语 send_to_session 在 essential 的 cindy_helper 的 handoff 类目下(走 call_tool, 常开, 供 skill 路由用)。',
      `【与 Claude Code Task tool / Codex subagent 的区别】Task / subagent 是 agent 框架内的子任务派发机制(子 agent 跑在同一 SDK 进程内、有限工具集、生命周期短、对话历史归属父 turn);${BRAND_NAME} 协同模式是业务层的 session 级编排(Lead/Worker 都是完整独立的 ${BRAND_NAME} session, 独立进程、UI 栏位、完整工具、独立对话历史, 长生命周期, 通过 main 进程 IPC + MCP bridge 通信)。两者不互斥, Worker 内部仍可用 Task/subagent 派子任务。`,
      '【手动入口】ChatInput「+」菜单里的「协同模式」项,开启态用橙色 UsersRound 图标与文字标识;用户也能在这里手动开/关,与本工具走同一份业务代码。',
    ].join(' '),
  },
  {
    key: 'session-handoff',
    title: 'Session Handoff(把消息派给已有任务)',
    oneLiner: 'skill 可读当前 sessionId,并把消息 handoff 到一个既有 session,适合把同一业务对象的二次处理路由回原上下文。',
    detail: [
      `【是什么】get_current_session_id(cindy_helper 自省类)+ send_to_worker(cindy_orca team 工具)/ send_to_session(cindy_helper handoff 类, 走 call_tool)配合使用。前者返回当前 ${BRAND_NAME} session 的 business id / agent_kind / project_path / working_dir, 后两者把一条控制层消息投递到指定 session;目标不在内存时会自动 resume, 投递成功即返回。`,
      '【典型场景】自动化 skill 首次处理某个外部业务对象(issue / jira / pr / 任意自定义 key)时, 先调 get_current_session_id 拿 session_id 并把它和外部 key 做持久化绑定;后续二次处理同一对象时, 调 send_to_worker(team 内 worker)或 send_to_session(任意已知 session)把增量信息 handoff 回那个 session, 保留原始上下文、决策链和历史工具调用。',
      '【skill 端伪代码】first_seen -> sid = get_current_session_id(); store(key, sid.session_id); later -> sid = load(key); if sid then send_to_worker / send_to_session({ target_session_id: sid, message: "...增量..." }) else fallback normal flow。',
      '【跨电脑】target_session_id 传 deviceId::sessionId(list_sessions 用 device 参数查到的 id)可发给另一台电脑上的既有任务,对方电脑需在线并开启远程控制;不能在另一台电脑新建任务。',
      '【硬规则】send_to_session 发给已有任务时 target_session_id 必传；不知道 id 先用 history/list_sessions 查。新建任务省略 project_path 继承来源归属，传已有项目路径切换项目，传 null 创建不绑项目的任务；可用 title 指定标题。get_current_session_id 可查询归属，control/list_projects 可选择其他项目。working_dir 只决定执行位置，不登记项目；新增或恢复项目单独用 create_project。无法确定来源归属时返回 INVALID_ARGS；成功创建返回 wake_kind=created 和 note，不等于投给既有任务。',
      '【失败码】NOT_FOUND / DELETED 通常表示绑定失效,skill 应清掉绑定并回退; ARCHIVED 表示 session 已归档，在已有恢复授权时可先用 control/unarchive_sessions 恢复，再发送新消息，不能自行推翻用户归档意图; 传了 id 但目标不存在只会返 NOT_FOUND,绝不自动新建。jump 撞上目标正在跑 turn 时不再返 BUSY,而是入队并成功返回 wake_kind=queued(可用 update/cancel_session_queued_message 管理);BUSY 仅是 create 模式的罕见兜底。',
      '【边界】它不是普通聊天入口,而是 session 间 handoff 的控制层能力;不会自动关闭当前 dispatcher session,也不会替 skill 管理绑定键的存储语义。',
    ].join(' '),
  },
  {
    key: 'session-control',
    title: '任务控制面(队列 / 插话 / 停止 / 运行探针)',
    oneLiner:
      'agent 可观察本机任务的队列与运行状态，并控制自己投递的队列消息、same-turn 插话或请求优雅停止(仅本机任务)。',
    detail: [
      '【授权】主人私聊输入及宿主实时核验的群内主人请求沿用普通任务权限流程，不另加行动确认卡。访客、转入消息及群授权核验暂不可用不算主人输入。自动唤醒、跟进责任与可用工具不增加操作授权。观察可以自动进行；发消息、插话、队列修改、停止、代答、恢复及模型/账号变更必须符合主人已委托的任务与动作范围，否则先展示目标、动作和内容并等待确认。',
      '【入口】cindy_helper 的 history 类 list_sessions / list_session_queue 提供 queuedCount、队列位置、来源、入队时间、正文摘要与 consuming 状态；control 类提供 update_session_queued_message、cancel_session_queued_message、steer_session_queued_message、move_session_queued_message、steer_session、stop_session_turn、get_session_runtime。',
      '【伙伴入口】伙伴可发现通用 control 类；主人请求沿用普通权限流程，自动轮次的实际写入须通过 Host 行动授权。自己的后台任务优先用专属入口：message_session_task 的 queue / steer / resume 分别表示排队、同轮插话、恢复暂停；stop_session_task 的 cancel / request-stop / pause 分别表示取消任务、请求当前轮停止、保留任务与队列的可恢复暂停。check_session_task 的 control 区分 pausing / paused；requested 或 unconfirmed 不能当作已停。不支持的引擎明确返回失败。',
      '【队列所有权】只能修改或撤回当前调用 session 自己通过 send_to_session 投递、且尚未进入 consuming 的消息；Orca、scheduler、用户或其它 session 的消息都会 fail-closed 拒绝。Orca worker 队列控制与这里复用同一底层生命周期实现。steer_session_queued_message / move_session_queued_message 把排队消息转为插话或调整顺序,可操作范围另含自己任务队列里由其它任务 / 协同成员发来的机器消息;没插成时消息留在队列并返回 reason。',
      '【插话】steer_session 只对正在运行且支持 same-turn steer 的 session 生效，在 provider 的下一个输入间隙注入当前 turn；若 turn 已结束会明确失败，不会退化成下一 turn。',
      '【停止】stop_session_turn 是请求式优雅停止：当前并行工具全部收尾后才发送 provider 软中断；不关闭 transport、不重建 session、不硬杀进程，超时未确认会返回 unconfirmed。',
      '【探针】get_session_runtime 返回统一 phase、记录状态、标题工作流语义、turn generation、开始时间、最后活动时间、当前动作摘要和停止状态；动作摘要有界且不包含提示词正文、工具参数或凭证。',
    ].join(' '),
  },
  {
    key: 'session-management',
    title: '任务管理(含查看已归档 / Fork / Rewind / 批量整理)',
    oneLiner: '新建、搜索、置顶、改名、移动、归档 / 取消归档、删除任务,查看已归档任务;从某条消息开新任务(Fork)或回退(Rewind);agent 可批量改名与归档。',
    detail: [
      '【列表】左侧主列表可按项目 / 对话 / 电脑分组。主列表标题(「全部任务 ▾」,按范围显示「本机任务」、设备名等)旁的「侧边栏显示设置」(滑杆图标,鼠标悬停标题行时出现;也可从标题下拉菜单里的「侧边栏显示设置」或侧栏空白处右键打开)管理分组、排序、筛选与显示。',
      '【右键菜单】置顶、重命名、移动任务、复制任务链接、在新窗口打开、归档、删除;已归档任务显示「取消归档」。删除后无法恢复。',
      '【查看已归档】归档后任务从默认的「活跃」列表移除。查看方式:「侧边栏显示设置」→「任务状态」→「已归档」(只看已归档)或「全部」;处于「已归档」时设置按钮常驻并带圆点提醒。侧栏「搜索」的状态默认为「全部」,按标题或内容能直接搜到已归档任务,也可在「搜索条件」→「状态」里只看「已归档」。用户要找某个具体的已归档任务时,直接给 list_sessions / search_chat_history 结果里的 sessionUrl 链接([任务标题](sessionUrl)),用户点开即可,不必先切筛选。',
      '【恢复】右键「取消归档」,或项目菜单「全部取消归档」;用户在桌面端打开已归档任务直接发消息,会自动取消归档回到「活跃」。agent 用 send_to_session 发给已归档任务则返回 ARCHIVED,不会自动恢复。',
      '【归档限制】运行中、正被远程接管的任务不能归档;项目 / 对话组「全部归档」与多选归档会跳过已置顶和运行中的任务;worktree 有未提交改动时归档前自动保存 git 快照。',
      'Fork:消息操作栏「开启一个新任务」,用到该点为止的上下文创建独立新任务,原任务不变。Rewind:「回到此处」移除这条消息之后的对话记录,有 Git 保存点 / 文件 checkpoint 时可同时把工作目录文件回退到那一刻;任务运行中会先停止;远端 Claude Code 任务暂不支持。Rewind 会丢弃后续对话,确认前会提示影响范围。',
      'agent 批量整理:control 类 rename_sessions(批量改名)、move_session(移动)、任务标签工具、archive_sessions / unarchive_sessions(每批 ≤50,把 status 在 active↔archived 间切换;跨电脑传 deviceId::sessionId,单次限定一台电脑;改名 / 移动 / 标签仅本机)。agent 没有删除、Fork、Rewind 任务的工具。',
      '归档可逆、不删数据,经统一权威出口写库并广播 sessions:patched,侧栏即时收敛;不能归档调用方自己所在的任务。恢复不启动执行、不发旧消息、不恢复暂停自动化；之后可用 send_to_session 发送新消息。',
      '本机批次原子写入；远程逐项执行，失败即停并返回已完成、失败与未执行项，不保证跨项事务；回执未知时先查状态再决定重试。',
      '更细的界面操作说明可查 get_capabilities({scope:"help", key:"sidebar"})。',
    ].join(' '),
  },
  {
    key: 'workdir-browser',
    title: '右侧栏面板(文件浏览器 / 审查 / 终端 / 浏览器等)',
    oneLiner: '任务右侧栏可开文件浏览器、审查(git 改动)、终端、浏览器、侧边追问、后台任务等面板,与主任务并行。',
    detail: [
      '右侧栏顶部「+」(添加标签)选择面板:「文件浏览器」(工作目录文件树、全项目搜索、预览与编辑保存)、「审查」(按 git diff 查看改动,可还原改动块,顶部「提交或推送」)、「终端」、「浏览器」、侧边追问(基于主任务上下文独立提问)、「Subagent」、「后台任务」、「资源监视器」,协同模式下有「协同」标签,插件也可提供面板。',
      '标签可拖动分组,也可「在独立窗口中打开」。部分面板(如终端、资源监视器)对远程任务暂不可用,面板内会写明原因。',
    ].join(' '),
  },
  {
    key: 'issue-tracker',
    title: '官方反馈提交',
    oneLiner: '/issue 命令或自然语言发起,agent 对话式整理后经确认卡片提交 GitHub issue。',
    detail: [
      '用户输入 /issue(可带初始描述)或直接说"帮我提个 issue",agent 先把反馈整理清楚再提交:缺什么问什么,不套固定问卷,不够清楚时不会急着提交。',
      '整理出对维护者有用的标题与正文,默认概括并脱敏;功能建议不写源码级方案。对话里的图不会传到 GitHub,不要声称截图已附。',
      '整理出结构化标题与正文后调用 submit_github_issue(cindy_helper 的 feedback 类目);用户明确同意公开相关日志时传 include_related_logs=true,系统自动生成独立的「相关日志」模块,并通过日志来源/字段白名单、脱敏和长度限制。',
      '提交前 App 内弹系统确认卡片,用户可编辑标题/正文、确认或取消;',
      '不需要安装或配置 GitHub 插件:默认由 Cindy 官方 Bot 提交;当前已配置且可用的 GitHub 账号只作为确认卡里的额外身份选项。',
      `客户端版本 / OS / Harness / 模型 ID / 界面语言由系统作为「提交时的任务环境」自动附加(OS 来自提交客户端本机,Harness / 模型是当前任务快照,不一定是出问题的那个)。用户说明的实际故障环境按需写进正文。最终创建到 ${BRAND_NAME} 官方 GitHub 仓库。创建后会返回 issue 链接,并可继续协助用户从源码复现、修复 Bug、开发功能和准备 PR。`,
    ].join(' '),
  },
  {
    key: 'skillhub',
    title: 'Skill(技能)与 Skill Hub',
    oneLiner: '本地技能管理 + Skill Hub 市场(公开 / 组织),Skill 是带 SKILL.md 的文件夹,三种 Harness 共用,以 / 命令触发。',
    detail: [
      '入口:主界面侧边栏「技能」页(与「插件」同一管理界面),含本地技能(全局 + 项目级)与 Skill Hub 市场;可导入 .zip 或 SKILL.md、安装、停用、卸载、发布与更新。',
      'Skill 是一个带 SKILL.md 的文件夹(同目录文件 agent 也能读),Claude Code / Codex / Pi 共用同一份,出现在输入框的 / 建议里。',
      'agent 工具(cindy_helper skills 类):search_skills(搜公开市场 / 所在组织)、publish_skill(仅在用户要求时上传或发新版本,首次发布须用户选可见范围)、get_skill_publish_status(扫描 / 审核状态,人工审核中如实告知、不要反复发布或轮询)、list_my_published_skills;start_skill_learning 对应 /learn,从当前任务提炼可复用 Skill。',
    ].join(' '),
  },
  {
    key: 'scheduler',
    title: '自动化调度',
    oneLiner: '按 cron 规则自动跑任务(定期分析、工单分拣等),含执行历史,agent 也能通过 MCP 工具自助管理,包括其它电脑上的定时任务。',
    detail: [
      '可按 cron / 间隔重复运行,或在指定时间运行一次;常见用法是每天定时跑 AI 工单分拣或周报生成。运行以普通任务的形式进行,可从运行记录打开对应任务。',
      'GUI 入口是主界面侧边栏「自动化」,展示定时任务列表、运行记录、失败原因,可暂停 / 恢复 / 编辑 / 删除。只在所在电脑的桌面端运行着时触发(不是云端 cron)。',
      'agent 也能通过 cindy_scheduler 工具(schedule_create / schedule_move / list / get / update / pause / resume / run_now / delete / list_runs,以及 schedule_list_models 查可选运行位置与模型、schedule_set_pre_run_hook 安装运行前检查脚本)自助创建和管理,GUI 与工具看到同一份数据。schedule_create 传 device 可把闹钟建在另一台电脑上；schedule_move 在目标 schedule_get 确认 active 后才停源任务。',
      '定时任务保存在各自的电脑上,工具默认只作用于本机:schedule_list / get / list_runs 传 device="all" 或某台电脑的 deviceId 可查其它在线且已开启远程控制的电脑(结果按电脑分组,没查到的电脑写明原因),update / pause / resume / delete / run_now / schedule_create / schedule_move 传 device 或 sourceDevice/targetDevice 可管理那台电脑上的任务。对方版本不支持远程创建时返回 REMOTE_UNSUPPORTED。',
      '后端 SQLite 存储,有独立 Scheduler Host 进程管理生命周期。',
    ].join(' '),
  },
  {
    key: 'chat-history-query',
    title: '聊天历史查询(本机与在线已授权电脑)',
    oneLiner: 'agent 可发现、列出和搜索本机与在线已授权电脑的聊天历史，并按任务读取内容。',
    detail: [
      '【引用任务】任务元数据的 sessionUrl 可直接写成 [任务标题](sessionUrl)；已知 id 只需链接时用 get_task_digest，无需读取完整聊天。',
      `【是什么】${BRAND_NAME} 的对话历史保存在各电脑的本地 SQLite。cindy_helper 的 history 类提供只读查询入口，让 agent 按宿主授予的范围读取历史，协助用户组织 memory / 知识库。`,
      '【六个工具】(1)list_workdirs: 列出本机出现过的工作目录 + session 数 / 首末活动时间; (2)list_sessions: 按 workdir / 时间段 / agent_kind 过滤 session 元数据，并附当前 queuedCount; (3)list_session_queue: 按 session_id 查看尚未消费消息的位置、来源、入队时间、正文摘要与投递状态; (4)get_chat_history: 按 session_ids / workdir / 时间段 / role "按元数据精确捞"原始消息(content / agentMeta JSON 解析后透传); (5)search_chat_history: 跨 session "按内容语义找"——自然语言 query, FTS5 全文(全量、永远可用)+ 向量语义(开启「启用对话记录语义索引」后生效)RRF 融合, 返回命中 + 上下文窗口; (6)list_history_devices: 发现本机与在线已授权电脑。',
      '【典型用法】"帮我总结这周和 agent 的讨论, 写成 memory 条目" → list_sessions({from: 周一 ISO, time_field: "activity"}) 拿 sessionId 列表 → get_chat_history({session_ids: [...]}) 拿对话 → LLM 提炼成 memory。"我之前聊过 X / 上次怎么解决那个 bug"(只记得内容、不知道在哪) → search_chat_history({query}) 直接语义召回。"我在 xxx 项目里都聊过啥" → list_sessions({workdir}) → get_chat_history。',
      '【伙伴跨渠道】get_teammate_state 返回本机连接；list_sessions / search_chat_history 使用 teammate_id=profile.id 匹配已保存的归属，含归档、旧历史和话题。按话题搜索不默认限制 workdir 或创建时间。旧 IM 未关联记录仍可在原有账号权限内按内容查询，结果 companion=null 不代表属于当前伙伴；当前连接、目录或名字都不能补造归属。source 是原始任务来源，伙伴渠道看 companion.channel 和消息来源。',
      '【跨设备】list_history_devices 发现设备；list_sessions / search_chat_history 传 device="all" 查询本机与在线已授权电脑，或 device=<设备 ID> 指定电脑。结果按设备分组，每组独立翻页，partial 表示有设备未查到。远程任务 ID 带 deviceId:: 前缀，可直接传给 get_chat_history；不读取离线缓存，旧端不支持会明确报告。默认 device="local" 保持原本机查询。',
      '【向量是增益不是依赖】search_chat_history 在用户没开 embedding / sqlite-vec 不可用时静默退化为纯 FTS, 搜索照常工作; 响应里 vector_used 标明向量是否生效。',
      '【分页】任务列表与聊天读取可用 hasMore + nextCursor 持续翻页；跨设备时每台电脑独立翻页。搜索受候选池上限约束，pool_capped=true 时应缩小查询范围，不能声称已经穷尽全部匹配。',
      '【权限】遵循宿主授予的账号历史权限与设备授权；仅有归属范围权限的调用方不能扩大范围，远程查询保留任务可见性限制。',
      '【与 memory-system 的区别】memory-system(cindy_memory)管理的是已经提炼好的 markdown 记忆条目; chat-history-query 给的是原始对话数据本身, 是上游素材。两者通常配合用: 先 get_chat_history 拉素材, 再 memory_write 落条目。',
    ].join(' '),
  },
  {
    key: 'memory-system',
    title: '记忆系统',
    oneLiner: '「Cindy」记忆(按工作目录跨 Claude Code / Codex / Pi 共享)或各 Agent 原生记忆二选一,agent 可经 cindy_memory 工具读写。',
    detail: [
      '入口:设置 →「个性化」→「记忆」。「Cindy」总开关(默认开)启用按工作目录共享的记忆,同一目录下 Claude Code、Codex 与 Pi 的任务共用;开着时 Claude Code / Codex 原生记忆开关置灰,关掉后各自用原生记忆。「Pi」选项需要 Cindy 记忆开启,会把长任务的压缩摘要存进 Cindy 记忆。各项可单独重置,重置不可撤销。改设置一般在新的 Agent 会话生效。',
      'Cindy 记忆是本机 user-data 下的 markdown 条目(frontmatter + 正文,自动维护 MEMORY.md 索引),不在代码仓库里,换电脑不会迁移。',
      'agent 通过 cindy_memory 工具操作:memory_list / read / search / write / delete,以及 memory_consolidate(瘦身)、memory_review(归纳)、session_search(跨历史任务全文搜索)。',
      '系统提示自动注入记忆使用规则,模型主动决定何时存何时取。记忆不是任务内的对话记录,也不是「个性化」里的自定义指令。',
    ].join(' '),
  },
  {
    key: 'model-effort-switching',
    title: '模型 / 推理强度 / 速度 / 权限模式切换',
    oneLiner: '任务进行中切换模型、推理强度、速度(标准 / 快速 / 超快)与权限模式,不用新建任务。',
    detail: [
      '输入框处随时可调:换模型(当前账号与供应商可用的模型)、「推理强度」、「速度」(标准 / 快速 / 超快;只在模型支持时出现,目前快速主要由 GPT / Codex 系模型提供,超快取决于当前账号的 Codex 目录)。',
      '权限模式:「默认权限」「自动审批」「完全访问」,Claude Code 另有「允许编辑」;另可开「计划模式」。',
      '模型、推理强度、速度的修改对下一条消息生效(运行中则在当前轮结束后)。agent 可用 cindy_helper control 类 set_session_runtime 调整本机任务的模型来源、模型、推理强度与速度(get_session_runtime 先读);伙伴任务另有 bots 类 get_app_default_model / set_app_default_model 读改以后新建任务的默认模型;agent 不能切换权限模式。',
    ].join(' '),
  },
  {
    key: 'feishu-integration',
    title: '飞书集成(基础接入)',
    oneLiner: '飞书 / Lark 机器人(私聊与群聊使用 Cindy、任务完成通知);飞书数据读写由企业档 xd-feishu 插件经 ghost 网关提供。',
    detail: [
      `飞书已不是 ${BRAND_NAME} 的登录方式(用 ${BRAND_NAME} 账号登录)。机器人在 设置 →「IM 机器人」→「个人」→「飞书 / Lark 机器人」配置:填自建应用的 App ID / App Secret 绑定,再私聊机器人一次完成主人绑定;可开「任务完成通知」(窗口失焦时私聊推送)与上下线「消息通知」。群里 @ 机器人会开话题回复,读群上下文需在飞书开放平台额外开通群消息权限。`,
      '出站通道 cindy_feishu_bot:普通桌面任务里经其 list_tools / call_tool 调 send_message_to_user / send_file_to_user,发到机器人主人的私聊(用户明确要求「发飞书给我」时才用);飞书轮次内另有作用域钉在当前对话的 send_text / send_markdown / send_file / 表情 / get_chat / get_message / 置顶 / call_api 等直通工具。',
      '读写飞书数据(云文档 docx / 多维表格 bitable / Wiki 知识库 / IM 消息搜索阅读 / 联系人 / 日程 / 审批 / 会议纪要)属于企业档 xd-feishu 插件:',
      '需在侧边栏「插件」安装并启用 xd-feishu、在其详情页连接账号;机器人绑定成功不等于该插件可用。',
      '这些操作不注册为顶层 MCP 工具——agent 须经 ghost 网关发现与调用(ghost_info({ghost_id:"xd-feishu"}) 查实时工具清单,再 ghost_call 执行)。',
      '从 IM 接管桌面任务这条独立能力请查 mobile-takeover bucket;其它 IM 渠道见 im-channels。',
    ].join(' '),
  },
  {
    key: 'mobile-takeover',
    title: 'IM 移动办公(/ctr 接管桌面任务)',
    oneLiner: '在飞书 / Telegram / Discord 等机器人里发 /ctr 接管桌面端的任务,两端同屏推进、不互锁;/exctr 退出。',
    detail: [
      '支持卡片的渠道可用:个人飞书 / Lark、Telegram、Discord 机器人,以及官方机器人。触发流程:给机器人发 /ctr → 卡片选工作区 → 选要接管的任务 → 接管开始;已在接管时再发 /ctr 可直接换一个任务。',
      '接管后是"路由"而非"转移":IM 消息路由到桌面同一个任务,桌面端仍能实时看到所有输出和工具调用,等于双端同屏。',
      '桌面端正在等待用户响应的卡片(权限审批 / ask / plan)会自动搬到 IM,在手机上点完就继续推进,无需切回电脑。',
      '桌面端不被锁,两端都能继续发消息推进同一任务,消息合并到同一处理队列按到达序处理。正被接管的任务不能归档或移动,需先结束接管。',
      '退出:发 /exctr(个人机器人也认 /exitctr)或点卡片上的退出;结束接管后桌面交互监听器自动还原。',
    ].join(' '),
  },
  {
    key: 'auto-update',
    title: '自动更新',
    oneLiner: '后台检测并下载新版本,提示重启安装;可开「空闲时自动安装更新」;agent 可在用户确认后代为更新。',
    detail: [
      '内置更新器在后台检测并下载新版本(断点续传 + SHA256 校验),下载完成后提示用户重启应用来安装,不会意外重启。「设置 → 关于」有「空闲时自动安装更新」开关,开启后在空闲时自动安装并重启(Linux 只在用户选择重启时应用)。',
      'agent 工具(cindy_helper app_update 类):check_app_update 只读检查;install_app_update 由宿主弹确认卡(写明目标版本、会重启、会中断哪些任务),用户确认后才经内置更新器下载、安装并重启,重启后结果写回发起任务;set_app_auto_update 同样经确认卡开关上述设置。只有主人本人发起的轮次能触发。',
      '不要用 shell 下载安装包或替换应用;开发版、个人版等不支持应用内更新的构建会明确返回原因。',
    ].join(' '),
  },
  {
    key: 'plugins',
    title: '插件(扩展工具、面板与外部服务连接)',
    oneLiner: '插件为 agent 增加工具、右侧栏面板和应用页;GitHub / GitLab / Google / Atlassian / 网页搜索等外部服务大多以插件提供,agent 经 ghost_* 网关发现与调用。',
    detail: [
      '入口:主界面侧边栏「插件」(与「技能」同一管理界面),可安装、启用 / 停用、卸载,在插件详情页连接账号;也可在设置 →「插件」管理。停用后工具与面板休眠,插件仍保留。',
      'agent 侧(cindy 网关):ghost_list 看已装插件、ghost_info({ghost_id}) 查实时工具清单、ghost_call 执行;插件工具不注册为顶层 MCP 工具。没有合适插件时 ghost_market_search 搜插件市场、ghost_market_install 按当前任务权限安装;需要连接账号时 connect_account({kind:"plugin", id}) 弹连接卡,不要向用户索要令牌。',
      '常见内置插件:cindy-github / cindy-gitlab(代码托管)、google-gmail / google-drive / google-calendar / google-sheets(部分组织为合并的 filo-google)、企业档 xd-atlassian(Jira / Confluence)、cindy-web-search(网页搜索)、企业档 xd-feishu(飞书数据)。实际可用以 ghost_list 为准,未启用返回 GHOST_ASLEEP,在当前工作目录被停用返回 GHOST_DISABLED_IN_WORKDIR。',
      '用户想自己做插件:ghost_forge_guide / ghost_forge_scaffold / ghost_forge_pack / ghost_forge_install / ghost_forge_publish 提供编写、打包、安装与发布流程。',
    ].join(' '),
  },
  {
    key: 'jira',
    title: 'Jira / Confluence(xd-atlassian 插件)',
    oneLiner: 'Jira 工单与 Confluence 文档的查询、创建、更新、评论,由 xd-atlassian 插件经 ghost 网关提供。',
    detail: [
      '原 lizi_jira / lizi_confluence MCP 已退役,能力合并进 xd-atlassian 插件(Atlassian OAuth,老账号已自动迁入)。',
      '需在侧边栏「插件」里启用 xd-atlassian 并在详情页连接 Atlassian 账号;agent 用 ghost_info({ghost_id:"xd-atlassian"}) 查实时工具清单,再 ghost_call 执行,不要假设旧的顶层工具名。',
      '插件列表里没有 xd-atlassian 时说明当前账号 / 构建未提供,不要承诺可用。',
    ].join(' '),
  },
  {
    key: 'google',
    title: 'Google(Gmail / Drive / Calendar / Sheets 插件)',
    oneLiner: 'Gmail、Google Drive、Google Calendar、Google Sheets 是四个独立内置插件，经 ghost 网关提供；部分组织账号改为合并的 filo-google 插件。',
    detail: [
      '原 lizi_google MCP(含只读的 sheets_read_range)已退役。公共内置插件按服务拆分:google-gmail / google-drive / google-calendar / google-sheets,各自在详情页连接 Google 账号授权;部分组织账号拿到的是合并的 filo-google(Filo Google)。',
      '实际装了哪个以 ghost_list 为准;agent 用 ghost_info 查实时工具与读写范围,再 ghost_call 执行。',
    ].join(' '),
  },
  {
    key: 'ai-art',
    title: 'AI 绘画 / 视频生成(media 工具)',
    oneLiner: 'agent 通过 cindy 网关的 media 工具做文生图、改图、文生视频、图生视频,也用它把已有图片交付给用户。',
    detail: [
      '旧 lizi_art 的 image_generate / video_generate 等工具已不再提供。现在统一走 cindy 网关的 media 工具:list_models 查当前账号可用的生图 / 视频模型(能力 image.generate / image.edit / video.generate / video.image_to_video),prepare → request 发起生成,异步任务按 recommended_poll_after_ms 调 poll。',
      '可用模型取决于当前账号的模型权限,不要猜模型名;prepare 返回的 invocation_id 是一次性付费令牌,超时或结果未知时不要自动重提以免重复扣费。',
      '结果是 cindy-media:// / xdt-image:// / xdt-video:// 受管地址,在回复里直接嵌入展示一次即可,手机端也能看;把已有截图或本地图片发给用户用 import_image。生成结果不自动附图给模型,是否查看图片或视频由 Agent 按任务需要决定。需要查看、抽帧或分析媒体时可主动用 resolve_local_path 按当前权限取得 Host 本机路径,再自行选择已有工具;无需用户先问存储位置,也不要把 Host 路径当作 SSH 工作区路径。',
    ].join(' '),
  },
  {
    key: 'im-channels',
    title: 'IM 机器人渠道',
    oneLiner: '在 Slack、Telegram、X、个人微信、企业微信、飞书 / Lark、钉钉、Discord 里使用 Cindy;设置 →「IM 机器人」配置。',
    detail: [
      '设置 →「IM 机器人」分两区:「官方」由 Cindy 提供并维护(Slack、Telegram、X 等卡片),无需自建机器人或凭证,按引导连接;「个人」用用户自己的账号或机器人:个人微信(扫码)、企业微信智能机器人、飞书 / Lark 机器人、钉钉机器人、Discord 机器人、Telegram 机器人,每个渠道的凭证、Agent / 模型与权限设置独立保存。可见渠道可能随账号与构建不同,以设置页实际显示为准。',
      '在 IM 里直接发消息即进入对应任务;常用命令有 /new、/stop、/model、/permission、/settings、/ctr(接管桌面任务,见 mobile-takeover)、/exctr、/help,各渠道支持程度不同。',
      '官方渠道(Slack / Telegram / X)的任务里,文字回复直接输出即可自动回到当前对话;发文件在最终回复里写 [文件名](xdt-file:///绝对路径)(文件须在当前工作目录内),图片直接引用受管地址。',
    ].join(' '),
  },
  {
    key: 'remote-and-mobile',
    title: '远程连接(手机 / 其他电脑控制,SSH 远端主机)',
    oneLiner: '同账号的手机与其他电脑可远程操控这台桌面上的任务;也可经 SSH 让 agent 在远端主机上运行。',
    detail: [
      '入口:设置 →「远程连接」。同一 Cindy 账号登录的设备自动出现,无需手动配对;每台设备有「我控制它」与「允许它控制本机」两个独立开关,本机另有允许被控制的总开关。手机 App 只做控制端,任务与数据都在被控电脑上。',
      '控制端可查看与推进被控电脑上的任务(发消息、审批、切模型等),账号密钥与全局设置等不开放给控制端。主列表标题「全部任务 ▾」可切换只看本机或某台远程电脑。',
      'SSH 远端主机:在同一页添加主机(也读取 ~/.ssh/config),可在远端安装 Claude Code / Codex / Pi(未安装时首条消息自动安装)并新建远端任务,agent 进程与文件都在远端。',
      'agent 侧跨电脑能力(查任务、给另一台电脑的任务发消息、管定时任务等)见 self-management。',
    ].join(' '),
  },
] as const;

export function findCapability(key: string): CapabilityEntry | undefined {
  return CAPABILITIES.find((c) => c.key === key);
}

export function listCapabilityIndex(): Array<Pick<CapabilityEntry, 'key' | 'title' | 'oneLiner'>> {
  return CAPABILITIES.map(({ key, title, oneLiner }) => ({ key, title, oneLiner }));
}
