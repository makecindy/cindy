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
