## 4.11 发起 Agent 新回合(agent 能力)

`main.js` 可把文字作为**普通用户消息**交给 Cindy Agent，支持用户点卡片后让 Agent 继续。
消息不进入系统提示词，也不修改该会话里其它插件或 Agent 的长期规则。

最安全、也是默认的用法，是消费 `card-action` 事件里的真实用户点击票：

```js
cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'event' || msg.name !== 'card-action') return;

  const result = await cindy.agent.run({
    mode: 'continue', // continue = 继续原会话；fork = 从最新回复分叉；new = 新建会话
    promptTemplate: '用户要求：{{user_message}}\n插件事件：{{event_json}}\n请继续处理。',
    userMessage: msg.prompt || '继续',
    event: { actionId: msg.actionId, callId: msg.callId },
    userActionToken: msg.userActionToken,
    // title: '插件创建的新任务' // 仅 mode:'new' 时使用
  });

  if (!result.ok) {
    // result.errorCode / result.message 可用于把失败原因画回卡片
    return;
  }
  // result.sessionId = 实际工作的会话；disposition 说明新建/恢复/排队/分叉
});
```

模板规则由主机强制：

- `promptTemplate` 必须且只能出现一次 `{{user_message}}`；主机把
  `userMessage` 填进去。`{{event_json}}` 可出现零次或多次，主机统一替换成
  `event` 的 JSON。不要自己用字符串拼接绕开模板；
- `mode:'continue'` 使用被点卡片所属的原会话；`fork` 从原会话最新一条有效
  Agent 回复处分叉后再发送；`new` 继承原会话的 Agent、模型和工作目录配置；
- 票据绑定当前插件与卡片所属会话，两分钟有效、只能成功提交一次。runner 失败也
  不退票，避免一次点击被放大成多次收费回合；拿不到 `userActionToken` 时不要调用；
- 会话正在工作时不会硬插队，主机会把请求放进该会话的输入队列。最终文字、插件 id、
  插件版本、模板和事件 JSON 会随用户消息一起留存，方便用户知道这轮从哪里来。

只有清单额外声明 `"agent": { "background": true }` 时，才可不用当次票据：

```js
await cindy.agent.run({
  mode: 'continue',
  trigger: 'background',
  sessionId: rememberedSessionId,
  promptTemplate: '后台任务有新结果：{{user_message}}\n{{event_json}}',
  userMessage: '请检查并继续',
  event: { jobId: 'job-123', state: 'done' }
});
```

后台调用只能使用用户过去点击过你卡片、已与你建立关联的会话；每个插件同时只处理
一条 Agent 请求，后台请求之间至少间隔 10 秒。这个能力可能自动产生模型费用，只在
产品确实需要时申请，不要把 `sessionId` 当作任意跨会话控制口。

## 4.11.1 旧版任务接口:让 Agent 替你干活并取回结果(errand)

`agent.run` 用于用户已关联任务的交互；旧版 `errand` 接口提供结果查询适配：
任务在宿主按 sessionKey 关联的普通任务里运行,Agent 的最终回复文字交回**你**手里继续用。
需声明 `"agent": { "errand": true }`(插件详情高风险单列)。

```js
// 提交(默认异步:先拿单号,再轮询取件——Agent 干活是分钟级的):
const r = await cindy.agent.errand({
  task: '阅读工作目录下的 README 并总结要点(200 字以内)',
  // context: { anything: '结构化上下文,主机 JSON 化后附在任务消息尾部' },
  // title: '我的插件任务',   // 仅首次创建对应 errand 会话时用作标题
  // workingDir: repoDir,        // 可选:请求建在某目录(只认用户亲选过的,见下)
  // sessionKey: 'pr-123',       // 可选:分会话钥匙(1–64 位字母/数字/._-)。
  //                             // 不传 = 插件共用一间;同钥匙同间、异钥匙各间,
  //                             // 适合按业务对象各聊各的(如每条 PR 一间,标题
  //                             // 在该间首次创建时用 title 定,正好带上对象编号)
  // mode: 'wait',               // 同步等到完成(30 分钟顶);默认不传 = 异步
  // userActionToken: msg.userActionToken, // 卡片点击票；校验后切到 errand 任务，一次性
  callId: msg.callId,
});
// 受理:{ ok:true, jobId, status:'running', sessionId }
// 轮询取件(建议间隔 ≥5s;做成"提交 + 查询"两个工具让 AI 自己掌握节奏):
const q = await cindy.agent.queryErrand({ jobId: r.jobId });
// 进行中:{ ok:true, jobId, status:'running', sessionId, elapsedSeconds }
// 完成:  { ok:true, jobId, status:'done', sessionId, text, agentKind, model }
// 失败:  { ok:false, errorCode, message }
```

主机强制的边界(都不是建议):

- **任务只进普通 user 消息**,绝不进 system prompt;
- errand 会话在**侧边栏可见**,用户可随时旁观、叫停——errand 不支持隐藏;普通任务的
  后台隐藏只能经 §4.11.3 的 `hiddenTasks` 声明,且用户始终能在插件详情页查看与接手;
- 这是旧版任务接口，不是插件全部 AI 能力。普通任务管理用 §4.11.3，继续用户任务用 §4.11，
  快问快答用 §4.0.2；不要把这些能力统一称为代办。
- 新建任务共用插件详情「任务设置」中的模型组合（Agent、供应商、模型、推理强度、Fast）。
  没有覆盖时，沿用宿主核实的同插件本机在途 `callId` 所属任务；面板直接创建使用当前新任务选择。
  无显式覆盖的已有专属任务保留自身模型，用户在任务中改选后可继续复用。
  显式配置发生冲突时，新任务创建成功才替换映射，旧任务与历史保留。
- 保存、创建与派发前校验真实的模型／Agent／供应商组合；失效时引导用户到任务设置改选，
  或修复供应商连接。不静默换模型、不从报错猜凭证失效，也不把目录可用当作远端推理一定成功。
- 权限独立来自用户插件设置；旧接口缺省保留历史 plan 值及原 Agent 行为，不将它宣称为
  跨 Agent 的只读保证。新插件应使用普通任务接口，其缺省为普通任务的 ask 权限。
  用户可显式选择默认权限（ask）、自动审批（auto）或完全访问（bypassPermissions）；
  不继承调用任务的权限。工作目录由宿主分配。
- 目录有一个受控例外:run 请求可带 `workingDir`(绝对路径)**转述**一个目录,
  让 errand 会话建在项目里(Agent 能看到代码)。这不是授权——主机只认用户
  此前用 pick 能力(§4.14)在系统选目录窗口里**亲手选过**的目录(主机自己记的
  台账),别的路径一律 `INVALID_REQUEST`,此时应引导用户去你的设置页重新
  选一次目录;用户在「任务设置」卡里配置了目录时,以用户配置优先、本字段忽略;
- 每插件同时 1 单在途、相邻提交至少隔 10 秒;结果超过 64K 字符会截断(尾部带
  标记);完成结果保留 30 分钟,应用重启后查无此单(按可重新提交处理);
  `sessionKey` 只是分间,**不放大并发**——不同钥匙的两单同样要排队;
- 可选 `userActionToken`:把 `card-action` 里主机签发的点击票原样带上。
  主机校验通过才把这次派活当成用户发起并切到 errand 任务;票一次性消费,
  不能再拿去 `agent.run` 或再派一次。面板上的真实点击由主机自己记账,
  必须紧挨着这次派活,不能靠几分钟前点过输入框来顶替;
- `errorCode:'BUSY'` = 你已有一单在途,或用户恰好正在 errand 会话里说话;
  `'NO_CANDIDATE'` 不存在于此——但会话创建/派发失败有 `'SESSION_UNAVAILABLE'`,
  超时有 `'TIMEOUT'`(任务可能仍在会话里继续,提示用户打开会话查看)。
- 这个能力必然产生模型费用且耗时分钟级:能用快问快答(§4.0.2)解决的,不要派活。

## 4.11.2 请用户新建一条自动化(agent.schedule 加档)

**这是"让插件里的内容自己保持新鲜"的正路。** 你的插件自己跑不了业务逻辑——沙箱只在
被唤起时活着,也没有定时器。要做出「每小时帮我看一眼,有事就点亮插件入口」这种效果,
正确的分工是:

    插件不是执行者,而是**定时任务的目标**。执行者是 Cindy 的 AI。

完整回路(以「Codex 重置提醒」为例):

1. 用户在你的面板上点一个选项,比如「重置时间快到了提醒我」;
2. 你调 `cindy.agent.requestSchedule(...)`,请主机**打开预填好的新建自动化面板**;
3. 用户在面板上选个模型(或就用默认)→ **亲手点保存**。任务这才存在;
4. 到点了,Cindy 起一轮 AI 去干活:查本机重置时间、看 X 上的相关发帖、**判断**要不要
   提醒——这些判断是 AI 做的,不是你做的;
5. 那一轮 AI **调用你申报的 tool**(§3)把结果交给你,你在 tool 里更新自己的数据;
6. 你顺手发一个未读角标(§4.9.1),用户的插件入口和图标上就亮起点;
7. 用户回来点开面板,看到刷新后的内容。

所以你需要的是三样东西的组合:`agent.schedule` 加档(第 2 步)+ 一个 `tool`(第 5 步)
+ `badge` 能力(第 6 步)。三者缺一,回路就断在那里。

需声明至少一个 `tools` 条目、`"agent": { "schedule": true }`、`"badge": true`
以及 badge 所需的 `panel`(插件详情里单列一档,文案会告诉用户
"任务由你亲手保存、跑起来会产生模型费用")。

```js
// 用户在面板上点了「提醒我」之后:
const r = await cindy.agent.requestSchedule({
  name: 'Codex 重置提醒',            // 预填的自动化名称(≤60 字)
  prompt: [                          // 到点了让 AI 干什么——用自然语言写清楚,
    '检查本机 Codex 的限额重置时间。',  // 包含"什么情况下才值得提醒我"
    '再看一眼 X 上 @tobi 最近有没有相关发帖。',
    '如果重置时间在 2 小时内,调用 codex-reset-planner 插件的 update_status 工具',
    '把最新状态写回去;否则什么都不用做。',
  ].join('\n'),                      // (≤2000 字)
  intervalMs: 60 * 60 * 1000,        // 可选:建议每小时一次。**最小 30 分钟**,
                                     // 低于此值主机会自动上调
});
// { ok: true } = 请求已被接受并投递(**不保证面板真开了,更不代表用户存了**)
// { ok:false, errorCode:'PERMISSION_DENIED' | 'INVALID_REQUEST'
//            | 'RATE_LIMITED' | 'HOST_NOT_READY' | 'INTERNAL', message }
```

主机强制的边界(都不是建议):

- **你只能打开面板,不能创建任务。** 没有任何"直接建一条自动化"的接口——主机这一侧
  压根没接调度存储,不是"忍着不用"。用户不点保存,什么都不会发生;
- **本版没有回执。** `ok:true` 只表示请求被接受并投递给了主壳窗口:用户当时可能正开着
  另一个自动化表单在编辑,那种情况下本次草稿会被**丢弃**(保护他没保存的输入),他看到
  一句提示、面板不换内容。即使面板正常打开,任务也要他亲手点保存才落库。所以你的 UI
  **不要**显示"已开启"这类完成态,写"已为你打开创建面板,请确认"才准确;
  想确认用户是否照做了,当前唯一可信的信号是任务真的跑起来调了你的 tool。
  **后续版本会补上**:任务与发起插件的**绑定关系**,以及你查询 / 管理**自己绑定的那条
  任务**(是否有效、下次运行时间、频率,以及改时间 / 暂停 / 关掉)。届时你就能在自己面板
  上显示"已开启 · 每小时 · 下次 15:00"并让用户就地改。绑定本身即授权边界:你只能看和改
  自己请求创建的那条,看不到用户的其它自动化;
- `prompt` 里要**自己说清楚该调你哪个工具**(见上面示例第 3 行)。AI 不会自动猜到
  "跑完要更新哪个插件";
- 预填内容会**净化 + 截断**(去控制字符,名称 60 字 / prompt 2000 字);净化后为空一律
  `INVALID_REQUEST`;
- `intervalMs` 低于 **30 分钟**会被自动上调。这不是权限闸门(用户自己在面板上改成
  1 分钟是他的自由),是不让你预填出一个每分钟烧一次模型额度的任务;
- 同一插件两次请求至少隔 **15 秒**(`RATE_LIMITED`)。这个面板是打断式的——它会把
  用户从当前页带到自动化页,别拿它刷屏;
- 面板上会显示**是你在请求**(插件名由主机填,你伪装不了),用户永远知道在替谁保存;
- **面板会开在主窗口**,不是你的面板窗。用户把你的面板拉成独立窗口后点这个入口时,
  创建表单出现在主窗口里(独立面板窗挂的是轻壳,承载不了自动化页)——文案上别写
  "将在此处打开",写"去自动化页确认"之类更准;
- 一个都没有主窗口时(极端情况)→ `HOST_NOT_READY`。

什么时候**不该**用它:一次性的事，用快问快答(§4.0.2)或普通任务接口
(§4.11.3)。这个加档是给"长期定期刷新"用的,每条任务都会反复产生模型费用。

## 4.11.3 新建任务与继续任务（普通 Session）

先按业务选择：
- 当前 Agent 已在处理你的工具：返回数据让它继续，不新建任务。
- 用户在稿件面板提交修改：`cindy.agent.run({mode: 'continue', ...})` 继续已关联原任务。OpenDesign 当前采用这一方式。
- 独立完成一项工作：`cindy.tasks.create` 新建普通任务，再用 `send` 开始执行。保存 taskId 后可继续同一任务。
- 需要更新插件页面：查询 `getRun/listRuns` 与 `readMessages`；没有默认回叫，不自动唤醒伙伴或 Agent。

用户界面统一叫「新建任务」「打开任务」「继续任务」。任务能使用什么模型、工具和权限，由普通任务配置与用户授权决定。
插件身份／业务关联在调用方保存，不把普通任务做成另一种产品对象。伙伴的完成回叫只属于伙伴自己的流程。

声明 `"agent": { "tasks": true }` 后，逻辑页可使用 `cindy.tasks`。它是独立权限，
旧 `errand` 声明不自动取得该权限。任务默认可见：出现在任务列表，用户可查看和接手。
安装时已明确展示并确认的任务能力不重复询问；否则首次使用时通过现有宿主权限界面确认并记录独立批准。旧版保存的未知字段不会自动授权。
用户拒绝或确认界面不可用时返回 `PERMISSION_DENIED`，不影响插件其它功能；不得自动循环重试确认。
面板通过既有逻辑页通道调用，不获得新的 preload 或内部 IPC 权限。

插件需要向项目、已有任务或伙伴投递内容时，使用独立的 `cindy.targets`（仅本机 Desktop 逻辑页，需要同时声明并获批 `agent.tasks: true` 与独立的 `agent.targets: true`）。先检查 `typeof cindy.targets?.list === 'function'`；旧客户端没有此入口，不调用私有 IPC 或自动改投别处。Host 只提供查询、解析和投递；选择 UI、临时选择及固定目标配置由插件自己维护。独立权限 `agent:targets` 会在既有安装/更新确认中展示；旧 tasks 批准和历史未知字段不授予目标访问。缺新批准只阻止新接口，首次调用复用既有宿主确认，不影响旧插件能力。

- `list({targetKind:'project'|'task'|'bot'})`：返回 `{targets:[{kind,id,label,detail}]}`，只含本机可用目标的名称和目录/说明，不含消息历史。插件可自行搜索和展示列表，最近活动只用于排序。
- `resolve({target:{kind,id}})`：复核已保存或本次选择的目标，返回最新 `{kind,id,label,detail}`。只查询，不创建任务、不打开 UI、不保存绑定；固定目标失效返回 TARGET_UNAVAILABLE，不自动替换。插件可将 `{kind,id}` 存入自己的配置。project 的 id 是 Cindy 已有项目目录，task/bot 的 id 是任务/伙伴标识。
- `send({target:{kind,id},requestKey,text,context?,title?,autoTitle?,route?,permissionMode?,delivery?,attachments?})`：直接指定目标，Host 当次复核。project 在目录中新建普通任务，可传统一模型目录的 route 和已授权范围内的 permissionMode；task/bot 沿用接收方模型、权限、目录，不接受 route 或 permissionMode。`delivery` 为 `queue | steer`，缺省 queue；project 不接受 steer。steer 尝试同轮注入，不停止当前轮，空闲或插话暂不可用时入队。返回 `{taskId,accepted:true,delivery:"queue"|"steer"}` 表示实际接受路径，不表示执行完成。筛查拒绝返回 DELIVERY_REJECTED，不入队重试；ACK 未知返回 DELIVERY_UNCERTAIN，不得换键重发。不开放读取任意任务历史或改模。
- 同一次 send 重试沿用相同 requestKey、target、内容和 delivery（缺省与 queue 等价）；同键参数变化返回 REQUEST_KEY_CONFLICT。Host 在执行前持久保留投递回执，重启后已接受的请求返回原结果，未确定结果的请求返回 DELIVERY_UNCERTAIN，不再次创建或投递。普通投递回执不保存正文或附件字节；显式委派另保存下述有界执行范围。不要通过更换 requestKey 绕过未知结果，应先让用户在 Cindy 检查。
- `cancel({requestKey})`：使本次请求及迟到的发送失效，仅撤回本插件该请求尚未执行的输入；不会停止接收方其他输入，也不保证撤销已经开始的工作。新操作使用新的 requestKey。
- `tasks.send` 和 `targets.send` 均支持可选 `attachments:[{base64,name?}]`：只接收插件提供的图片字节，不接受本机路径、URL、媒体 URI 或自报 MIME。Host 检测 PNG/JPEG/WebP，最多 4 张、合计 20 MiB。先检查 `tasks.capabilities().messageAttachments.kinds` 包含 image；旧客户端不支持时停止，不静默丢图或改投临时路径。截图进既有 cindy-media，作为消息附件展示并进入模型输入；不需要额外声明 media.deposit。附件内容及名称参与幂等签名，更换附件不能复用同键。
- 所有插件的两种发送入口共用 40 MiB 在途附件额度；超额在解码和写回执前返回可重试的 `TASK_BUSY`。等待已有请求结束后沿用原 requestKey 重试，不自动改投或丢图。
- 目标只包含本机可见、可用的项目、普通任务或有唯一 canonical 对话的活跃伙伴；不提供 Mobile/device-link 透传。投递仍受当前插件启用、批准、账号和目标权限约束；插件内容不构成新真人授权。

调用统计由 Host 统一确认，不提供插件自报次数或定义计次规则的接口。独立的 `tasks.send` / `targets.send`
在输入被 Host 接受时记录一次；空任务创建、读取、附件处理、同键重试不额外计数。接受表示已派发或入队，
不是 Agent 完成工作；接受后取消不撤销已发生的记录。独立的 Host→插件工具派发继续按原规则记录。

`tasks.capabilities().invocationContext === true` 时，两种 send 均可附加 `invocationId`，
用于关联同一次工具调用内的宿主输入：将当前 `tool-call` 消息的 `callId` 原样转传。
Host 只接受同账号、同安装/批准及运行代次、尚未过期且已确认的身份，关联最长 10 分钟；
它不替代任何能力声明或执行授权。不传时视为独立输入，不按时间接近猜父子；存量插件无需更新也能调用，
但无法自动合并未关联的工具与输入。重试必须保留原关联及其它参数；错误或过期身份返回 `INVALID_INVOCATION`，
不要换键重发。关联不是插件生成的业务 ID，也不是设置计数增量的接口。

上述统计不覆盖插件自绘界面或自带原生程序的纯本地行为，也不要求插件迁移交互或重新授权。

### 正文、附带资料与自动标题（可选）

先检查 `tasks.capabilities().messageContext === true`。`tasks.send` 和 `targets.send` 可另外传
`context: string`，`text` 只放要在聊天中显示的指令。Host 保留完整资料并交给 Agent，
界面复用已有长文本胶囊，默认显示「附带资料」，点击可查看原文。截图仍走 `attachments`，
不要把截图路径或内部诊断重新拼进可见正文。context 是插件提供的参考资料，不是系统指令
或新的真人授权；原有来源标签和权限边界保持。context 最多 32768 个 UTF-16 字符，
text 与 context 合计不超过 64000；tasks.send 的 text 上限仍为 32768。
省略或传空 context 保持旧请求行为。同键重试必须携带相同资料；资料改变会触发既有幂等冲突，
不能换键绕过未知受理结果。回执仅保存摘要，资料随普通消息和队列保留，不另建资料存储。

`tasks.capabilities().autoTitle === true` 时，可用 `tasks.create({requestKey, autoTitle:true, route?})`
新建任务，省略 title；首次消息受理后，Host 复用普通任务自动命名。`targets.send` 仅在
`target.kind === 'project'` 时可传 `autoTitle:true` 并省略 title。生成期间先显示用户指令的简短占位，
随后结合指令和附带资料生成标题；不会覆盖人工重命名。autoTitle 与 title 互斥，task/bot
目标不接受 autoTitle:true，也不更改已有目标标题。

默认不传 autoTitle 的存量插件保持原有命名：tasks.create 仍须传 title；项目投递缺省采用
项目名称。新模式参与幂等摘要；旧字段组合的摘要及重放行为保持，不需要重新批准或配置。
旧 Host 未宣告支持时，应明确提示所需客户端能力，不能静默丢弃资料或假称已经自动命名。

### 新建任务的权限选择（可选）

先检查 `tasks.capabilities().createPermissionMode === true`。`tasks.create` 和 project 的
`targets.send` 可传 `permissionMode: 'ask' | 'auto' | 'bypassPermissions'`，对应默认权限、自动审批、完全访问。
参数仅决定新任务，不写插件默认配置；已有 task/bot 不接受该参数。

启用默认卡时保留权限上限：ask 允许 ask，auto 允许 ask/auto，bypassPermissions 允许三档；
超出返回 PERMISSION_DENIED，省略沿用设置。历史 plan/acceptEdits 保留，但不是新参数选项。
本插件声明 `showTaskPreferences:false` 时，其卡片配置完全无效，不作为上限；插件自行传参，未传为 ask。
包括完全访问在内均按插件参数执行，不增加独立权限上限或逐次宿主确认。
此选择不影响其它插件或全局设置。两类都须 Host 批准任务能力，并在创建、投递及排队接受时复核归属和 Session/Plan。
既有 requestWriteAccess 仅支持 acceptEdits/auto；启用卡片保留原写回规则，隐藏时只改目标 Session。
不接受自报 confirmed。权限参与幂等摘要，同键修改返回冲突；缺省旧请求可重放，旧 Host 未声明支持时不发新参数。

原有 `cindy.tasks` 的归属限制不变。先调用 `capabilities()` 获取实际支持操作。当前仅支持本插件创建的本机普通任务：
`models`、`create`、`get`、`setModel`、`list`、`send`、`getRun`、`listRuns`、`readMessages`、`cancel`、`setHidden`、`archive`。
`archive({taskId})` 归档自有的空闲任务（忙时 `TASK_BUSY`），用户可恢复，没有删除接口；按视频等开新任务的插件，切换时归档上一条。
可对自有任务调用 `startTeam({taskId})` 启用 Orca 主任务，并用 `getTeam({taskId})` 读取实际协同状态。通过此插件 API 启用团队需经用户授权 Auto；开启团队不创建 Worker，也不改写全局 Worker 权限偏好，后续 Worker 使用普通 Orca 创建权限流程。
插件直接调用的 `cindy.tasks` 仍只能管理本插件创建的任务；这些任务及其 Worker 中的 Agent 则按普通任务权限使用 `cindy_helper`、`cindy_memory` 等已连接工具，包括账号级历史、跨任务操作和个人插件投稿。协调仍可使用独立 Orca 工具，插件通过 `readMessages/getTeam` 读取自己的结果。任务创建来源不参与 Agent 工具授权；插件消息标签不额外收窄任务权限，原本要求用户当场输入的操作仍按通用规则判断。卸载撤销归属后，插件不能继续管理旧任务；保留任务中的 Agent 仍按任务权限工作。撤销不保证停止已接受执行，也不构成通用执行沙箱。
若插件需要记录批次，可在首次派发前调用 `setTeamPlan({taskId,plan:{concurrency,task,items}})`；每项包含 `label, workingDir, route, task`。`task` 是插件自己的说明，不是用户原话，也不会改变 Agent 的 Auto 审阅或工具权限。计划登记后不可改写。`releaseWorker({taskId,workerId,completedAt})` 按 Worker ID 和成功完成凭据归档自有团队中的空闲 Worker，改名不影响释放；插件按 Worker ID 保存自己的结果和批次进度。没有计划的任务及 Worker 照常使用普通任务权限。

插件直接调用 `cindy.tasks` 时仍需当前插件批准和自有任务归属。Agent 使用公共 Orca 工具创建、调度或管理 Worker 时，按普通任务的账号、权限档、团队成员关系和操作凭证检查；任务创建来源、插件输入标签、插件计划与卸载状态不额外设限。Worker 目录、模型和运行位置沿普通 Orca 规则，目录不是持续的 OS 隔离保证。

`models()` 返回统一目录可选项的完整 route、efforts 和 supportsFastMode。用户明确选择后将 route 原样传给 create，或用 `setModel({taskId, expectedRevision, route})` 修改已有自有任务。运行中按普通任务的安全边界切换，不修改应用默认。两方法使用前检查 capabilities.operations。
当 `capabilities().pluginDefaultModel === true` 时，持续复用任务的插件可在每次新输入前调用
`setModel({taskId, expectedRevision, route:'plugin-default'})`。Host 当次读取本插件有效的任务模型设置（隐藏卡片时忽略旧值），
复用 create 的模型解析规则（未指定时跟随系统辅助模型，优先 Pi 引擎与较低推理强度，最后才是当前新任务选择），只同步模型、来源、引擎、强度和 Fast，
不改权限、目录或其它任务。返回 `{status,task}`；配置相同返回 unchanged，不反复切换。
后续 send 使用返回 task.revision。须先处理已接受/结果不确定的旧请求，再同步下一次输入，
不得修改旧请求的回执或为模型变化重发。旧 Host 未声明此能力时保留原任务行为，不传入该 route。
暂不支持接管任意现有任务、远程/伙伴任务、其它配置修改、归档、队列暂停或事件订阅。
旧 `agent.errand` 接口不变。

**后台任务（可选，需声明 `hiddenTasks`）**。任务默认可见。只有身份卡写了
`"agent": { "tasks": true, "hiddenTasks": true }`（详情页与安装/更新确认中单列一项权限），
插件才能把**自己创建的**任务放到后台：不进任务列表、会话搜索、未结束提示、新任务通知与灵动岛，
手机任务列表同样不显示。它不改变任务权限、模型或执行方式，也不扩大插件直接调用 `cindy.tasks` 的任务范围。
未声明时 `create({hidden:true})` 与 `setHidden` 返回 `PERMISSION_DENIED`；
`capabilities().hiddenTasks` 表示当前插件是否已声明。用户始终可以在插件详情页「后台任务」
看到这些任务、打开查看，或「显示到任务列表」接手；插件被卸载时它们会自动恢复显示。
请把后台任务用于用户不需要逐条关注的批量/辅助工作，并在插件界面说明它们在哪里能找到。

```js
const caps = await cindy.tasks.capabilities();
const bg = await cindy.tasks.create({ requestKey: 'grade-42-create', title: '批改第 42 份作答',
  hidden: caps.hiddenTasks === true });   // 未声明时退回默认的可见任务
// bg.hidden === true；get/list 快照都带 hidden 布尔值。hidden 参与 requestKey 的幂等摘要。
await cindy.tasks.send({ taskId: bg.taskId, expectedRevision: bg.revision,
  requestKey: 'grade-42-send', text: '按评分标准批改并给出分数。' });
// 出现需要用户处理的问题时，把它显示到任务列表（与用户在详情页点击效果相同）：
await cindy.tasks.setHidden({ taskId: bg.taskId, hidden: false });
```

```js
// requestWriteAccess({taskId, mode: 'auto'}) 请求宿主原生确认，不能替用户确认。
// 拒绝或失败后，同一账号代际/安装修订/任务在当前宿主进程不再自动弹窗（更换 mode 也不重置）。
// 用户可从本机任务权限菜单“重新确认插件写权限”恢复原请求；插件不能清除拒绝记录。
// 省略 mode 保留 acceptEdits；通过 cindy.tasks.startTeam 创建的 Worker 使用 Auto，不改全局权限。

const task = await cindy.tasks.create({ requestKey: 'experiment-1-create', title: 'My evaluation' });
const run = await cindy.tasks.send({ taskId: task.taskId, expectedRevision: task.revision,
  requestKey: 'experiment-1-send', text: 'Read the project and report your findings.' });
const status = await cindy.tasks.getRun({ runId: run.runId });
const page = await cindy.tasks.readMessages({ taskId: task.taskId, limit: 50 });
// 保存 nextCursor；下一页传 after，不以最后一条 assistant 推断 run 已完成。
```

SDK 成功返回 data，失败抛出带 code 的错误。原始管子响应为 `{ok:true,data}` 或
`{ok:false,error:{code,message,retryable}}`。不要将请求键换掉来绕过不确定的派发结果。
create/send 的 requestKey 持久去重；同键不同内容拒绝。删除后的记录不自动重建。
请求键及 taskId/runId 需要由插件保存。取消仅作用于该输入，不能停止用户后来的执行。

省略 route 时使用用户给本插件的任务模型覆盖；无覆盖则沿用发起任务，面板直接创建时
沿用当前新任务选择。可显式传
`{agentKind:'codex',providerId:'...',model:'...',effort:'high',fastMode:false}`；无推理档位模型用空 effort。
先查 `capabilities().sourceCallContext`：支持时，Agent 在途调用可在 create 中转传 `callId`。
宿主核对同插件本机调用后读取其模型；不能自报 sourceSessionId 或权限授权。面板直接创建省略 callId。
新字段需该能力为 true 才发送，旧客户端不能假定支持；同 requestKey 的重放保留原创建结果。
来源/模型/强度必须当前可用，派发前再次核对；失败引导改选或修复连接，不自动换模型或账号。
已有普通任务保留自身配置，用户在任务内修复后继续使用原任务。
工作目录由宿主分配，或沿用已启用卡片中的配置目录；不接受任意路径。
启用卡片时权限上限来自该插件设置，可在范围内选择本次权限；隐藏时不读卡片，由插件创建参数决定。
省略参数沿用有效设置，缺省 ask。工作区行为及询问规则与所选 Agent 的普通任务一致，
不继承发起任务的权限。既有任务与显式历史 plan/acceptEdits 配置保留原行为，不自动提权；需要改变时由用户选择。
create 可传 `isolatedWorkspace:true`，使用宿主为该任务生成的独立空目录，忽略插件的项目目录偏好。
返回 workingDir 仅属于本插件创建的任务，可交给插件 Node 进程放入候选项目；不接受插件自报任意目录。
任务视图同时返回 permissionMode；按实际权限展示，不将历史 plan 值视作跨 Agent 的只读保证，不能暗中升级权限。

run 的 acceptedConfig 是接收配置，execution 是观测到的原生 instance/generation，
不冒充完整实际用量/重试清单。outputMessageId 来自产品终态，不是文字猜测。
没有足够证据的重启/恢复窗口返回 reconciling，不能当 completed、failed 或零分；
不要自动重发可能已经产生副作用的输入。费用目前 unavailable，绝不以耗时推算。
实验性接口尚未提供全部恢复路径的最终对账和事件补拉，因此暂不用于无人值守正式评测。


## 4.11.7 伙伴委派协议与回执（未发布）

此增量在插件系统实现，不创建普通任务代替伙伴，不更改伙伴身份、模型、目录或权限档。
插件声明 `agent: { tasks: true, targets: true, delegation: true }`；`agent:delegation`
为独立权限，需 Host 显式批准。既有 tasks/targets 批准和历史未知字段不授予委派执行。
存量插件、凭证、设置和普通消息投递不受影响。

先检查 `typeof cindy.targets?.capabilities === 'function'`，再调用 `await cindy.targets.capabilities({})`。
返回 `{delegation:{version:1,execution:boolean,targetKinds:['bot'],delivery:['queue']}}`。
version 只表示本 Host 理解协议；execution 才表示审核接线可用，不表示该插件已获批准。
审核接线安装完成后 execution 为 true；缺少接线时显式委派返回 UNSUPPORTED_CAPABILITY，且不会预留回执或投递。
旧 Host 缺少入口或返回 INVALID_PARAMS 时停止，不去掉 delegation 重发或改用 tasks.create。

审核接线可用时，通过原 `targets.send` 增加 `delegation:{task:string}`。
只支持 bot + queue，task 为非空、最多 8000 字符、不含 NUL 的执行范围；不接受其它委派字段。
插件应写明目标及允许的结果交付，外部业务正文仍为输入数据；该字段不成为主人原话。
Host 沿用投递回执，持久化版本 1 的范围、插件实例、目标伙伴/Session、requestKey 与批准版本。
范围参与幂等摘要：同键变更范围或去掉范围返回 REQUEST_KEY_CONFLICT；未知结果不得换键重投。
取消保留原请求身份，不恢复已取消回执；撤权、换安装版本或审核接线失效后拒绝排队派发。
审核消费者核对当前已接受输入、持久回执、原伙伴关联、安装批准与主人指令投影。输入切换、插话、重试、撤权或更换账号后不会借用旧回执。sourcePlugin 只是来源标签，不授予权限。
Auto 使用回执的任务范围并保留主人的限制；Ask、Full Access 沿用原权限档，插件不能提升伙伴权限。
`targets.cancel` 仍不停止伙伴。仅当 Host 已撤回原输入、当前无运行工作且无残留队列时，可额外返回
`{settled:true,requestKey,clientId}`。缺少 settled 或请求不匹配时不得解除未确认的执行占位；旧 Host 的回执行为不变。
执行能力声明及单元测试通过不代表某个业务插件已通过真实端到端验收。

### 委派收据查询（未发布）

先检查 targets.capabilities().delegation 的 execution、receiptQuery 和 settled 均为 true。
显式 delegation 的 send 成功响应新增 executionId、requestKey、target；同键同内容仍返回原收据。
targets.get({requestKey}) 只读本插件原收据，未知键返回 {found:false}；已知键返回
{found:true,executionId,requestKey,target,taskId,status,delivery,settled,result?}。
status 是 pending/accepted/cancelled 投递状态，不能当作任务完成；result 含原输入的
instanceId、generation、outcome（completed/failed/cancelled/interrupted）及可选 outputMessageId。
自然终态持久记录，重启后仍可查询；崩溃而没有终态证据时 settled=false，不自动重发。
恢复尚未结束时保持 settled=false；恢复最终失败后记录原输入的 failed 终态，即使运行时已重建也保留原 instanceId/generation，不结算后来排队的请求。
取消只撤回该插件输入，只有原队列和执行确已结束时 settled=true。不读取伙伴历史。
