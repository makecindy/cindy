## 3.5 工具面设计:直接声明,还是两段式目录

工具怎么摆有两种形态,按"数量 × 粒度"选,选错会让单插件详情和全量查询结果臃肿:

**直接声明(默认,绝大多数插件用这个)**:每个工具在 tools 里逐条声明(§3 的写法)。
适用:工具是"意图级"的——一个工具对应用户会说的一句话(如"生成音乐"、"部署站点"),
数量一只手到一打(主机硬上限 16 项,超了直接拒装)。收益全在明处:模型通过
`ghost_info` 拿到插件详情后,靠各工具 description 选择具体能力;详情页把每个工具
如实列给用户;工具名不存在主机直接拦。

**两段式目录(大工具面专用)**:要包的能力是"端点级"的几十上百个操作(典型:给一个
大 API 面做接入,操作粒度是 list_xxx / get_xxx / create_xxx)时,**别把它们全塞进
tools**——本插件的 `ghost_info` 单条详情会被撑大,不知道装了什么时 `ghost_list`
的全量结果也会被拖重,而且 tools 硬上限 16 根本装不下。改为只声明两个元工具,
目录和分发表放进 main.js 自己维护:

```json
"tools": [{
  "name": "list_tools",
  "description": "列出本插件可用的操作。不传 category 返回类目概览(类目名+数量);传 category 返回该类目下所有操作的名称、说明与该类目 RULES。",
  "parameters": { "type": "object", "properties": { "category": { "type": "string", "description": "类目名,来自概览" } } }
}, {
  "name": "call_tool",
  "description": "执行一个具体操作。name 来自 list_tools 的返回;args 按该操作的参数说明传 JSON 对象。",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "操作名" },
      "args": { "type": "object", "description": "操作参数,不确定时可传 {} 触发错误反馈拿 schema" }
    },
    "required": ["name"]
  }
}]
```

两段式必须守的约定(AI 跨插件零学习成本,靠的就是这套一致性):

- 元工具名固定叫 `list_tools` / `call_tool`,不要自创同义词;
- `list_tools` 支持类目下钻:不传 category 给概览,传了给明细——目录大时别一次全量倒出;
- `list_tools(category)` 返回工具明细时,必须在同一份结果里一并下发该类目的
  **RULES**,让模型在调用前拿到适用规则。推荐每个工具用 `rules: [规则键]`
  声明引用,结果顶层用 `rules: { 规则键: 完整规则正文 }` 去重下发;也可以直接
  下发清晰的 RULES 段,但不能只给工具名与说明、把必要规则留到调用失败后才说;
- `call_tool` 收到不认识的 name 时,失败结果附可用工具名与回查
  `list_tools(category)` 的提示;收到不合法的 args 时,失败结果必须附该工具正确的
  参数 schema **和本次自纠必需的规则**(规则正文或能在本结果中解析的引用)——AI 会照着
  自纠重试,比干巴巴报错省一轮追问;
- 能力透明的代价自己补:插件详情只会逐条列出 list_tools / call_tool 两个元工具,用户
  看不出背后有多少操作。把给人看的能力范围如实写进 ghost.json 的 description,
  再把模型应在什么场景发现你的场景枚举写进 whenToUse,别让人或模型装完才发现。

`list_tools` 是插件声明的顶层工具,不是 Host 固定工具;实际通过
`ghost_call({ ghost_id: "my-ghost", tool: "list_tools", args: { category: "deploy" } })`
调用。类别 RULES 如果依赖跨工具/跨类别工作流或深入说明,不要复制正文,而应给出完整
`ghost_manual({ ghost_id: "my-ghost", path: "operations/references/deploy.md" })` 调用。
反过来,Manual 也可以用上面的完整 `ghost_call(... list_tools ...)` 调用指向实时工具目录。
两条路径可以反复交叉,没有固定先后顺序;信息足够时,用 `ghost_call` 调顶层工具,
或由两段式插件的 `call_tool` 执行具体操作。

分界线的手感:一打以内、意图级 → 直接声明;几十以上、端点级 → 两段式。两段式首次
使用多一跳(先翻目录),目录进上下文后,同一会话的后续调用与直接声明无异。
