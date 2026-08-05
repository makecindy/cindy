/**
 * cindy-tools 公共类型 —— Cindy 意识系统的内部工具集契约。
 *
 * 本包统一承载 Cindy 意识系统向 agent 暴露的
 * 工具一律经 MCP 注册,host(apps/desktop main)通过 deps 注入真实实现,
 * 包内不感知 Electron / 沙箱 / DB(设计规范规则 2:package 解耦)。
 *
 * 首个成员:ghost 总机(docs/dev-rules/plugin-security-and-authoring.md 的网关模式)——
 * agent 工具箱里永远只有 ghost_list / ghost_call 两件固定工具,
 * 已装意识的增删即时反映在 ghost_list 的**返回内容**里,
 * 工具定义(缓存前缀)自始至终零变化。
 */

/** 意识注册的单个工具(来自 ghost.json 的 tools 声明,host 透传)。 */
export interface CindyGhostToolInfo {
  name: string;
  description: string;
  /** JSON Schema(object)形态的参数声明;无参工具省略。 */
  parameters?: Record<string, unknown>;
}

/** Host 对单条配置要求的脱敏分类；只描述能力，不携带配置值。 */
export type CindyGhostSetupRequirementKind =
  | 'oauth'
  | 'secret'
  | 'connection'
  | 'plugin_config'
  | 'client_config';

/** Host 对单条配置要求的权威状态。 */
export type CindyGhostSetupRequirementState = 'missing' | 'expired' | 'satisfied';

/** Agent 可选择、但只能由 Host 执行的配置动作。 */
export type CindyGhostSetupAllowedAction =
  | {
      /** Host 生成的动作引用，Agent 不得自行构造或直接执行。 */
      id: string;
      kind:
        | 'oauth_connect'
        | 'open_plugin_settings'
        | 'manage_connection'
        | 'open_client_settings';
    }
  | {
      /** Host 生成的散列动作引用；不包含 Secret storage key。 */
      id: string;
      kind: 'inline_form';
      form: {
        fields: [
          {
            /** v1 单字段固定为 value；它不是 storage key。 */
            id: 'value';
            type: 'secret';
            label: string;
            description?: string;
            placeholder?: string;
            required: true;
            maxLength: number;
          },
        ];
      };
    };

/**
 * ghost_list 返回的 Host 权威配置评估。只含引用、展示信息和允许动作，
 * 禁止携带 Secret、Token、OAuth client secret 或 Connection 内容。
 */
export interface CindyGhostSetupAssessment {
  state: 'ready' | 'required';
  /** Host 单调递增的状态版本；Agent 回传 plan 时必须原样带回。 */
  revision: number;
  /** groups 之间 all-of；每组 items 之间按 mode(any-of)判定。 */
  groups: Array<{
    id: string;
    mode: 'any_of';
    items: Array<{
      /** Host 生成的稳定 requirement 引用，仅用于关联，不是可执行能力。 */
      ref: string;
      kind: CindyGhostSetupRequirementKind;
      label: string;
      description?: string;
      state: CindyGhostSetupRequirementState;
      actions: CindyGhostSetupAllowedAction[];
    }>;
  }>;
  /** 插件仍 ready 时的非阻塞重连建议；不得解释为 SETUP_REQUIRED。 */
  reauthSuggest?: {
    ghostId: string;
    secretKey: string;
    missingScopes: string[];
    missingScopeCount: number;
    requirement: {
      ref: string;
      kind: 'oauth';
      label: string;
      action: {
        id: string;
        kind: 'oauth_connect';
      };
    };
  };
}

/** Agent 为 Ask 风格配置卡编排的展示步骤；Host 校验后才可采用。 */
export interface CindyGhostSetupPlan {
  /** 生成本 plan 时看到的 assessment revision。 */
  assessmentRevision: number;
  /** 卡片正文；插件名称与 icon 仍只由 Host 提供。 */
  intro?: string;
  steps: Array<{
    id: string;
    requirementRefs: string[];
    title: string;
    description: string;
    /** 必须来自对应 requirement 的 allowed actions。 */
    actionId: string;
  }>;
}

/** ghost_list 返回的单段意识条目(仅"已装且唤醒"的意识在列)。 */
export interface CindyGhostInfo {
  id: string;
  name: string;
  /** 显式触发指令(用户敲 /<command> 点名调用);未声明则省略。 */
  command?: string;
  tools: CindyGhostToolInfo[];
  /**
   * Host 现查的配置评估。支持 Setup Runtime 的 Host 应尽量返回，但评估
   * 读取/计算失败时可省略；Agent 不得把字段缺失解释为 ready 或自行放行。
   */
  setup?: CindyGhostSetupAssessment;
}

/** ghost_call 的结构化失败分类(host 侧产生,总机原样透传给 agent)。 */
export type CindyGhostCallErrorCode =
  | 'GHOST_NOT_FOUND' // 未装入或已抽离
  | 'GHOST_ASLEEP' // 沉睡中(用户可在主界面侧边栏「插件」中唤醒)
  | 'GHOST_DISABLED_IN_WORKDIR' // 用户在当前工作目录停用了该意识(不要重试)
  | 'TOOL_NOT_FOUND' // 该意识没有这个工具
  | 'GHOST_CRASHED' // 电子脑执行中崩溃
  | 'TIMEOUT' // 执行超时(host 掐掉)
  | 'SETUP_REQUIRED' // 配置仍未就绪（无交互面或恢复前又变化）；可带脱敏 assessment，未派发插件
  | 'SETUP_CANCELLED' // 用户取消插件配置；原调用未派发，不要自动重试
  | 'ATTACHMENT_INVALID' // attachments 里的图片地址无法过户(格式/找不到/超数)
  | 'DIR_INVALID' // dir 目录无法过户(不存在/不在会话 workdir 内/超限额)
  | 'INTERNAL'; // 其它 host 侧错误

export type CindyGhostCallResult =
  | {
      ok: true;
      result: unknown;
      /** ready 语义不变；只在有非阻塞重连建议时由 Host 附加。 */
      setup?: CindyGhostSetupAssessment;
      /**
       * 本次调用期间由主机实际入库(cindy-media)的媒体地址账本(可选,
       * host 按 ghostId+callId 记账后随结果带回)。这是**主机侧事实**,
       * 意识代码删不掉——ghost_call 层在意识自己没声明任何媒体字段时,
       * 以 `xdt_media_produced` 注入返回体,兜底保证 IM/hook 出站至少
       * 能拿到产物地址(2026-07-16 实踩:意识画卡后删媒体字段,IM 用户
       * 收不到生成图)。
       */
      producedMedia?: string[];
    }
  | {
      ok: false;
      errorCode: CindyGhostCallErrorCode | (string & {});
      message: string;
      /** 仅 SETUP_REQUIRED 可附 Host 生成的脱敏评估，供无交互面明确降级。 */
      setup?: CindyGhostSetupAssessment;
    };

/** ghost_forge_pack 的结构化失败分类(host 侧产生,原样透传给 agent)。 */
export type CindyForgePackErrorCode =
  | 'DIR_NOT_FOUND' // 目录不存在或不是目录
  | 'MANIFEST_INVALID' // ghost.json 缺失 / 不合法(message 带具体原因)
  | 'ENTRY_MISSING' // 清单声明的 entry / panel.html 等文件不在目录里
  | 'TOO_LARGE' // 文件数或总体积超上限
  | 'INTERNAL';

export type CindyForgePackResult =
  | {
      ok: true;
      /** 打包产物(.cindy)的绝对路径(临时目录,装入后可弃)。 */
      cindyPath: string;
      id: string;
      name: string;
      version: string;
      /** 已弹出装入/更新确认框,等用户决定;装不装永远由用户点头。 */
      note: string;
    }
  | { ok: false; errorCode: CindyForgePackErrorCode; message: string };

/** ghost_forge_scaffold 可生成的四种起步模板。 */
export type CindyForgeScaffoldTemplate =
  | 'plain'
  | 'agent-action'
  | 'node-json-rpc'
  | 'node-mcp';

export type CindyForgeScaffoldResult =
  | {
      ok: true;
      dir: string;
      template: CindyForgeScaffoldTemplate;
      /** 创建的相对文件路径；不会包含临时文件。 */
      files: string[];
      nextSteps: string[];
    }
  | {
      ok: false;
      errorCode: 'INVALID_INPUT' | 'TARGET_EXISTS' | 'INTERNAL';
      message: string;
    };

/** host 注入的依赖:总机的全部真实能力都在这几个回调里。 */
export interface CindyGhostsMcpDeps {
  /**
   * 现查"已装且唤醒"的意识清单(总机不缓存——装/卸/唤醒/沉睡即时反映,
   * 这正是网关模式让老会话立即生效的机制)。
   */
  listAwakeGhosts(): Promise<CindyGhostInfo[]>;
  /**
   * 把工具调用派进目标意识的电子脑并等待结果(按需拉起沙箱、超时、
   * 崩溃分类全在 host 侧处理)。
   */
  callGhostTool(request: {
    ghostId: string;
    tool: string;
    args: Record<string, unknown>;
    /**
     * 用户图片过户(可选):会话里用户图片的地址(xdt-image:// /
     * cindy-media://blobs/ / 本机绝对路径,主机归一化并验归属)。
     * host 把每张图落媒体总仓、给目标意识记可读引用(人工确认的引渡才形成
     * 按张永久授权；工作目录/Full Access 等 Host 代办交接不冒充用户授权),
     * 再以指纹数组注入 args.attachments 交给意识——
     * 意识拿到的仍只是字符串指纹,摸不到路径与字节。
     */
    attachments?: string[];
    /**
     * 批量交接(可选):true 时本次调用**只做 attachments 过户、不派发
     * 工具**(tool/args 被忽略)。用途:agent 计划连续多次调用同一意识、
     * 每次用一个 workdir 外文件时,先把整批文件一次性过户——非 Full Access
     * 下用户只见一张列出全部文件的确认卡；Full Access 下自动交接、不弹卡，
     * 且不会形成降档后仍生效的人工永久授权。
     * 普通调用 attachments 上限 4 张,grant_only 放宽(上限由 host 定)。
     */
    grantOnly?: boolean;
    /**
     * 目录过户(可选):要整体交给意识上传的本地目录**绝对路径**(部署
     * 构建产物等场景)。host 验证路径；workdir 内直接放行，workdir 外仅
     * 本地 Full Access 自动过户，其它权限档及远程会话须用户确认。随后收集
     * 文件并预检限额、发一次性限时票据,以 args.dir_deposit =
     * { token, file_count, total_bytes, rel_paths } 注入交给意识——意识拿到
     * 的只有票据与相对路径清单,摸不到绝对路径与文件字节;上传时经
     * fetch-request 的 uploadDir 报 token,主机凭票读盘代组 multipart。
     */
    dir?: string;
    /**
     * 下行落盘过户(可选):让意识把下载的文件存进的本地目录**绝对路径**
     * (附件下载等场景)。host 验证为已存在目录；workdir 内直接放行，
     * workdir 外仅本地 Full Access 自动过户，其它权限档及远程会话须用户
     * 确认。随后发限时票据,以 args.save_deposit = { token, dir_name } 注入
     * 交给意识——意识经 fetch-request 的 as:'file' + saveTo 报 token,主机
     * 把响应字节直接写进该目录(文件名消毒去重,不覆盖);意识全程摸不到
     * 绝对路径与文件字节。
     */
    saveDir?: string;
    /**
     * Agent 基于 ghost_list.setup 编排的展示计划。Host 必须按最新
     * assessment 校验 revision、requirementRefs、actionId 和覆盖关系；
     * 本字段永不注入插件 args，也不代表授权或完成。
     */
    setupPlan?: CindyGhostSetupPlan;
    /**
     * agent 侧 tool_use id(卡槽③锚定用,可选):claude 路径由 MCP 请求的
     * `_meta["claudecode/toolUseId"]` 提供(未文档化 key,取不到属正常路径);
     * codex 路径无此值。host 把它登记给卡片服务,renderer 据此把进行中的
     * 卡片精确锚到消息流对应工具行。
     */
    agentToolUseId?: string;
  }): Promise<CindyGhostCallResult>;
  /**
   * 花名册快照(可选,同步):server 创建(= 会话装配)时调用一次,把
   * "已装且唤醒"的意识名单 + 自我介绍写进 ghost_list / ghost_call 的工具
   * 描述——模型开局即认识本机意识,语义召回不再依赖字面词表命中。
   * 会话内工具定义恒定(prompt 缓存安全);装/卸/唤醒/沉睡在新会话生效,
   * 实时清单仍以 ghost_list 为准。缺省 = 不注入(描述与今日基线一致)。
   */
  getRosterItems?(): Array<{ id: string; name: string; command?: string; description?: string }>;
  /** 意识编写手册(markdown,随主机版本走;agent 写意识前先读)。 */
  forgeGuide(): Promise<string>;
  /**
   * 在新的目标目录创建一份安全起步骨架。目标已存在时必须拒绝，绝不覆盖
   * 用户文件；Node 模板只生成随包源码，不安装依赖。
   */
  forgeScaffold(request: {
    dir: string;
    template: CindyForgeScaffoldTemplate;
    id: string;
    name: string;
    description?: string;
  }): Promise<CindyForgeScaffoldResult>;
  /**
   * 把一个源码目录校验 + 打包成 .cindy,并弹出与拖入/双击完全相同的
   * 装入(同 id 已装则更新)确认框——装不装永远由用户决定,agent 只能
   * 递到用户面前。
   */
  forgePack(request: {
    dir: string;
    /**
     * 用户明确选择 AI 图标后，由图片工具返回的 cindy-media 地址。Host
     * best-effort 把它嵌入包内；失败保留源码里的默认图标，不阻塞打包。
     */
    iconSource?: string;
  }): Promise<CindyForgePackResult>;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}
