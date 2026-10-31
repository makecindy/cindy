## 4.5 聊天卡片(card 能力,海报模式)

**怎么选**：简单结果和固定按钮用本节聊天卡；表单、图表和连续操作用
[交互页面 §4.23](plugin-interactive-pages.md)。

声明 `"card": {}` 即可。作用:你的工具调用在聊天流里
不再渲染成通用图卡,而是你自己排版的卡片(过程 + 结果都归你画)。不发供片 =
聊天照旧渲染默认卡,卡片是**每次调用的可选项**。

```js
cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'tool-call') return;
  // ① 收到活立刻供第一版过程卡(卡片这一刻才出现在聊天里;不供 = 没有过程态):
  cindy.send({ type: 'card-update', callId: msg.callId,
               html: '<div style="padding:12px">正在起草…</div>', height: 160 });
  // ② 干活;执行中可整版换海报(同一 callId 重发,主机限速 ≥1s/版,超发静默丢):
  const r = await cindy.send({ type: 'cindy-request', kind: 'gen_image', prompt: msg.args.prompt, callId: msg.callId });
  // ③ 交卷**前**发最终版(交卷后 10 秒宽限,过期拒收):
  cindy.send({ type: 'card-update', callId: msg.callId,
               html: '<figure style="margin:0"><img src="' + r.url + '" style="width:100%;border-radius:8px"><figcaption>' + msg.args.prompt + '</figcaption></figure>',
               height: 340 });
  // ④ 交卷(result 必须是 JSON 对象,否则卡片配不上对):
  cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: { note: '完成' } });
});
```

硬规则(主机代码强制,写了也没用的别写):
- **纯 HTML+CSS,零脚本**:`<script>`/事件属性/iframe/svg 等一律被主机
  净化器剥除或连内容丢弃;可用标签为 div/span/p/h1-h4/ul/ol/li/img/figure/table/
  pre/code/style/a 等排版件;
- **动画可以写,但只许动 transform / opacity**(`@keyframes` 体内出现其它属性 =
  整卡动画作废,回退主机统一扫光)。动画只在该次调用 running 期间生效——
  交卷后主机自动换成剥掉动画的静态版,历史卡永远静止,你不用(也无法)
  自己收动画。适合做进度态的摆动/呼吸/扫掠;`transition` 不受此限;
  另外两条同样触发"动画作废回退扫光":CSS 里写 `!important`、keyframes
  里(名字或体内)出现引号;CSS 用反斜杠转义(`\61` 这类 ident 转义)则
  更重——该段样式整段拒收,静态版同罚。用户系统开了「减弱动效」时你的
  动画会被主机强制停播——属预期,别当 bug 修;
- **图片只认你名下的 `cindy-media://blobs/<指纹>.<后缀>`**(cindy-request 返回的
  url 直接用;别人的图/外链/data: 一律被剥)。CSS 里的 `url()` 同规则;
- **可放交互按钮**(交互卡 v2):卡里可写 `<button data-ghost-action="<动作id>">U1</button>`
  (`data-ghost-action` 也可挂在 div/span/img 上,把整块当按钮)。用户点击时主机受信桥把
  `{type:'event', name:'card-action', callId, actionId, sessionId, userActionToken}` 回传你的电子脑(见下方 onHostMessage
  分支),你据此干活(如调你自己的工具)再 `card-update` 换新卡。**仍零脚本**——按钮只是
  声明,点击链路由主机独占,你写不了 onclick、也伪造不了点击。动作 id 限
  `[A-Za-z0-9_:-]` ≤128 字符(含 `:`,可直接用第三方 customId);不合法的值主机只丢该属性
  (按钮还在但点不动)。发交互卡时把 `card-update` 的 `v` 标 `2`(可选,声明意图);
- **需要用户输入文字的动作**(如"按提示词改写这张图"):按钮上再加
  `data-ghost-prompt="占位文案"`(≤128 字,可空串)。用户点击时主机弹标准输入框
  收集文字(textarea,回车发送/Esc 取消),card-action 事件多带 `prompt` 字段
  (≤2000 字)——输入交互由主机代管;
- **App 图标**:`span` / `div` 加 `data-ghost-icon="settings"`,主机换成 App 里同一个设置图标(Lucide,
  颜色跟随 `currentColor`,尺寸跟随你给这个位置的宽高)。目前只登记了 `settings`;位置里写一个兜底图形,
  旧版客户端会照常显示它;
- **模型下拉框**(如「用哪个模型跟进」):按钮上再加 `data-ghost-model-select="当前模型 JSON"`
  (`{agentKind,providerId,model,effort,fastMode}`,与 `cindy.pickModel` 返回的 route 同形,经 HTML
  属性转义;没有当前值写空串)。新版电脑端点击时在按钮正下方弹出 Cindy 的模型列表,选中后
  card-action 多带 `modelSelection`(主机已核对它当前可用)。手机和旧版客户端照常派发不带
  `modelSelection` 的动作,这时请自己调用 `cindy.pickModel({ initial, mobilePageId })` 兜底;
- **可编辑文本表单**:一张卡至多声明一个 div，其 `data-ghost-form` 属性为经 HTML 属性转义的
  JSON 字段数组，每项 `{name,label,value,multiline?,row?,collapsed?,kind?}`；1–16 项、字段名唯一、label ≤128 字、value ≤16000 字。
  div 内保留纯文本预览供旧客户端使用。宿主在卡片顶部用标准控件渲染；卡内仍零脚本，禁止用它收集凭证。
  按钮加 `data-ghost-submit="true"`，真实点击后事件带 `formValues: Record<string,string>`；
  不与 prompt 混用。插件必须校验字段和业务对象，缺少 formValues 不得执行提交（旧客户端不会发送）。
  桌面和手机共用字段合同，手机继续校验卡片 revision；原卡收到更新后结束提交状态。
  row 为同一行的分组名，collapsed 默认折叠字段。kind:"recipients" 将地址显示成姓名，
  同一 row 按实际宽度折叠溢出人数，展开直接替换摘要；原字符串仍是编辑和提交的值。旧端忽略 kind。
  div 可声明 `data-ghost-change="change-action-id"`：编辑即时回传 card-action + formChange:true + formValues；
  此事件没有 userActionToken，不触发 Agent 或活动呼吸。动作 ID 标识当前编辑版本，自动保存回执保持同一 ID，
  替换草稿/重置编辑时必须换 ID。插件合并频繁编辑，自行保存到业务系统；模型的读取和提交也必须先同步同一份编辑。
  模型工具更新本任务旧卡时，card-update 可带 sourceCallId（当前尚未结束的工具调用 ID）；Host 核对同插件、同任务后重开旧卡。
  表单动作活动归原 callId，完成后原地更新；不用额外画空的 spawnCallId 卡片。
- **可放外部链接**(外链 v3,经宿主确认):写 `<a href="https://…">官网</a>`,或在
  任意可用标签上挂 `data-ghost-link="https://…"`(整块可点)。仅收**整串**
  http/https URL(≤2048 字,不合法只丢属性——文字保留、点不动)。用户点击时主机
  先弹确认框亮出真实域名与完整链接,用户确认才在系统浏览器打开——跳转链路由
  主机独占,href 不会真的落进卡片(主机转写成声明属性),你写不了跳转、也
  骗不了确认框上显示的去向。与 `data-ghost-action` 同挂时动作优先、链接被忽略,
  一个元素只有一种点击行为;别拿链接文案冒充按钮语义,去向和文案不符只会让
  用户在确认框里看穿;
- 不带 `data-ghost-action` 的图片仍是"点开看大图":用户点卡内图片主机自动弹 lightbox
  (大图/标注/另存),零代码;超出上述文本字段的复杂交互仍去你的面板做;
- **3D 预览图**:img 再加 `data-ghost-model="cindy-media://blobs/<指纹>.glb"`(你名下
  已落库的 GLB 地址,整串精确匹配才生效),用户点击该图 = 应用内 3D 查看器直接加载
  这个模型(可旋转/缩放),不再是普通看大图。适合"3D 生成完成卡":预览 + 模型一次
  到位,结果里就别再重复下发预览图;不合法的值只丢属性(图退化为看大图);
- **在线指示**:给 `span` / `div` 加空值属性 `data-ghost-live`,主机给它播统一的呼吸光环
  (向外扩散 + 淡出,只用 transform / opacity)。用于跟进中、监听中这类持续好几天的状态:
  卡片调用结束后只存静态版、自绘动画会被剥掉,这个光环由主机驱动,卡片滚出视口或窗口
  隐藏时暂停,系统开了减弱动效时不播。元素本身画成光环的样子(如圆点外一圈同色半透明圆),
  不要在上面放文字。
- **排到本轮末尾**:卡内任一 `div` 加 `data-ghost-placement="turn-end"`(只认这个值),
  主机把这张卡排到这一轮对话的最后,在「已更改 N 个文件」卡之后,而不是调用发生的位置。
  适合等用户拍板的卡(如「要发 PR 吗」)。卡片的每个状态都带上同一个声明,换状态时才不会跳位置。
- **铺满消息列**:卡内任一 `div` 加 `data-ghost-width="full"`(只认这个值),主机取消默认的
  460px 上限,卡片和「已更改 N 个文件」卡一样宽。按宽版排版:标题行左边图标和文字、右边按钮,
  并给按钮组加 `flex-wrap`,窄窗口和手机上能自动换到下一行。
- **PR 状态位**:`div` 加 `data-ghost-pr-status="owner/repo#123"`,主机用任务标题栏同一份 PR 状态
  (检查、未解决意见、能否合并)实时替换这个 `div` 的内容,并随标题栏定时刷新。`div` 里写你自己的
  状态快照作兜底:旧版主机、手机,或这条 PR 不在本任务的 PR 列表里时原样显示。
- **手机端呈现提示**(手机不跑卡片 HTML,只收文字和原生按钮;这几个属性让它画得更像卡片):
  - 主操作 `button` 加空值属性 `data-ghost-primary`,手机画成主按钮;
  - 开关型设置的 `button` 加 `data-ghost-toggle="on|off"`,按钮里第一行文字是标题、其余是说明,
    手机画成原生开关,点一下照常触发这个按钮的动作;
  - 持续状态(如「跟进中」)所在的 `div` / `span` 加 `data-ghost-live-label="状态名"`,手机画成
    带呼吸点的状态;
  - 卡片的外链(`card.externalLinks` 声明后的 `<a href>`)在手机上显示为「打开 <域名>」,
    正文里不再插入链接地址。
  - `data-ghost-pr-status` 位在手机上同样用电脑端的 PR 状态填写,查不到时显示你写的快照。
  - 声明了 `data-ghost-placement="turn-end"` 的卡,手机端也排到本轮回复之后。
- **卡内音频播放器**:`<div data-ghost-audio="cindy-media://blobs/<指纹>.mp3">`
  (仅挂 div;mp3/wav/m4a,你名下已落库的地址,整串精确匹配)。主机会**清空该
  div 的子树**、注入与基座音频卡同款的标准播放器行(播放/暂停 + 进度 scrub +
  时间,28px 高,自动跟主题)——你只声明"这里放一个播放器",播放行为全归主机,
  卡内仍零脚本。可选 `data-ghost-audio-duration="176"`(秒)让时长在元数据加载前
  就显示。封面/标题/tags 等排版归你,围着插槽自己画;插槽只出播放器行,给它留
  ≥28px 高。**同一音频画进了卡,交卷 result 里带 `xdt_audio_in_card: true` +
  `xdt_anchor_card_id: <画播放器那张卡的 callId>`**——令牌是"待验证声明":主机
  锚到你那张卡、确认 html 里真含对应插槽后,才压掉基座按 `xdt_audio_tracks`
  画的重复播放器;验证不过(卡被拒/该端看不到卡)自动回退基座渲染,音频不会
  消失。不带令牌 = 基座照画,同一首歌出现两个播放器。手机端(无卡片体系)永远
  按 `xdt_audio_tracks` 渲染,该字段照常要发。不合法的值只丢属性(div 与子树
  保留);
- 体积 ≤32KB/版;height 是**初始估计值**(120–900,缺省 240)——文档与图片
  加载后主机会按实际内容高度自动收敛并记住(同一夹取区间,历史回放零动画),
  所以图片按自然比例放即可,**不要固定高度 + object-fit:cover 裁切作品**;
  推荐通栏出血写法 `width:100%;height:auto`(宽度撑满卡片,文字区自己
  加内边距);卡片宽约 460px(画布内宽 458;声明铺满消息列的卡随列宽变化)、高度上限 900px,**单主体大图
  优先,别在卡内摆多图对比**(缩小了看不清,对比类展示放面板);
- **height 尽量报准**:估计值和真实内容差得越多,用户第一眼看到的收敛跳动
  越明显。放单张大图时用 cindy-request 返回的 width/height 按比例算:
  `height: Math.round(458 * r.height / r.width) + 文字区高度`——首帧即
  最终高度,零跳动;
- **主题(可选)**:主机在卡片头部注了一段和面板同名的 CSS 变量,想跟主机
  换肤就用 `var(--surface, #f7f7f5)`、`var(--text-primary, #1a1a1a)`、
  `var(--border-default, #e4e4e0)` 这类语义色并**务必带回退值**(白名单同
  §5 面板那组);不想跟就照常写死颜色——写死的卡不引用这些 var,完全
  不受影响。用户切主题时主机重建卡片让 var 生效,你无需处理;
- 卡片上方主机画一枚小 chip(你的头像 + 名字 + 运行/完成状态点;可点开看本次
  调用参数),你画不了也冒充不了——它是"这块内容由某插件渲染"的信任签名;chip
  以下整块画布归你,主机不再叠边框/底色/内边距;
- **不铺底色 = 真透明**(全出血海报的推荐姿势):主机不叠底色,同时在上面那段注入块
  里声明了 `color-scheme: light|dark`(跟宿主主题实时切),卡片画布因此在两种模式下
  都是透明的、直接透出聊天背景。所以图片顶满卡片、四边不留边是安全的,**不需要**
  为了"避免白底"去自己铺一层 `--msg-tool-card-bg`;反过来,别自己写死
  `color-scheme`,那会让卡内原生控件在另一种模式下反档;
- 供卡的调用,聊天不再渲染 `xdt_image_urls` 的通用图卡(被你的卡替换);其它
  工具/其它调用不受影响。**但 `xdt_image_urls` 本身仍必须照发**(数据通道,
  IM/远程会话出站与手机端靠它),图画进卡时结果带 `xdt_images_in_card: true`
  即可(与 `xdt_audio_in_card` 同款令牌,桌面据此去重,删字段=IM 丢图);
  **跨调用画卡**(如轮询流画回首轮卡位)还需同时回锚 `xdt_anchor_card_id`
  = 持卡调用的 callId,桌面凭锚取卡验证含图后才压基座,锚不上会双渲染。

**交互卡的 card-action 处理**(声明了 card 能力即可收;点击触发你的动作、会花配额):

```js
cindy.onHostMessage(async function (msg) {
  // 用户点了你卡上的 data-ghost-action 按钮:
  if (msg.type === 'event' && msg.name === 'card-action') {
    // msg.callId = 被点那张卡的归因号(和当初 tool-call 同值);
    // msg.actionId = 你在 data-ghost-action 里写的动作 id;
    // msg.prompt = 用户输入的文字(仅 data-ghost-prompt 类按钮有,非空才带);
    // msg.modelSelection = 卡内模型下拉框选中的模型(仅 data-ghost-model-select 类按钮,新版电脑端);
    // msg.spawnCallId = 主机铸的**衍生卡位**:画到它 = 原卡下方长出新卡。
    // 声明 agent 后还会收到 msg.sessionId 与 msg.userActionToken；后者是
    // 绑定本插件+本会话、两分钟有效且只能使用一次的 Agent 通行票(见 §4.11)。
    cindy.send({ type: 'card-update', callId: msg.spawnCallId, v: 2, state: 'working', // 过程态:会话侧栏保持运行呼吸
                 html: '<div style="padding:12px">⏳ 生成中…</div>', height: 110 });
    const r = await doSomething(msg.actionId, msg.prompt);     // 干活(可调你自己的工具/network 能力)
    cindy.send({ type: 'card-update', callId: msg.spawnCallId, v: 2, state: 'done', // 终版:熄灭呼吸
                 html: renderCard(r), height: 340 });
    return;
  }
  if (msg.type === 'tool-call') { /* …见上… */ }
});
```

**新结果画哪张卡**:推荐一律画到 `msg.spawnCallId`(衍生卡位)——原卡(图 + 按钮)
原封不动、新卡堆叠长在它下方,用户可以回到原卡反复点不同按钮(MJ 抽卡式玩法);
衍生卡上的按钮再被点,主机会铸下一个衍生卡位,全部平铺挂在最初那张卡下。仍对
`msg.callId` card-update = 原地换卡(覆盖原卡,适合"状态刷新"类动作)。

收到 card-action 后你有充足时间干活再换卡:主机在派发点击时会自动重开相关卡的更新
窗口(即使卡片结算很久、你已沉睡、甚至重启后被点),你随后 `card-update` 不会被判
"太晚"。动作耗时的话可以先往 `spawnCallId` 发一张过程态卡(如"⏳ 生成中"),拿到
结果再发终版卡——两版之间隔 ≥1s(主机限速)。点击是真实用户手势、由主机独占触发,你
声明了 action id 但既伪造不了点击、也自动触发不了(卡里跑不了脚本)。

**活动状态声明(`state`,后台/长时生成强烈建议带)**:
- `state: 'working'` = 过程态卡。三重效果:①会话侧栏的运行呼吸保持点亮(每版续命,
  静默约 3 分钟自动熄灭兜底);②卡片自绘动画持续播放(不再随调用交卷停播);
  ③**该卡位的更新窗口跨调用保持打开**(自首个 working 版本起封顶 30 分钟,固定
  不滑动)——后续任何调用里都可以继续对同一 callId 供片刷进度;
- `state: 'done'` = 终版卡(成功/失败/引导文案都算):呼吸熄灭、动画停播、跨调用
  窗口关闭(回到"交卷后 10 秒宽限"旧语义)。
- 不带 state = 旧语义。非法值(working/done 之外)整条卡被拒。

**生成类插件的推荐模式(媒体资产生成必读)**:结果能画进卡的(图片,以及音频
——用上面的 `data-ghost-audio` 插槽,完成卡直接长播放器,别忘了交卷带
`xdt_audio_in_card: true` + 回锚),过程卡与终版卡都发在任务的常驻卡位上即可。结果画
不进卡的(视频——卡里放不了视频播放器;供卡会顶掉该次调用的默认媒体渲染,
千万别把卡发在交结果的那次调用上),用"**常驻过程卡**"模式:提交调用立刻发
`state:'working'` 过程卡(卡钉在提交调用的卡位),后续轮询调用跨卡位对它刷进度
(仍 working),拿到终态后对它发 `state:'done'` 的完成卡(如"✅ 已生成,内容在
下方")——真正的播放器由**没供过卡的轮询调用**按基座默认渲染(视频带
`xdt_video_urls`,见 §4 交卷字段),卡与播放器各归其位。

**媒体回锚(常驻过程卡模式必带)**:轮询调用交出媒体时,在 result 里同时带
`xdt_anchor_card_id: <提交调用的 callId>`(即你开常驻卡用的那个卷号)。渲染层
会把这次结果的播放器/媒体卡**挂到常驻卡正下方**(替换"生成中"的视觉位置),
而不是留在轮询调用发生的地方——否则 AI 批量提交多个任务、最后统一轮询时,
所有媒体会脱离各自的卡堆在会话末尾。只锚得上**你自己**的卡(主机按 ghost 归属
校验);锚不上(卡已被清理等)自动回退到轮询位置渲染,不影响交卷。该字段是
渲染层配对令牌,AI 会被统一提示忽略它,你不用在 guidance 里解释。
