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
 *  - "外部数据源 / 服务的 MCP 接入" 各自独立 bucket(jira / confluence / google-sheets / ai-art)
 *  - 飞书较特殊:"基础接入(登录/通知/MCP 文档表格等)" 与 "移动办公接管 session" 拆两个 bucket,
 *    因为后者是 Cindy 最差异化的能力,值得独立索引项让模型一眼能查到。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';

export interface CapabilityEntry {
  key: string;
  title: string;
  oneLiner: string;
  detail: string;
}

export const CAPABILITIES: readonly CapabilityEntry[] = [
  {
    key: 'about-cindy',
    title: `${BRAND_NAME} 自身信息(产品身份 / 开源仓库 / 源码位置)`,
    oneLiner: `${BRAND_NAME} 是什么、谁做的、开不开源、源码在哪、agent 跑在哪、版本号怎么查, 以及模型接入(官方服务 / 复用 Coding Plan / 自带 API key / 本地模型)与分区域官网下载定价。`,
    detail: [
      `【是什么】${BRAND_NAME} 是 XD Inc. 出品的开源 AI 助手(open-source AI assistant), 以桌面 / 移动客户端形态交付, 源码 https://github.com/makecindy/cindy (Apache-2.0)。官网分区域: 中国大陆 https://cindy.cn, 国际版 https://cindy.app —— 给下载 / 定价链接前先确认用户所在区域, 不要一律给国际版。`,
      `【身份归本条, 执行位置不归】问"你是谁 / 你是什么"以本条为准, 不要用训练数据猜, 也不要凭工作目录路径或工具名反推。但 ${BRAND_NAME} 只是编排方(管会话、工具、上下文与 memory; 底层 harness 是 Claude Code 或 Codex, 可中途切换且上下文连续), 不代表代码在哪执行: agent 进程与 workdir 可能在本机, 也可能在 SSH 远程工作区的远端主机(文件与进程都在远端), 或经设备互联隧道驱动的被控桌面端。问"你跑在哪 / 文件在哪台机器"时以当前会话实际工作区为准, 拿不准就说明, 不要断言。`,
      `【源码范围】该仓库是客户端本体(desktop、mobile 及共享 packages 的 pnpm monorepo), 服务端不在其中也不开源。安装版不携带源码, agent 侧无法推断用户是否 clone 过、clone 在哪: 要读改源码就让用户给路径或用工程模式打开, 不要假设固定路径, 更不要因为工作目录里出现品牌名就断定当前目录是源码仓库。`,
      `【版本号不要猜】本条不含版本号。CN 版可在"设置 → 关于"看到客户端版本; 国际版该页当前不展示它(只有更新开关与 agent 二进制版本), 别把用户支使过去空找。用 submit_github_issue 提反馈时客户端版本 / OS / 界面语言由系统自动附加, 不用 agent 填。`,
      `【模型怎么来】登录官方 ${BRAND_NAME} 服务按量透明扣费、授权已付费的 Claude Code / Codex Coding Plan 继续用(不重复付费)、接自己的 API key, 或跑本地模型。价格见对应区域官网。`,
    ].join(' '),
  },
  {
    key: 'ai-chat',
    title: 'AI 对话',
    oneLiner: '与 Claude Code / Codex agent 实时对话,支持代码执行、工具调用、多模态输入。',
    detail: [
      `${BRAND_NAME} 的核心入口:基于 Claude Agent SDK 接入 Claude Code,基于自建 AppServer 接入 Codex,两套 agent 在同一对话界面里使用。`,
      '消息支持文本 / 图片 / 本地文件三种输入。Markdown 渲染、代码高亮、表格、流式输出齐全,长会话用 render-window 优化避免卡顿。',
      '会话持久化在本地 SQLite,可全文搜索历史消息。',
    ].join(' '),
  },
  {
    key: 'agent-switching',
    title: 'Agent 切换',
    oneLiner: '同一会话或新会话间在 Claude Code 与 Codex 之间切换。',
    detail: [
      '运行时切 agent:Claude Code(Anthropic SDK)和 Codex(自建 AppServerHost,NDJSON 协议)双线接入。',
      '支持"问题转移到另一个 agent",新 agent 继承上文继续回答。',
      '跨厂商切换有守卫,从国产模型切回 Claude/GPT 时会提醒(避免环境变量污染)。',
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
      '【硬边界】Worker session 不能再开 team(嵌套禁止, 返 WORKER_CANNOT_NEST);Claude Code / Codex 本地项目 session 都可以作为 Lead 调 start_team;Worker 不能结束自己所在 team(返 WORKER_CANNOT_DISABLE);要求 Lead session 有 workingDir。',
      '【工具归属】13 个 team 工具(start_team / create_worker / create_workers / send_to_worker / list_worker_queue / update_queued_message / cancel_queued_message / list_workers / switch_focus / idle_worker / end_team / archive_worker / list_available_models)在独立的 cindy_orca server 直接顶层注册, 对应"协同模式"可关插件(Settings → Connections → Built-in Tools)。通用 session handoff 原语 send_to_session 在 essential 的 cindy_helper 的 handoff 类目下(走 call_tool, 常开, 供 skill 路由用)。',
      `【与 Claude Code Task tool / Codex subagent 的区别】Task / subagent 是 agent 框架内的子任务派发机制(子 agent 跑在同一 SDK 进程内、有限工具集、生命周期短、对话历史归属父 turn);${BRAND_NAME} 协同模式是业务层的 session 级编排(Lead/Worker 都是完整独立的 ${BRAND_NAME} session, 独立进程、UI 栏位、完整工具、独立对话历史, 长生命周期, 通过 main 进程 IPC + MCP bridge 通信)。两者不互斥, Worker 内部仍可用 Task/subagent 派子任务。`,
      '【手动入口】ChatInput「+」菜单里的「协同模式」项,开启态用橙色 UsersRound 图标与文字标识;用户也能在这里手动开/关,与本工具走同一份业务代码。',
    ].join(' '),
  },
  {
    key: 'session-handoff',
    title: 'Session Handoff(把消息派给已存在的 session)',
    oneLiner: 'skill 可读当前 sessionId,并把消息 handoff 到一个既有 session,适合把同一业务对象的二次处理路由回原上下文。',
    detail: [
      `【是什么】get_current_session_id(cindy_helper 自省类)+ send_to_worker(cindy_orca team 工具)/ send_to_session(cindy_helper handoff 类, 走 call_tool)配合使用。前者返回当前 ${BRAND_NAME} session 的 business id / agent_kind / working_dir, 后两者把一条控制层消息投递到指定 session;目标不在内存时会自动 resume, 投递成功即返回。`,
      '【典型场景】自动化 skill 首次处理某个外部业务对象(issue / jira / pr / 任意自定义 key)时, 先调 get_current_session_id 拿 session_id 并把它和外部 key 做持久化绑定;后续二次处理同一对象时, 调 send_to_worker(team 内 worker)或 send_to_session(任意已知 session)把增量信息 handoff 回那个 session, 保留原始上下文、决策链和历史工具调用。',
      '【skill 端伪代码】first_seen -> sid = get_current_session_id(); store(key, sid.session_id); later -> sid = load(key); if sid then send_to_worker / send_to_session({ target_session_id: sid, message: "...增量..." }) else fallback normal flow。',
      '【失败码】NOT_FOUND / DELETED 通常表示绑定失效,skill 应清掉绑定并回退; ARCHIVED 表示 session 已归档,skill 自己决定是否回退或等待未来的 unarchive 能力; BUSY 表示目标 turn 正在跑,本工具不排队,skill 自己决定 retry/backoff。',
      '【边界】它不是普通聊天入口,而是 session 间 handoff 的控制层能力;不会自动关闭当前 dispatcher session,也不会替 skill 管理绑定键的存储语义。',
    ].join(' '),
  },
  {
    key: 'session-management',
    title: '会话管理(含 Fork / Rewind / 批量归档)',
    oneLiner: '新建 / 关闭 / 搜索会话,在历史任意点 Fork 分岔或 Rewind 重跑;agent 还能批量归档整理。',
    detail: [
      '会话列表带搜索、按时间和工程目录组织。',
      'Fork:在任意历史消息处分裂出新会话,继承到该点为止的全部上文。',
      'Rewind:在当前会话回到历史点,改写发送内容后重新运行,原分支被替换。',
      'agent 批量整理:control 类工具 rename_sessions(批量改名)、archive_sessions / unarchive_sessions(批量归档/取消归档,把 status 在 active↔archived 间切换)。',
      '归档可逆、不删数据,经统一权威出口写库并广播 sessions:patched,侧栏即时收敛;不能归档当前正在运行的会话。',
      '以上操作都不破坏原数据,可放心试错。',
    ].join(' '),
  },
  {
    key: 'workdir-browser',
    title: '工程文件浏览器',
    oneLiner: 'VSCode 风格文件树 + 搜索 + 预览,与会话侧栏自动联动切换。',
    detail: [
      '打开会话所在工程目录后,侧栏自动切到文件浏览模式。',
      '支持文件名 / 内容搜索、大文件按需加载、语法高亮、Markdown / 表格预览。',
      '上下两层 Tab:上层是打开的会话,下层是打开的文件,可平行切换。',
    ].join(' '),
  },
  {
    key: 'issue-tracker',
    title: '官方反馈提交',
    oneLiner: '/issue 命令或自然语言发起,agent 对话式整理后经确认卡片提交 GitHub issue。',
    detail: [
      '用户输入 /issue(可带初始描述)或直接说"帮我提个 issue",agent 先追问澄清细节,',
      '整理出结构化标题与正文后调用 submit_github_issue(cindy_helper 的 feedback 类目)。',
      '提交前 App 内弹系统确认卡片,用户可编辑标题/正文、确认或取消;',
      `客户端版本 / OS / 界面语言由系统自动附加,最终创建到 ${BRAND_NAME} 官方 GitHub 仓库。`,
    ].join(' '),
  },
  {
    key: 'skillhub',
    title: 'Skill Hub(技能市场)',
    oneLiner: '本地 skill 管理 + 官方 skill 市场,以 .md 形式扩展 agent 能力。',
    detail: [
      '两个页签:Local(项目级 + 全局 skill),Market(官方 skill 仓库)。',
      'Skill 以 markdown 形式存储,可作为 /slash 命令或工具触发。',
      '支持发布、版本管理、以及通过飞书卡片走的审核流。',
      '让用户不用改代码就能给 agent 加新能力包。',
    ].join(' '),
  },
  {
    key: 'scheduler',
    title: '自动化调度',
    oneLiner: '按 cron 规则自动跑任务(定期分析、工单分拣等),含执行历史,agent 也能通过 MCP 工具自助管理。',
    detail: [
      '基于 cron 表达式创建定时任务,常见用法是每天定时跑 AI 工单分拣或周报生成。',
      'GUI 展示任务列表、上次执行结果、失败原因。已执行项可加黑名单防重复。',
      'agent 也能通过 MCP 工具(schedule_create / list / get / update / pause / resume / run_now / delete / list_runs)自助创建和管理调度,GUI 与 MCP 看到同一份数据。',
      '后端 SQLite 存储,有独立 Scheduler Host 进程管理生命周期。',
    ].join(' '),
  },
  {
    key: 'chat-history-query',
    title: '聊天历史查询(给 LLM 自助拉本地对话数据)',
    oneLiner: 'agent 通过 MCP 工具拉本地 SQLite 里所有 session / message 原始数据,适合做用户级 memory / 知识库整理。',
    detail: [
      `【是什么】${BRAND_NAME} 所有用户和 agent 的对话全部存在本地 SQLite(按 userId 物理隔离), 但用户原本看不到这些数据, 也无法让 agent 帮忙整理。cindy_helper 的 history 类工具开放了四个只读查询入口, 让 agent 能拿到原始 raw data 协助用户组织自己的 memory / 知识库系统。`,
      '【四个工具】(1)list_workdirs: 列出所有出现过的工作目录 + session 数 / 首末活动时间; (2)list_sessions: 按 workdir / 时间段 / agent_kind 过滤 session 元数据(不返消息内容); (3)get_chat_history: 按 session_ids / workdir / 时间段 / role "按元数据精确捞"原始消息(content / agentMeta JSON 解析后透传); (4)search_chat_history: 跨 session "按内容语义找"——自然语言 query, FTS5 全文(全量、永远可用)+ 向量语义(开启"聊天记录语义索引"后生效)RRF 融合, 返回命中 + 上下文窗口。',
      '【典型用法】"帮我总结这周和 agent 的讨论, 写成 memory 条目" → list_sessions({from: 周一 ISO}) 拿 sessionId 列表 → get_chat_history({session_ids: [...]}) 拿对话 → LLM 提炼成 memory。"我之前聊过 X / 上次怎么解决那个 bug"(只记得内容、不知道在哪) → search_chat_history({query}) 直接语义召回。"我在 xxx 项目里都聊过啥" → list_sessions({workdir}) → get_chat_history。',
      '【向量是增益不是依赖】search_chat_history 在用户没开 embedding / sqlite-vec 不可用时静默退化为纯 FTS, 搜索照常工作; 响应里 vector_used 标明向量是否生效。',
      '【分页】所有工具游标分页, 单次硬上限防炸 context, 但 hasMore + nextCursor 串联多次调用可拿全量, 不会丢信息。',
      '【权限】数据按 userId 物理隔离, 工具允许查当前用户所有 session 的全量历史。',
      '【与 memory-system 的区别】memory-system(cindy_memory)管理的是已经提炼好的 markdown 记忆条目; chat-history-query 给的是原始对话数据本身, 是上游素材。两者通常配合用: 先 get_chat_history 拉素材, 再 memory_write 落条目。',
    ].join(' '),
  },
  {
    key: 'memory-system',
    title: '记忆系统',
    oneLiner: '两层记忆:跨 agent 共享的 Maker Memory + 各 agent 原生记忆,均可通过 MCP 工具读写。',
    detail: [
      '两层并行:(1)Maker Memory,App 级共享库,跨 session 跨 agent 全局共享,可启用 / 禁用 / 重置;(2)Agent-native 记忆,Claude 走 SDK 内置 Auto Memory,Codex 走 AppServer 实验通道。',
      'Maker Memory 用 frontmatter + body 的 markdown 分片格式,自动维护 MEMORY.md 索引,超大时有 size 告警。',
      'agent 通过 MCP 工具操作:memory_list / read / search / write / delete,以及 memory_consolidate(瘦身)、memory_review(归纳)、session_search(跨历史 session 全文搜索)。',
      '系统提示自动注入记忆使用规则,模型主动决定何时存何时取。',
    ].join(' '),
  },
  {
    key: 'model-effort-switching',
    title: '模型 / Effort / Fast Mode 运行时切换',
    oneLiner: '会话进行中切换 Claude 模型、推理强度、权限模式、Fast Mode。',
    detail: [
      '不用重开会话就能调:换 Claude 模型(如 Opus / Sonnet / Haiku 之间切)、调推理强度 effort(快答 vs 深度思考)、切权限模式(sandbox / full)、开关 Fast Mode(走 Claude 1M context 通道,只在 Opus 4.6 可用)。',
      '修改立刻对下一条消息生效。',
    ].join(' '),
  },
  {
    key: 'feishu-integration',
    title: '飞书集成(基础接入)',
    oneLiner: '飞书 OAuth 登录、IM 通知、文件上传,以及 agent 可调用的飞书 MCP 工具集。',
    detail: [
      `使用飞书 OAuth 登录 ${BRAND_NAME}。任务完成、权限超期等事件通过 IM 推送通知。`,
      'agent 通过 MCP 工具读写飞书数据:文档(docx_search / read / append_blocks / insert_blocks / update_block)、多维表格(bitable_search / list_tables / list_fields / list_records)、Wiki 知识空间(wiki_search / read / create_node / recent_changes 等)、IM 消息(im_list_chats / read_messages / send_message)、联系人、日程、会议纪要。',
      '支持上传图片 / 文件到飞书(im_upload_image / im_upload_file),还有跨类型全局搜索 search_and_read。',
      '把"接管 desktop session 移动办公"这条独立能力请查 mobile-takeover bucket。',
    ].join(' '),
  },
  {
    key: 'mobile-takeover',
    title: '飞书移动办公(接管 desktop session)',
    oneLiner: '在飞书里发 /ctr 接管桌面端正在跑的 session,两端同屏推进、不互锁。',
    detail: [
      '触发流程:在飞书里给 bot 发 /ctr 斜杠命令 → 弹卡片选工作区 → 选要接管的 session → 接管开始。',
      '接管后是"路由"而非"转移":飞书消息路由到桌面同一个 session,桌面 renderer 仍能实时看到所有输出和工具调用,等于双端同屏。',
      '桌面端正在等待用户响应的卡片(权限审批 / ask / plan)会自动搬到飞书,在手机上点完就继续推进,无需切回电脑。',
      '桌面端不被锁,两端都能继续发消息推进同一会话,消息合并到同一处理队列按到达序处理。',
      '退出:detach 后桌面交互监听器自动还原。当前限制:接管模式下 agent 不能用 send_file_to_user 给飞书推文件(只在原生飞书 session 可用),其他 MCP 工具(art / scheduler / google 等)无差异。',
    ].join(' '),
  },
  {
    key: 'auto-update',
    title: '自动更新',
    oneLiner: '后台检测新版本,断点续传 + 完整性校验 + 增量更新,不打断会话。',
    detail: [
      '内置 cindy-updater 模块:启动和定时轮询检测版本,下载支持断点续传、SHA / MD5 校验、自动重试。',
      '增量包传输节省带宽。',
      '更新过程不中断当前会话,启动时若发现版本不一致会提示用户。',
    ].join(' '),
  },
  {
    key: 'jira',
    title: 'Jira 集成',
    oneLiner: 'agent 通过 MCP 工具搜索 / 创建 / 更新 / 流转 Jira 问题,支持多 site。',
    detail: [
      '基于 Atlassian OAuth 接入,与 Confluence 共用 token。',
      'agent 工具:sites_list(发现可用 site)、projects_search、issues_search_jql(JQL 高级搜索)、issue_get(详情含字段/评论)、issue_create / issue_update、issue_add_comment、issue_list_transitions / issue_transition(走工作流)。',
      '不需要打开 Jira 网页就能由 agent 帮你做工单的查询、归档、推进。',
    ].join(' '),
  },
  {
    key: 'confluence',
    title: 'Confluence 集成',
    oneLiner: 'agent 通过 MCP 工具检索 / 读 / 写 Confluence 页面、评论、附件。',
    detail: [
      '基于 Atlassian OAuth 接入,与 Jira 共用 token。',
      'agent 工具:sites_list、spaces_list / space_get、pages_search / page_get / page_list_children / page_create / page_update、blogpost_get、comments_list / comment_add、attachments_list / attachment_get。',
      '能让 agent 直接帮你查文档、生成新页面、追加评论,适合做 KB 整理和写作类任务。',
    ].join(' '),
  },
  {
    key: 'google-sheets',
    title: 'Google Sheets 集成',
    oneLiner: 'agent 通过 MCP 工具读取 Google Sheets 指定区间数据。',
    detail: [
      '基于 Google OAuth 接入。',
      'agent 工具:sheets_read_range(按 spreadsheet ID + A1 range 读取)。',
      '当前是只读集成,适合让 agent 拉取表格数据做分析或汇总,不能改写 Sheets。',
    ].join(' '),
  },
  {
    key: 'ai-art',
    title: 'AI 绘画 / 视频生成',
    oneLiner: 'agent 通过 MCP 工具做文生图、图编辑、视频生成。',
    detail: [
      'agent 工具:image_generate(文生图)、image_edit(多图融合 / 编辑)、video_generate(文生视频)、video_edit(参考图生视频)。',
      '图片支持多模型(gpt-image-2 / gemini),输入可以是在线 URL 或本地路径。',
      '视频生成基于 seedance 等供方,作为可选能力按 host 配置启用。',
      '生成结果存到本地,可在对话里直接展示,也可上传飞书或写入文档。',
    ].join(' '),
  },
] as const;

export function findCapability(key: string): CapabilityEntry | undefined {
  return CAPABILITIES.find((c) => c.key === key);
}

export function listCapabilityIndex(): Array<Pick<CapabilityEntry, 'key' | 'title' | 'oneLiner'>> {
  return CAPABILITIES.map(({ key, title, oneLiner }) => ({ key, title, oneLiner }));
}
