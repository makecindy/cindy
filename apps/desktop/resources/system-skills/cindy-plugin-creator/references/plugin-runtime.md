## 4. main.js 电子脑(沙箱后台逻辑)

跑在无文件、无 Node、无通用网络直连的独立沙箱页里,只有一个全局 `cindy`。
唯一外部直连例外是所有插件页面共有的 HTTPS 图片请求;`fetch` / XHR、脚本、样式、
字体、音视频与 WebSocket 仍不能直连:

```js
// 收活:AI 调你的工具时收到 tool-call
cindy.onHostMessage(function (msg) {
  if (msg.type !== 'tool-call') return;
  // msg.tool = 工具名, msg.args = AI 填的参数, msg.callId = 卷号
  // msg.args.attachments(可能出现):用户交出的媒体,或当前 Agent / Core 工具
  // 生成后显式交给你的媒体,已由主机过户到你名下的**指纹数组**——
  // 可当源媒体,也可经 cindy-ghost://<id>/media/<指纹> 上墙。
});

// 交卷(默认 330 秒内,超时作废;够覆盖一单大文件上传/取件。长任务可续命,
// 见下方"长任务续命"):
cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: {
  xdt_image_urls: ["cindy-media://…"],  // 顶层带这个字段 → 聊天气泡直接渲染图卡
  // xdt_video_urls 同理渲染视频卡。音频用 xdt_audio_tracks(对象数组,逐轨):
  // xdt_audio_tracks: [{ xdt_audio_url: 'cindy-media://….mp3',   // 必填,缺了整轨被丢
  //   kind: 'music',            // 'music'(完整卡:封面/tags/歌词/进度条)| 'sound_effect'(精简卡)
  //   title: '歌名', cover_url: 'cindy-media://….jpg', tags: '风格描述',
  //   lyrics: '歌词', duration_seconds: 176, suno_id: '…' }]      // 除 url 外全可选
  // → 聊天气泡渲染成音频播放器卡。声明了 card 能力的插件也可把播放器直接画进
  // 自己的卡(§4.5 data-ghost-audio 插槽),那时结果多带 xdt_audio_in_card: true
  // + xdt_anchor_card_id(主机验证卡里真含插槽才压基座的重复播放器;
  // xdt_audio_tracks 仍要发——手机端靠它)。
  // 3D 产物(GLB 已入媒体库)可另带
  // _xdt_model_files: [{ provider: 'cindy', url: 'cindy-media://….glb', format: 'GLB' }]
  // ——与 xdt_image_urls 按位配对,用户点对应预览图直接进应用内 3D 查看器。
  //
  // ⚠️ 媒体字段是**数据通道**,不只是桌面渲染指令:IM/远程会话(Slack/飞书)的
  // 出站与手机端都靠这些字段把你的产物送到用户手里。**任何情况下都不要删掉/
  // 省略它们**——包括你把图画进了自己的卡片时(那会让 IM 用户永远收不到图)。
  // 画卡去重用令牌:图入卡带 xdt_images_in_card: true(音频对应
  // xdt_audio_in_card),桌面验证锚卡真含对应媒体后才跳过基座渲染,IM/手机
  // 不受影响。另:主机会对"署名调用"(cindy-request / fetch 带 callId)期间
  // 入库的媒体独立记账,你没声明媒体字段时以 xdt_media_produced 兜底注入
  // ——但那是安全网,别依赖它,正路是老实声明字段。
  // 内联意图令牌(读取类插件用):结果顶层带 xdt_media_inline: true = 这些
  // 媒体是"从文档/消息里读出来的素材",桌面呈现应由主 agent 在最终回复里
  // markdown 内联(![](cindy-media://…)),主机不画卡、也不注"别嵌 markdown"
  // 禁令;IM/远程出站仍按账本自动送图。仅在你**没有**声明 xdt_image_urls 等
  // 复数媒体字段时有意义——声明了媒体字段一律走卡片语义,别两个都带。
  // 生成类插件(画图/做视频)不要用它:生成产物走卡片语义体验才对。
  note: "干完了"
}});
// 失败交卷：errorCode 是可选的插件业务错误码；主机保留码
// (GHOST_NOT_FOUND / GHOST_NAMESPACE_MISMATCH / GHOST_ASLEEP / GHOST_CRASHED / TIMEOUT / INTERNAL 等)
// 不可由插件写入；GHOST_NAMESPACE_MISMATCH 只由主机在派发前产生，插件交卷时已执行，不能冒用。
// message 必须包含用户可执行的恢复指引；不要把失败对象 JSON.stringify 到 message。
cindy.send({
  type: 'tool-result',
  callId: msg.callId,
  ok: false,
  errorCode: 'CONFIRM_REQUIRED',
  message: '删除需要确认，请传 confirm:true 后重试',
});

// 给模型看的图片：工具的用途就是让当前 Agent「看一眼」时(截图、渲染预览、
// 图表快照),在 tool-result **顶层**(与 result 平级,不要放进 result)附 images,
// 主机把它们作为图片内容放在结果文字之后交给模型,省掉模型再去读文件的一步:
cindy.send({ type: 'tool-result', callId: msg.callId, ok: true,
  result: { path: '/…/shot.jpg', width: 402, height: 874 },   // 文字照常给
  images: [{ data: '<base64>' }],                              // 最多 2 张
});
// - 格式由主机按字节判定,只收 PNG / JPEG / WebP / GIF(不收 SVG),单张解码后
//   ≤6MB;无效项静默丢弃。一次结果里所有图合计约 140KB:小于份额的原样交给
//   模型,超出的由主机重新编码(可能缩小像素尺寸),仍放不下的不附,结果里会多
//   images_omitted:N。图上的像素若有含义(例如可直接点击的坐标),自己先压到
//   份额以内,别让主机替你缩放。
// - 每张图都占模型上下文(几百到一千多 token)且留在对话里:只在 Agent 明确要看
//   时附,自动附带的观察结果给路径即可。
// - 图片只交给模型和本次工具步骤展示,不入媒体库、不进产物账本、不会自动发到
//   IM;要交付给用户的产物仍走上面的 xdt_image_urls 等媒体字段。
// - 旧版 Cindy 不认这个字段,会直接忽略:result 里仍要给出够用的文字或路径。

// 长任务续命(超时窗口默认 330s,从派发起算绝对上限 30 分钟):
// - 经 cindy-request 请主机代办且带 callId 的署名单(出图/视频)在途时,
//   主机**自动**替这份卷续命,你不用做任何事;
// - 自己经 network 能力轮询外部长任务时,期间定期(建议 ≤60s 一次)发心跳:
//   cindy.send({ type: 'tool-progress', callId: msg.callId });
//   每次心跳把窗口重新续满一个 330s 档;callId 不是派给你的会被静默丢弃。
// - 预计超过 30 分钟天花板的超长任务,不要吊着一次 tool-call 等:视频代办用
//   mode:'submit' 异步提交(见下),自己的外部任务拆成"提交 + 查询"两个工具。

// 以下 gen_image / edit_image / gen_video / edit_video 是存量插件兼容接口。
// 新插件不要从沙箱或面板直接发媒体生成请求；按 §4.0.4 让当前 Agent 使用
// Cindy Core media 工具。非媒体的 cindy-request 能力继续按各自章节使用。
// 存量 Cindy 代办(需声明 cindy 顶层字段 + 能力详单;主机出图、落仓、记账):
// 由 tool-call 触发的代办**务必带上收到的 callId**(归因号:让用户在日志/账单里
// 对上"哪次调用花的钱");面板交互等自发代办可不带。
const r = await cindy.send({ type: 'cindy-request', kind: 'gen_image', prompt: '一只猫', callId: msg.callId });
// r = { ok: true, url: 'cindy-media://blobs/<指纹>.png', hash: '<指纹>', ext: '.png',
//       model: 'gpt-image-2', modelLabel: 'GPT Image 2', width: 1024, height: 1536 }
//     model/modelLabel = 主机实际执行的选型(权威信息)——建议把 modelLabel 写进
//     交卷 note,让用户看得见"这单是谁画的"。
//     width/height = 图片真实像素宽高(仅图片代办;主机解析不出时缺省)——供
//     聊天卡片时用它按比例精确声明卡高(见 §4.5),别拿去写进交卷文案。
// 图像可选画幅 aspectRatio:'1:1' 方图 / '3:2' 横图 / '2:3' 竖图,不传 = 后端自定:
//   { kind: 'gen_image', prompt: '一只猫', aspectRatio: '3:2' }

//   比例是意图声明(同 tier 哲学),主机翻译成该模型支持的具体尺寸,真实像素
//   以返回的 width/height 为准。**图像类专用**(gen_image 与 edit_image 都收;
//   改图不传 = 跟随源图画幅);视频画幅是另一个参数 ratio,值域不同,带错会被拒。
//   用户没提横竖要求时别自作主张,不传让后端自定。
//
// Cindy 托管 Web Search(需声明 cindy.search:["web"]):
// provider 固定为 cindy,主机固定 Anthropic Messages 搜索模型与上游凭证;
// 不接受 api_base/header/key/model/tool。
const search = await cindy.send({
  type: 'cindy-request',
  kind: 'search_web',
  query: 'Cindy 最新版本',
  limit: 5,                       // 可选,1–10,缺省 5
  provider: 'cindy',
  callId: msg.callId,             // 搜索只由 tool-call 触发,必须透传
  callerTool: msg.tool,            // 与 callId 配对验身,必须逐字透传
});
// search = { ok:true, provider:'cindy', results:[{ title, url, snippet }] }
// 改图(需详单含 "edit";源图必须是本插件名下的,1–4 张——含用户过户给你的
// args.attachments 指纹):
//   { kind: 'edit_image', prompt, hashes: ['<指纹>'] }
//   { kind: 'edit_image', prompt, hashes: ['<指纹>'], aspectRatio: '1:1' }  // 换画幅重绘
// 视频(需详单 video 类目;分钟级长任务,返回形态同上,url 是 .mp4。同步等待
// 期间主机自动替你的 tool-call 续命,分钟级任务放心 await):
//   { kind: 'gen_video', prompt }                       // 文生视频
//   { kind: 'edit_video', prompt, hashes: ['<指纹>'] }  // 参考图生视频
// 参考图怎么用:edit_video 的 refMode(可选,不传 = 'first_and_last_frame')
//   'first_and_last_frame'(缺省):1 张 = 拿它当首帧动起来,2 张 = 首尾帧
//     过渡(第 1 张是首、第 2 张是尾)。**hashes 顺序即首尾顺序。**
//   'reference_image':多张参考图锁主体/服装/场景/风格,模型据此另行构图
//     (不是拿某张当首帧)。张数上限随型号(最多 9 张),超了会被明拒并告诉
//     你该型号的上限。这个模式另有一道**总字节闸**:一单参考图加起来不超过
//     100MB(张数没超也可能撞这条),超了同样明拒,换小图或减张数即可
//     ——首尾帧模式没有这道闸。
//     ⚠️ 用这个模式时,**提示词里必须用 [Image 1]、[Image 2] 指明每张图各自
//        的用途**,顺序与 hashes 一一对应——不指明的话模型不知道你给的图是
//        干嘛的,等于白传还照样计费。主机不会替你改写提示词。
//     例:{ kind: 'edit_video', refMode: 'reference_image',
//          hashes: [h1, h2],
//          prompt: '[Image 1] 里的女孩戴着 [Image 2] 的耳环,在雪地里回头微笑' }
//   型号不支持你要的用法时直接明拒(不会偷偷换成另一种用法出片),拒绝话术
//   里带该型号支持的用法,按提示改。
//   注意别和下面异步模式的 mode 搞混:refMode 管"图怎么用",mode 管"同步还是
//   后台跑",两者正交,可以同时传。
// 视频画面参数(四项全可选,不传 = 该型号出厂默认,这也是最省心的用法):
//   ratio:'16:9' | '9:16' | '1:1' | '4:3' | '3:4'(视频专用,别和图像的
//     aspectRatio 混用)
//   resolution:'480p' | '720p' | '1080p'
//   duration:秒(整数)。**各型号支持集不同**——传了不支持的值会被明拒,
//     拒绝话术里带该型号的可用值,按提示改或者干脆不传。
//   fps:帧率(整数),同样按型号校验。
//   例:{ kind: 'gen_video', prompt: '猫在奔跑', ratio: '9:16', resolution: '1080p' }
//   ⚠️ 高分辨率 + 长时长明显更贵也更慢:用户没提要求时不要自作主张调高,
//      不传让型号自己定。
// 要不要出声 audio(可选布尔,**三态,不传与传 false 不是一回事**):
//   不传(缺省,**推荐**):随该型号自己的默认。有的型号原生音画同生,不传
//     出来就是有声的;有的型号压根不出声。不传永远不会因这项被拒。
//   true:显式要音轨。**台词/音效/配乐的内容写在 prompt 里**——台词用双引号
//     括起来(如 男人说:"你好"),音效和配乐直接描述(如 脚步踩在雪地上咯吱作响、
//     背景音乐是轻快的吉他)。主机不替你改写提示词,你不写就只能靠模型自由发挥。
//   false:显式要静音。
//   型号没有音频开关时,**显式传**这项会被明拒(不会静默忽略),拒绝话术会
//     告诉你不传即按该型号默认出片;不传就不会撞这条。
//   例:{ kind: 'gen_video', prompt: '雪地里有人走过,脚步声咯吱作响', audio: true }
//   ⚠️ 用户没提声音需求时就别传:传 true 不会凭空变好,传 false 反而可能把
//      本来有声的型号弄成默片。
//   成功返回多带一个 videoParams: { durationSeconds, resolution, ratio, fps, audio? }
//   = 本单**实际生效**的参数(主机权威)。老宿主会静默忽略这几项,拿 videoParams
//   跟你传的值对一下就知道兑现没有;要在交卷 note 里报参数,以它为准别报你传的。
//   `audio` 缺席 = 主机说不上来(型号没这个旋钮,或老宿主不认识这个字段),
//   **别把缺席读成"无声"**;要跟用户说有没有声音,只有它明确是 true/false 时才说。
// 视频异步模式(可能超过 30 分钟续命天花板,或不想吊着 tool-call 等时):
//   加 mode:'submit' → 受理后立即返回 { ok:true, jobId, status:'running',
//   expectedSeconds }(资格审/源图归属仍同步校验,拒绝立即可见),生成在
//   后台继续;用 { kind:'query_job', jobId } 轮询:进行中 { ok:true,
//   status:'running', elapsedSeconds },完成 { ok:true, status:'done', url,
//   hash, ext, model, modelLabel }(取件字段与同步返回同形),失败
//   { ok:false, message }。完成结果保留 30 分钟(每个插件最多缓存 16 单完成
//   记录,超出淘汰最旧),过期或应用重启后查无此单(按可重新提交处理);
//   后台在途上限 2 单。建议把插件工具拆成"提交生成 + 查询结果"两个,
//   让 AI 自己掌握轮询节奏。
// 选型两个可选参数,规则:
//   tier:'draft'(快省草稿)| 'standard'(默认)| 'best'(最好)——只表达档位
//     意图,具体用哪个模型由主机决定。这是你唯一该主动用的选型参数。
//   model:仅当**用户在会话里显式点名**某模型(如"用 nano banana")时,把
//     用户点的名字原样透传;白名单外会被拒。**不要**自己替用户选模型——
//     具体型号是主机资产,写死在插件里必腐烂。
// 主机模型目录暂时不可用时(返回 ok:false 且 message 含"模型目录暂时取不到"):
//   这是主机侧临时状态,不代表本插件缺这项能力——**不要频繁重试**,
//   如实告诉用户"当前模型不可用,稍后再试或重启应用",然后结束本次操作。
```

### 4.0.1 寄存:让"用户自己的图"也能被 AI 改(deposit_media)

改图/图生视频的 `hashes` **只认本插件名下的媒体**。主机生成的图天然在册,
但用户在你面板里**粘贴、拖入**的图,以及面板里早就存着的存量素材,字节只在
面板侧(IndexedDB / 你自己的存档),总仓里没有账——所以在寄存之前,它们不能
当源图。这就是"同一块画布上有的图能改、有的不能"的由来。

寄存把这些字节存进总仓、记到你名下,换回指纹;从此它与你生成的图**同权**。

```js
// 需声明:"cindy": { "media": ["deposit"] }
const r = await cindy.send({
  type: 'cindy-request',
  kind: 'deposit_media',
  data: base64,                  // 媒体字节的 base64,不含 data: 前缀
  label: '用户拖入的参考图',      // 可选,仅供主机侧账目与排查
  callId: msg.callId,            // 可选,仅日志归因
});
// r = { ok:true, url:'cindy-media://blobs/<指纹><后缀>', hash, ext, bytes,
//       deduplicated, quotaUsedBytes, quotaLimitBytes }
// 拿到 hash 就能直接当源图:
await cindy.send({ type:'cindy-request', kind:'edit_image', prompt:'背景换成雪山', hashes:[r.hash] });

// 面板上那件素材被用户删掉时撤回,释放配额(同一能力键,不用另外声明):
await cindy.send({ type: 'cindy-request', kind: 'release_media', hash: r.hash });
// → { ok:true, released, quotaUsedBytes, quotaLimitBytes }
//   released:false = 本就没有这条寄存引用(幂等,不是错误)。
```

规矩(都会被主机强制,不是建议):

- **类型按字节判**:主机读魔数,只收图片 / 视频 / 音频 / glb。你自报的 mime 或
  文件名一概不参考,识别不出直接拒——别拿 svg、zip、json 来试;
- **单次 ≤50MB**(解码后字节)。字节要以 base64 走一次 IPC,再大请自己在面板侧
  压缩或分片,别指望上限继续抬;
- **每个插件配额 1GB**,只算寄存物(你生成的图不占这个额)。同一张图反复寄存
  不重复占额(内容寻址天然去重)。**满了就拒**——不会静默淘汰旧的,因为
  "昨天能改今天改不了"是比"存不进去"更糟的体验。用 `release_media` 释放;
  返回里的 `quotaUsedBytes` / `quotaLimitBytes` 可用来提前提示用户;
- **频控**:允许 8 张突发,之后约每秒 1 张。批量粘贴不受影响,死循环会被拦;
- **寄存物不是产物**:它不会被当成生成结果自动送进聊天或 IM(用户自己粘的
  参考图被回推出去会是隐私事故),也不进 `/gallery` 作品清单。要给用户看,
  自己在面板里用 `cindy-ghost://<id>/media/<指纹><后缀>` 渲染,或做成卡片;
- **生命周期**:寄存物跨会话持久(删会话不陪葬),用户卸载你的插件时一并清理。

插件详情的能力清单会单独出现一行「可将它手中的图片、视频或音频存入你的
媒体库」并写明上限——这是唯一一条"不花钱就能写用户媒体库"的能力,所以要用户
单独点头。别为了省事把它当默认能力申请:不做面板素材加工的插件不要声明。

### 4.0.2 快问快答:向 Cindy 的快速通道要一段文字(oneshot_text)

需要"问一句、拿一段文字答案"(总结、分类、改写、抽取)而不需要 Agent 动用
任何工具时,不要发起 Agent 回合——用快问快答,几秒到几十秒出结果,便宜得多:

```js
// 需声明:"cindy": { "text": ["oneshot"] }
// 可选偏好:"cindy": { "text": ["oneshot"], "oneshotModel": "codex/gpt-5.5" }
const r = await cindy.send({
  type: 'cindy-request',
  kind: 'oneshot_text',
  prompt: '把下面的反馈按情绪分成 正面/负面/中性,只回类别词:\n' + feedback,
  // expectJson: true,     // 可选:要求只输出 JSON,主机校验可解析
  // maxTokens: 256,       // 可选:插件自限输出(正整数)。快问快答不设输出上限——
                          // 与宿主会话一致,按所选供应商/模型的自然输出,60s 超时兜底
  callId: msg.callId,      // tool-call 触发时务必带上(归因)
});
// 成功:{ ok:true, text:'…', model:'…' }(model = 实际应答的通道/型号,仅诊断)
// 失败:{ ok:false, message, errorCode }
```

规矩与边界:

- 它走主机的**轻量任务模型链**(用户在设置里配置的快速通道,与会话自动起
  标题同一条),不拉起 Agent、没有工具、碰不到用户文件、不进任何会话——
  要"干活"(读文件、查资料、多步操作)请用派活(§4.11.1);
- 选型仍不在你手里(没有 tier/model 参数),但有两级偏好:**用户可在插件
  详情页「模型与任务」里给这个插件选一个模型**(插件只有这一个模型字段,快问
  快答与你新建的任务共用;选了就钉死,失败不回落);你也可以在身份卡
  `cindy` 里声明 `"oneshotModel": "<目录模型 id>"` 表达偏好——主机目录解析
  得到(且用户没停用)就用它,解析不到按未声明处理。优先级:用户选的模型 >
  你的声明 > 系统辅助模型链。出图/视频/向量没有逐插件选模,按 tier 与系统默认走。
  声明只表达意图,别拿它当可用性保证;**更老的宿主会整份拒装含此字段的身份卡**
  (cindy 详单未知类目硬拒),
  声明前确认目标用户群的主机版本;
- `errorCode:'NO_CANDIDATE'` = 用户当前没有可用的快速通道(未配置或凭证
  不可用)。**这是正常失败面**:如实提示用户,不要重试轰炸;
- `expectJson: true` 时主机会剥掉代码围栏并校验 JSON.parse,解析失败返回
  `errorCode:'BAD_MODEL_OUTPUT'`(message 带原始输出开头供排查)。字段结构
  在 prompt 里自己描述,主机不做逐字段 schema 校验;
- prompt ≤32768 字符;同步返回,没有异步单;每插件在途上限与媒体代办共用
  (用户可配);详情页会单列一行「可向 Cindy 的快速通道提问」。

### 4.0.3 文本转向量:把文字算成向量做语义检索(embed_text)

要做"按意思找"而不是"按关键词找"(在你自己的笔记、素材、条目里做语义搜索,或给
Agent 做检索增强)时,用这个能力把文字算成向量:

```js
// 需声明:"cindy": { "embed": ["text"] }

// 1) 入库:把你的内容算成向量,自己存起来
const requestedDim = undefined; // 传 dimensions 时改成具体数字;不传就是 undefined
const doc = await cindy.send({
  type: 'cindy-request',
  kind: 'embed_text',
  texts: ['第一段内容…', '第二段内容…'],
  inputType: 'document',   // 可选:这批是"被检索的内容"
  ...(requestedDim !== undefined ? { dimensions: requestedDim } : {}),
  // tier: 'best',         // 可选:档位意图(draft/standard/best)
  callId: msg.callId,
});
// 成功:{ ok:true, embeddings:[[…],[…]], model:'…', dim:1024, modelLabel:'…' }
// 把 embeddings 连同 model + dim + requestedDim 一起存进你自己的 kv / 文件
// requestedDim 来自这次请求而不是回执;没传 dimensions 时保持 undefined。
// dim 只用于兼容性校验(例如比对存量向量长度),不是检索请求的回放依据。
// (下面检索时要用 storedModel / storedRequestedDim; storedDim 可继续用于校验)
// 回执里的 model 一定是可以原样回传的那个 id;偶尔还会多一个 upstreamModel
// (上游带版本号的实际型号),那个只用来看"后端是不是换了实现",别回传。

// 2) 检索:把用户的问题算成向量,和存量向量算余弦相似度,取最近的几条
const q = await cindy.send({
  type: 'cindy-request',
  kind: 'embed_text',
  texts: [userQuestion],
  inputType: 'query',      // 可选:这条是"用来检索的提问"
  model: storedModel,      // 必须与入库时同一型号!
  // 入库时传过 dimensions 就必须**原样再传一次**:不传等于要该型号的默认维度,
  // 默认值往往不是你入库时那个,拿到的查询向量和存量长度都不一样,没法比。
  // 入库时没传过,这里也别传(两边都用默认)。
  ...(storedRequestedDim !== undefined ? { dimensions: storedRequestedDim } : {}),
  callId: msg.callId,
});
```

**长文档要用上下文化**(voyage-context 系列):把一篇文档切好的 chunk 一起递进来,
同一文档内的 chunk **互为上下文**,每个 chunk 拿到的向量都带着整篇的语境 ——
比逐块独立嵌明显更准,尤其是"这个"、"该方法"这类指代要靠上文才懂的句子:

```js
// 入库侧:documents 是二维的 —— 每个内层数组 = 一篇文档的 chunk 序列
const r = await cindy.send({
  type: 'cindy-request',
  kind: 'embed_text',
  model: 'voyage/voyage-context-4',   // 只有 voyage-context 系列支持,别的型号会被明拒
  documents: [
    ['第一篇的 chunk1…', '第一篇的 chunk2…', '第一篇的 chunk3…'],
    ['第二篇的 chunk1…', '第二篇的 chunk2…'],
  ],
  inputType: 'document',
  callId: msg.callId,
});
// 成功:{ ok:true, documentEmbeddings:[[v,v,v],[v,v]], model:'…', dim:1024, modelLabel:'…' }
//   注意字段是 documentEmbeddings(三层:文档 → chunk → 维度),不是 embeddings
// 检索侧照旧用 texts 传一条问题(查询是单条、无上下文),型号保持一致即可
```

- `texts` 与 `documents` **二选一**,同时传会被拒(意图不明,主机不猜);
- 一篇文档必须**整篇一起嵌**,不能拆开分几次调 —— 拆了就没有上下文了,那还不如
  直接用普通型号;
- 预算是共用的:两种形态都算 chunk 总数 ≤32、单条 ≤8192 字符、合计 ≤65536 字符。
  文档多就按文档分批(别把一篇拆开)。

规矩与边界(都会被主机强制):

- **只生成,不存储**。主机把向量原样交给你就结束了 —— 存哪儿、怎么建索引、
  什么时候重算,全是你自己的事(面板 kv、你自己的文件)。主机自己的向量库不对
  插件开放;
- **换模型 = 换向量空间**。不同型号(乃至同型号不同 `dimensions`)算出的向量
  互不可比,混进同一个索引会让相似度失去意义。所以**务必把回执里的 `model` 与
  `dim` 跟向量一起存下**,检索前比对;不一致就得把存量重算一遍,而不是接着用。
  这是它跟出图最不一样的地方:出图换型号无非风格变了,向量换型号会让你的整个
  索引静默失效;
- `model` 是**可回放**的那个 id(主机白名单里的别名),存下来原样回传即可。回执
  里若出现 `upstreamModel`,那是上游带版本号的实际型号,**只作审计**:同一别名的
  `upstreamModel` 变了 = 后端换了实现,向量空间未必仍可比,建议重算存量;但请求
  时仍然只传 `model`,传 `upstreamModel` 会被白名单明拒;
- **一次 ≤32 条**,单条 ≤8192 字符,单批合计 ≤65536 字符。上限是被"向量要穿过
  管子回到你手里"的体积钉住的(3072 维一条约 60KB JSON),不是上游 API 的限额。
  更多请自己分批。超长文本请**按语义自己切块**——指望上游截断的话,你拿到的向量
  代表的是被截掉后半段的文本,而且不报错;
- `inputType` 是意图声明:`'document'` 给入库内容,`'query'` 给检索提问。
  各家模型的实际参数互不兼容,主机负责翻译;有的型号(OpenAI 系)根本没有这个
  概念,此时主机静默不发 —— 所以别把它当"一定生效"的开关。**要用就两侧一致**:
  存的时候 `'document'`、查的时候 `'query'`,或者两边都不传;一边传一边不传
  不会报错,只是召回悄悄变差;
- `dimensions` 该型号不支持时按 `errorCode:'INVALID_PARAMS'` 明拒,不会静默
  给你另一个长度;
- `errorCode:'NO_CANDIDATE'` = 当前没有可用的向量型号(用户在设置里停用了、
  该版本/该区域不提供,或主机侧凭证不可用)。**这是正常失败面**,如实提示,别
  重试轰炸;
- 失败码是分档的,按它决定下一步,别一律重试:`'INVALID_PARAMS'` = 你的请求
  本身要改(型号不在白名单、维度不支持、texts/documents 同时传、不支持上下文化
  的型号收到 documents),原样重试永远失败;`'RATE_LIMITED'` = 退避后可再来;
  `'TIMEOUT'` = 可再来,但建议同时减小批量;`'NO_CANDIDATE'` 见上;
  `'INTERNAL'` = 主机侧故障,重试与否你自己判断;
- 单次请求有 60 秒时间预算(含主机侧重试),到点即中断并返回 `'TIMEOUT'` ——
  不会让你的 `await` 永久悬着;
- 同步返回,没有异步单;每插件在途上限与媒体代办共用;详情页会单列一行
  「可把文字送去算成向量」并写明单次条数上限。
