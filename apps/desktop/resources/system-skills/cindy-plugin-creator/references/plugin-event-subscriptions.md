## 4.6 订阅:旁听事件 + 钩子处理消息(subscribe 能力)

一种事件模型,两个类型:
- **监听(`did-`)** = 纯数据通知,事后告诉你发生了什么,你改变不了流程——适合做
  统计面板、成本记账、工作流水、"跟随用户正在看的会话"联动等纯观察型能力;
- **钩子(`will-`)** = 主机在对话流的关键点**停下来把数据交给你,做完再继续**。
  裁决窗口内你可以做**任何**你权限内的事(经 network 调自己的服务、经 cindy
  请主机代办、任意本地计算、跨会话攒状态),最后用一个收敛动作收尾。两个钩点,
  一进一出:
  - `will-user-message`(入口):用户消息发给 AI **之前**交到你手上,动作
    allow/block/rewrite——改写不限于"优化提示词":翻译、脱敏、拼接你的知识库
    上下文、加路由标记,任何文本变换都行;block 则是前置合规/安全审;
  - `will-assistant-message`(出口):AI 回复完成后交到你手上,动作
    allow/rewrite/**render**——rewrite 同样是任意变换(后置合规改写、双语对照、
    补充署名…),render 则是**基于结果重新绘制呈现**,卡片形态与原文无关
    (图表、评分卡、警告卡、摘要卡都行)——见 §4.6.1。
  纯副作用场景(审计留痕、上报你自己的系统、记账)两头都支持:干完活回 allow
  即可,对话零感知。

主机经管子把事件下发到你的电子脑 `onHostMessage`;钩子还要你回一条 `event-verdict`。
声明:

```json
"subscribe": {
  "topics": ["turn", "session", "activity"],           // did- 旁听(元数据,不含消息内容)
  "hooks": ["will-user-message", "will-assistant-message"]  // will- 拦截(声明任一必须 launch:"resident")
},
"launch": "resident"               // 拦截要求常驻在场(否则每条消息都等你冷启动)
```

```js
cindy.onHostMessage(function (msg) {
  if (msg.type !== 'event') return;
  // ── did- 旁听:收到就收到,主机不等你,你也改变不了任何事 ──
  if (msg.name === 'did-turn-end') {
    // msg.data = { sessionId, agent, model?, durationMs, endReason, usage? }
    // usage 各字段可选(各引擎上报详尽度不同,别假设字段必在):
    //   { inputTokens?, outputTokens?, cacheReadTokens?, cacheCreationTokens? }
    // error 终态也可带已消耗的 usage；Pi 输出上限会保留它，不要只统计 completed。
    // msg.seq 每个插件单调递增;msg.dropped(可选)= 你熄灯期溢出丢弃的事件数。
    // 生命周期:会话被关掉或引擎被替换时,主机会给还在场的那一轮补发
    // endReason: 'interrupted',让 start/end 成对。但这不是投递保证——熄灯期
    // 缓冲溢出照样会丢(见 msg.dropped),状态机别只靠 end 归位。
    return;
  }
  // did-turn-start / did-session-created / did-session-archived 同理(见 topics)。
  // activity topic 只提供内层活动边界元数据:
  // did-thinking-{start,end}: { sessionId, blockId }(不含 reasoning 正文);
  // did-approval-{start,end}: { sessionId, requestId };
  // did-user-input-{start,end}: { sessionId, requestId }。
  // approval = permission / plan_review; user-input = ask_user_question。
  // **blockId / requestId 都是主机生成的不透明配对键**,不是 agent 或 provider 侧的
  // 原始 id:只保证同一段思考 / 同一个请求的 start 与 end 拿到同一个值,同一个上游
  // 请求在不同会话里也是不同值。它们不承载任何语义(看不出是哪个工具、哪个 MCP
  // 服务、是不是计划审批),也**关联不到**主机或 provider 的任何其他标识 —— 别拿它
  // 去和你从别处拿到的 id 对齐,只用来配对。
  // **按 requestId 配对,不是全局开关**:一轮里并行工具调用可能同时挂着多个审批,
  // 每个 requestId 各发自己的 start / end。要判断"是否仍在等审批",用 requestId
  // 集合(收到 start 加入、end 移除),集合非空即仍在等;别用单个布尔位,否则先结束
  // 的那个请求会把还在等的抹掉。
  // **审批可能跨过 did-turn-end**:codex 计划模式的 plan_review 就是在计划轮次
  // 收尾之后才发起的,你会先收到 did-turn-end、再收到 did-approval-start。所以
  // 别拿 did-turn-end 去清空审批状态——只认对应 requestId 的 did-approval-end。
  // thinking 不同:它只在轮次内,did-turn-end 前主机必定先补发未收口的
  // did-thinking-end。审批 / 等待输入则由主机在真实决策落地(批准、拒绝、回答、
  // 超时、取消)时收口,会话被关闭 / 重建时也会给所有在场 requestId 各补一条 end。
  if (msg.name === 'did-session-switched') {
    // 用户把某个会话切到台前(切换会话 / 从非会话页切回都算)。
    // msg.data = { sessionId, workdir? }。连续停留同一会话不重发。
    // 典型用法:面板按"用户正在看的会话"聚焦展示该会话的数据。
    return;
  }

  // ── will-user-message 钩子:3 秒内必须回裁决,否则主机按放行处理 ──
  // 语义 = "主机停下来交给你做,做完继续":你可以在这窗口里做任何事(记账、
  // 经 network 过合规接口…),然后用三种动作之一收尾:
  if (msg.name === 'will-user-message') {
    // msg.data = { sessionId, text, model? };新 turn 时 model 是本轮已选模型 id,
    // 同轮插话(steer)时是当前运行中 turn 的模型 id。
    // msg.hookId 原样带回。
    if (/(内部代号|密钥)/.test(msg.data.text)) {
      // ① block:打回,不继续(reason 展示在被拦气泡上)。
      cindy.send({ type:'event-verdict', hookId: msg.hookId, action:'block', reason:'疑似包含敏感信息' });
    } else if (msg.data.text.indexOf('润色') === 0) {
      // ② rewrite:改写正文再继续(提示词优化 / 合规改写)。text 替换即将
      //    落库/显示/交给 agent 的正文;v1 静默替换(气泡直接显示改写版,无标记)。
      cindy.send({ type:'event-verdict', hookId: msg.hookId, action:'rewrite',
                   text: '请结构化回答:' + msg.data.text.slice(2) });
    } else {
      // ③ allow:原样继续(纯副作用的钩子也走这条:记完账放行)。
      cindy.send({ type:'event-verdict', hookId: msg.hookId, action:'allow' });
    }
  }
});
```

硬规则(主机代码强制):
- **旁听 topic**:`turn`(轮次开始/结束,带 agent / 模型 / 耗时 / token 用量)、
  `session`(会话创建 / 归档 / 切换——切换 = 用户把哪个会话切到台前,连续停留
  同一会话不重发)、`activity`(思考 / 审批 / 等待用户输入的开始结束边界)。
  activity 只带 `sessionId` + `blockId` 或 `requestId`;**不会给 reasoning、工具
  input、命令、文件内容、计划正文、问题内容或答案**。旧插件不声明 activity 时行为
  完全不变;没声明的 topic 主机不投;
- **只覆盖你自己的主会话**:orca worker、后台自动化会话不投(与你无关的噪音)。
  粒度到**轮次**:主会话里由 `/goal` 自动续跑、定时任务、hook 渠道发起的轮次不投,
  **连它们触发的审批与提问也不投**。
  已知例外:飞书 / Slack 等渠道**接管**(attached)现有主会话代发的轮次,其
  `did-turn-*` 与 thinking 边界仍会投给你(该轮次在主机侧没打来源标记,这是
  `turn` topic 的既有行为,不是 activity 引入的);它触发的审批与提问**不会**投
  (走渠道卡的确认面,主机按面拦掉)。所以:`did-approval-*` /
  `did-user-input-*` 一定是用户本人在 Desktop 上被问到,不会出现没有对应轮次的
  孤儿审批;但 `did-turn-*` / `did-thinking-*` 偶尔可能来自渠道代发的轮次,别把
  "有 thinking"直接等同于"用户本人正在用 Desktop";
- **旁听是 fire-and-forget**:主机投完即走,你崩了/慢了不影响任何会话;熄灯期事件
  进队列(上限 100,溢出丢最旧,下一条带 `dropped` 计数),事件到达会把你按需
  拉起补投——但订阅型插件**建议 `launch:"resident"`**(要秒收就得在场)。
  **`dropped` 非零就必须重置你本地派生的状态**:被丢的可能正是某条
  `did-turn-end` 或 `did-*-end`,你要是继续拿旧状态往下推,就会永久停在
  "在忙 / 在等审批"。收到 `dropped` 时把状态清空、以此后到达的事件为准;
- **钩子超时 = 放行**:`will-` 裁决必须 3 秒内回,超时主机按 allow 放行(聊天绝不
  因你卡死);连续 3 次超时/崩溃,主机**熔断**你的钩子能力(降级为只旁听 + 提示
  用户),旁听不受影响。要过外部合规接口就在窗口内 `await cindy.fetch`(network),
  但整段必须 3 秒内出裁决;
- **三种动作**:`allow`(原样继续)/ `block`(打回,reason ≤200 字符,显示在被拦
  气泡)/ `rewrite`(改写正文再继续,`text` ≤16000 字符替换即将落库/显示/交给
  agent 的正文)。多个钩子插件按装入序串行,**链式变换**(前一个改写的输出是后
  一个的输入),任一 block 即短路;
- **block 的呈现**:消息发不出去(不落库不起 turn),气泡照常显示,其下渲一条
  **error 红条,内容 = 你返回的 reason 原文**(主机直接显示,不加框不署名——所以
  reason 写成一句完整的话)。用户用消息的编辑铅笔改了重发(改干净了自然通过,
  没改就再次被拦);**没有"强制发送"**,拦截就是发不出去;
- **rewrite 静默替换**:气泡直接显示改写后的正文(与交给 AI 的一致),**无标记、
  无弹窗**;空改写 / 改写等于原文一律被忽略;
- **UI 全主机画**:红条、气泡都由主机绘制,你只提供 reason / text 文本,伪装不了、
  也冒充不了别的插件;
- **钩子作用于发给 Agent 的用户消息**:即将启动新 turn 的消息和运行中 turn 里的
  用户插话(steer)都经同一道钩子。新 turn 的 `model` 是本轮已选模型,steer 的
  `model` 是当前运行中 turn 的模型;拦下新 turn = turn 不启动,拦下 steer = 不注入
  当前 turn;
- **没有绕过通道(v1)**:被拦消息用户只能编辑后重发,重发仍会经你再审。即便
  如此也别把拦截当硬性管控设计(插件是工具不是管理员):reason 要引导用户怎么
  改,而不是单纯说不;
- **权限最重**:声明 hooks 在插件详情里是最重的一条(「可读取、拦截或改写你
  发出的消息」),用户会看得很清楚,只在真需要时申请。
