## 4.6.1 出口钩子 will-assistant-message(对 AI 回复做任意后处理)

AI 每轮回复完成后,主机把**全文**交给你——这是一个**通用后处理点,不限定用途**:
只做副作用(审计留痕 / 上报你的系统 / 记账)然后放行;任意变换正文(合规改写 /
翻译双语 / 脱敏 / 补充引用);或**基于结果重新绘制呈现**——卡片形态与原文无关,
回复里有数据就画图表卡、有结论就画评分卡、命中风险就画警告卡,全凭你的场景想象。
机制是**"先定案 → 一拍后替换"**:AI 回复照常流式显示、正常落库(和没你时一样);
你的处理在**后台独立进行**(不阻塞用户发下一条),处理完再原地更新那条消息。所以——

- **超时给足 5 分钟**(不同于入口钩子的 3 秒):它是后台后置钩,你可以从容跑外部
  接口、自己的 LLM、甚至请主机出图;超时/崩溃一律 fail-open(用 AI 原文定案,
  **绝不丢回复**),连续失败照样熔断降级只旁听;
- **动作 allow / rewrite / render**(**无 block**——AI 已生成,拦无意义)。下例以
  "调自己的服务改写"为演示,替换成你的任何处理逻辑都成立:

```js
cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'event' || msg.name !== 'will-assistant-message') return;
  // msg.data = { sessionId, text = 本轮 AI 回复全文, model? };
  // model 是生成本轮回复的模型 id;msg.hookId 原样带回。
  const polished = await cindy.fetch({ url: 'https://api.example.com/polish', method: 'POST',
                                       body: JSON.stringify({ text: msg.data.text }) });
  // ① rewrite:用改写正文替换回复(静默换文本,≤16000 字符)。
  cindy.send({ type:'event-verdict', hookId: msg.hookId, action:'rewrite', text: polished.body });
  // ② 或 render:自绘卡片替换气泡(html 规则同 §4.5 card 能力:纯 HTML+CSS、零脚本、
  //    图片仅本插件 cindy-media 地址;height 初始估计;主机净化 + clamp)。
  // cindy.send({ type:'event-verdict', hookId: msg.hookId, action:'render',
  //              html: '<div style="padding:12px">…</div>', height: 200 });
  // ③ 或 allow:原样定案(记完账放行)。
  // cindy.send({ type:'event-verdict', hookId: msg.hookId, action:'allow' });
});
```

硬规则:
- **render 的 html 与 card 能力(§4.5)同一套净化**:纯 HTML+CSS、零脚本、图片只认你
  名下的 `cindy-media://` 地址、体积/height 同限、可用主机主题 `var(--xxx)`;不合规
  被净化器拒则回退原文;
- **原文始终保留("查看原文")**:render 时 AI 原文仍落库,主机在卡片旁画一个
  "查看原文"切换——你**盖不住** AI 实际说了什么(信任边界,与整个插件系统一致);
- **多个出口钩子插件**按装入序**串行链式**:rewrite 叠加(前一个改写的输出是后一个
  的输入),**render 最后一个胜出**;
- **处理期间那条消息挂"插件处理中"轻指示**(主机画),完成/超时清掉;
- **权限档**:声明 `will-assistant-message` 在插件详情里单列一条(「可读取并重写
  AI 的回复」),比入口钩子更敏感(能看到 AI 完整输出),只在真需要时申请。

## 4.6.2 Harness 原生能力桥（独立 harness 声明）

将 Cindy 插件接到获准关联的用户主任务，复用 Claude Code、Codex、Pi 的执行。与旧 subscribe、agent-request、插件工具和面板协议并存；原生扩展继续沿原生路径使用。
清单片段：`"harness":{"read":["runtime","usage","messages","tool-content"],"events":["tool","message","usage","compaction","task","status"],"hooks":["permission.request","tool.before","compaction.before"],"actions":["context.compact","turn.interrupt"]},"launch":"resident"`。
每个名称独立批准。hooks 必须 resident；未知声明保留但不授权。接口有定义不代表当前 adapter 已接通，先查 runtime。
本桥只开放三种 Harness 已有且语义共有的能力；可以新增插件转发与权限校验，不新增原生能力、不改写原生行为，也不另建压缩调度流程。预留名称不代表已开放。

- `await cindy.harness({kind:'read',name:'runtime',sessionId})` 返回 `{ok:true,sessionId,runtimeId,turnGeneration,agent,value}`。value.capabilityStates 分别报告声明、批准与接通；hookSubscriptions 另报 disabled / not-ready / fused / not-running / ready。版本无运行证据时为 null。
- read 的 usage 为数值用量、上下文占用及已观察缓存统计，status 为 running。详细模型请求、压缩配置/阈值和未来缓存保证不在本接口中。
- read 的 messages / tool-content 分别读取普通消息文本、工具参数和结果；必须分别声明和批准。可传 limit（1–50，默认 25）、cursor 和 runtimeId；返回 value={items,nextCursor,source:'saved-history'}。正文单项上限 16384 字符，非文本或大内容省略时标 truncated；不包含 agentMeta、固定指令、隐藏推理或签名。历史发生任意数据库写入时旧 cursor 可能失效（STALE_RUNTIME），重新读取，不把不同修订的页直接拼接。已保存历史不是完整原生日志。
- `onHostMessage` 收 `type:'harness-event'`（topic/name/seq/ts/dropped/data）。新增 message.updated 是助手文本增量/快照，isFullText/isFinal 保留原始标记；用户消息从历史读取或已有消息 hook 获取。tool=started/completed，usage=updated，compaction=boundary，task/status=updated。正文仅在 messages 或 tool-content 另行获准后出现；仅订阅不会取得正文。seq 与旧 did-* 共享，队列有界且可丢，不是原始日志 ID。任务、执行起止与等待输入/审批仍复用 subscribe 的 session/turn/activity。
- `type:'harness-hook'` 带 name/hookId/deadline/data。用 `cindy.send({type:'harness-verdict',hookId:msg.hookId,action:'continue'})` 或 block 回执。continue 继续既有守门，不增加授权；多插件共用 1.5 秒预算，超时回到正常策略。正文需额外工具内容权限，block 不将插件自定义文字写入模型。
- `cindy.harness({kind:'hook',name,sessionId,runtimeId,enabled:false})` 取消当前实例的处理，enabled:true 恢复。声明和批准不变；实例替换后覆盖项失效。permission.request 接宿主审批；tool.before / compaction.before 转发三种引擎的原生前置 Hook，仅本机普通主任务接入。Codex 0.159.2 使用原生 mcp_tool handler 复用现有连接，必须先有已启用且获原生信任的配置；Cindy 不自动改配置或授予信任。原生关闭、未配置/信任或回调不可达时返回 UNAVAILABLE，先查 runtime 的实际连接状态。内部 harness_hook 不是供模型或插件直接调用的工具。
- `cindy.harness({kind:'action',name:'turn.interrupt',sessionId,runtimeId,turnGeneration,requestId})` 请求中断；name:'context.compact' 转发原生手动压缩：Claude /compact、Codex 0.159.2 thread/compact/start、Pi compact RPC，不新增摘要算法或后台调度。两个标识来自最新 runtime，requestId 必须为本次操作生成。同实例同 ID 不重复执行。压缩忙时返回 BUSY，并沿用原生手动压缩的等待语义，不保证后台并行。中断返回 requested 不代表已经停止，应观察终态。最多等待 10 秒；TIMEOUT/outcome:'unknown' 时不能自动重发或换 ID 重试。
- 控制请求在宿主同时校验身份、批准、任务/实例/执行代次，卸载或换账号后旧读取、投递和回执失效。后台压缩 prepare/adopt 尚未接通，nativeEnabled/nativeRunning=unknown 不能当作原生关闭。当前范围不扩至 IM、自动化、Worker 或另一台电脑的 Agent。
