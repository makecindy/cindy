### 浏览器操作工作流

只要浏览器操作超出"打开一个页面看一眼",就按下面这个环来做,避免盲点、空转和把上下文撑爆。

#### 第 0 步:先判断该不该用浏览器

浏览器是**最贵**的通道,动手前先按内容性质选路:

- **公开静态页 / JSON API / RSS / 文档**:优先用宿主的网页抓取工具(WebFetch / web_search 类)或 Bash `curl`——无 tab、无登录态依赖、最省 token。**不要**为"读一篇公开文章"开浏览器 tab。
- **需要 JS 渲染、页面交互、或站点登录态(已在本浏览器里登录过)**:用本工具。
- **内容依赖用户本人在系统浏览器(Chrome / Safari)里的登录态**(公司内网 SSO、用户私人账号页):先 `action: "status"` 看 `data.realProfile`。
  - **`data.realProfile.applied === true`**(外置浏览器已套用用户同意的系统 Chrome / Edge / Brave 登录拷贝):先导航再 snapshot 判断是否已登录。已登录就继续,不要再让用户「在 Cindy 里再登一次」。仍撞登录墙时按下面「登录与登录墙」处理。
  - **未套用**(没有该字段、`applied` 不为 true、或侧边栏模式):本工具拿不到系统浏览器登录态。两条路二选一,如实告诉用户:
    1. 请用户把该 URL 复制到**自己的系统浏览器**打开、自行查看/操作(你无法代看);
    2. 或请用户在本工具的浏览器里**重新登录一次**该站点(登录态此后持久保留),你再继续自动化。
    也可提示用户到**设置 → 自动操作**打开「使用我的浏览器登录态」(仅独立外置浏览器)。**不要**自己去拷 cookie、传 `profile`、或接管用户日常 Chrome。

#### 核心操作环

1. **先探测状态,别盲目开始**
   - `action: "status"` —— 浏览器是否可用、是否已启动;同时读结果里的 `data.backend` 认环境(见「两种浏览器模式」);不可用先看下面的「环境」。
   - `action: "tabs"` —— 列已有标签页,**复用**已开的页而不是无脑开新页(否则一屏堆满窗口)。
   - 怀疑环境异常时 `action: "doctor"` 自检。

2. **用稳定的标签页句柄**
   - 打开重要页面用 `action: "open"` 时带上 `label`(如 `label: "checkout"`),后续靠 label 复用。
   - `targetId` 优先用 `tabs` / `open` 返回的 `suggestedTargetId` / `tabId` / `label`,**不要**把裸序号(`"2"`)当 `targetId` 传。
   - 开新页前先 `tabs`;按 label 或 URL 命中已有页就复用,不重复开。

3. **先读后点(snapshot → ref)**
   - 点击 / 输入前先 `action: "snapshot"`(同一个 `targetId`,`refs: "aria"`)拿到页面结构和元素 `ref`。
   - **永远用 snapshot 返回的 `ref` 去操作,绝不猜 CSS selector。**
   - 页面长 / 噪声多时用 `interactive: true`、`compact: true` 收窄;只关心某区域时用 `selector` / `frame` 限定。

4. **窄操作,操作后重新观察**
   - 用 `action: "act"` + `request: { kind, ref, ... }` 执行动作:
     - 点击:`{ kind: "click", ref }`
     - 输入:`{ kind: "type", ref, text }`(边输入边回车加 `submit: true`)
     - 按键:`{ kind: "press", key: "Enter" }`
     - 下拉:`{ kind: "select", ref, values: [...] }`
     - 悬停 / 拖拽:`{ kind: "hover", ref }` / `{ kind: "drag", startRef, endRef }`
   - `ref` 必须取自**最近一次** snapshot。导航 / 弹窗 / 提交后页面变了,**先重新 snapshot 再继续**,别用旧 ref。
   - 别盲等。需要等待用 `{ kind: "wait", ... }`(等 `loadState` / `textGone` / `timeoutMs`),不要靠反复重试空转。

5. **遇阻塞停下来报告**
   - 撞到登录墙 / 验证码 / 2FA / 需要人工授权时:**停下来如实告诉用户**当前页面状态 + 需要他做什么,不要反复尝试或假装能绕过。

#### Token 效率(按"最省 → 兜底"的顺序选路)
1. **先查有没有现成配方**:操作某个站之前,**先 `action: "siteguide"`**——带 `site`(站点 host)看该站内置指南 / 配方;**不确定有哪些站时,`siteguide` 不带 `site` 会列出全部内置站点 + 可用配方目录**(`sites:[{site,recipes,auth}]`)。命中配方就 `action: "recipe"`(`recipeId`+`inputs`)一步跑完(最省最稳),优先于手动 snapshot/extract。注意 `siteguide` 是我们内置的站点指南,**不是去抓网站自己的 `/sitemap.xml`**——不要为此去 navigate / curl `sitemap.xml`。
2. **数据型页面优先读接口,别扒 DOM**:很多列表 / 详情背后是 JSON API,读接口比扒渲染后的 DOM 又稳又省。
   - ① `action: "requests"`(带**具体** `filter`,如 `/api/quotes`;别用太宽的 `api`,会撞 `fonts.googleapis.com` 之类)看页面发了哪些 XHR/fetch、拿到接口 URL。这是读**已发生**请求的清单。
   - ② 读 body:**GET 接口最稳的姿势是直接 `navigate` 到该 URL**,再用 `extract`(`fields:{ data:"body" }`)或 snapshot 读返回的 JSON。
   - ③ `action: "responseBody"` + `url` 是**等待下一个匹配的响应**(默认 20s 超时,**不是读历史**)——必须先发起它、再触发请求,适合轮询 / 滚动 / 点击触发的 XHR;顺序工具调用下不好配合,能用 ② 就用 ②。
3. **要可点击元素 / 探索结构,用 scoped snapshot**:`snapshot` 用来理解页面、拿交互元素的 `ref`,也是**写 `extract` 选择器前确认真实结构**的手段;输出过大时用 `selector` 限定区域 + `compact: true` / `interactive: true` / `limit` / `maxChars` 收窄(scoped snapshot 已经把 role/name/value/ref 结构化带出,很多场景够用)。
4. **要精确字段 / 干净 JSON 才用 `extract`**:snapshot 不够精准(要取某属性、按子选择器拆字段)时,用 `action: "extract"` 一次性提结构化记录(`from` + `multiple` 提列表)。**关键:`fields` 的简写 string 是纯 CSS 选择器(取 textContent);取属性用 `{selector,attr}`,取链接用 `{selector,type:"href"}`——别把属性拼进选择器(`"h3 a@title"` 非法)、别写自然语言。** 不确定选择器就先 scoped snapshot 看结构再写。
5. **慎用 screenshot**:只有需要视觉确认(布局 / 图像内容)时才 `action: "screenshot"`;链接要看真实 URL 时 snapshot 带 `urls: true`,元素位置重要时才 `labels: true`。

#### 两种浏览器模式(先认环境,再谈登录)

宿主用两种后端之一承接本工具,**顶层 action 集合一致**(两边都支持 snapshot / act 各 kind / requests / upload / dialog 等),差别在两处:少数参数级能力只有侧边栏模式有,以及"页面呈现在哪里"。判别依据是 `action: "status"` 返回结果里的 **`data.backend`**(工具结果的外层是 `{ ok, action, status, data }`,`status` 是数字状态码——**别去读 `status.backend`**,那是 undefined):

- **`data.backend === "rsb-webview"` = Cindy 侧边栏内置浏览器**:页面活在 Cindy 的会话侧边栏里,不是一个常规浏览器窗口。侧边栏本身可能内嵌在主窗口、也可能被用户开成独立子窗口,`status` **不区分**这两种承载方式——所以请用户看页面时说"Cindy 的侧边栏(若你把侧边栏开成了独立窗口,就是那个窗口)",不要断言窗口存在或不存在。系统默认的自动化后端是独立外置浏览器,不是侧边栏。
  - 仅此模式支持:`act:saveResource`(托管下载)、以及 `query` 语义元素查询(role / name / text / label / placeholder / testId / css)。在外置模式下用这两个会被 schema 或运行时门控直接拒掉,别当通用能力使。
- **`data.backend` 不是 `"rsb-webview"`(通常没有该字段)= 独立外置浏览器**:一个专属持久自动化浏览器窗口(profile 显示为 "Cindy")。`act:saveResource` 与语义 `query` 在此模式不可用,元素定位改用 snapshot 的 `ref` 或 `selector`。

**两种模式彼此隔离**。侧边栏始终是独立身份。外置浏览器默认也是独立的 `Cindy` profile;仅当用户在设置里打开「使用我的浏览器登录态」且 `status.data.realProfile.applied === true` 时,外置窗口才带着系统 Chrome / Edge / Brave 的登录拷贝(可撤销,Agent 以用户身份访问)。**不要传 `profile`**,不要试图 attach 用户日常使用的 Chrome。

#### 登录与登录墙
- 操作需要登录态的站点前,导航后先 `action: "snapshot"`(必要时配 `screenshot` 视觉确认)判断是否已登录。**不要**用 `profiles` 判断登录态——它不携带按站点的登录信号。
- **撞到登录墙 / "请重新登录" 时**,先 `action: "focus"`(带该 tab 的 `targetId`)把该 tab 切成活动 tab,再**停下来如实告诉用户**,按环境二选一:
  1. 请用户**直接在当前这个页面里登录**(扫码 / 输账号 / 过验证码)——侧边栏模式就是 Cindy 侧边栏里那个 tab,外置模式是那个自动化浏览器窗口;登录态会长期保留,完成后你再继续。注意 `focus` 的效果按模式不同:侧边栏模式下它只切活动 tab、**不会**把窗口抢到系统前台(agent 触发的显示一律不抢焦点);外置模式下通常会顺带把浏览器窗口置前,但不保证成功。两种情况都要把"去哪儿看"讲清楚,别假定页面已经弹到用户眼前。
  2. 若用户表示"我只在自己浏览器里登录过 / 不想再登一次",不要硬试:把 URL 给用户,请他在**系统浏览器**里自行打开查看。
  **不要**自己硬试或假装能绕过,也不要在两条路之外把用户支去无关页面。
- **OAuth 弹窗登录的坑(侧边栏模式)**:站点用 `window.open` 小窗做第三方授权时,弹窗会被转成新 tab,授权完成后**登录结果可能传不回原页面**(原页面停在"等待授权")。遇到这种站点:优先选站点的**整页跳转**登录方式;只有弹窗式可选时,请用户在弹出的 tab 里完成授权,**回到原 tab 刷新一次**再判断登录态。

#### 失败与 stale ref 恢复
- `ref` 失效(页面变了 / 元素消失):对**同一个 targetId** 重新 `snapshot`,在新结构里找当前可见的控件,**重试一次**。
- 重试后仍失败,或 UI 已变成登录 / 错误 / 验证码等阻塞态:停下来报告,不要无限循环。
- 工具返回 `ok: false` 时读 `message` / `errorCode`,区分是"页面问题"还是"浏览器不可用"(后者见「环境」),分别处理。

#### 环境
- `status` 显示浏览器不可用,多半是本地浏览器运行时未就绪。提示用户到**设置 → 自动操作**检查浏览器状态 / 完成首次准备,不要在工具层反复重试。

#### action 速查
| action | 用途 |
|---|---|
| `status` / `doctor` | 可用性 / 自检(读 `data.backend` 判环境,见「两种浏览器模式」) |
| `start` / `stop` | 启停浏览器 |
| `profiles` | 看 profile 列表(**不含**按站点登录态信号) |
| `tabs` / `open` / `focus` / `close` | 标签页:列 / 开(带 label)/ 切 / 关 |
| `navigate` | 当前或指定 tab 导航到 URL |
| `snapshot` | 读页面结构 + 拿 ref(交互前定位元素用) |
| `act` | 执行 click/type/fill/press/select/hover/drag/wait/evaluate(见 `request.kind`) |
| `extract` | 按字段 schema 从 DOM 提结构化数据(列表/详情,优于全页 snapshot) |
| `requests` / `responseBody` | 看页面已发生的 XHR/fetch 列表(可 `filter`) / 等待并读下一个匹配响应的 body(先发起再触发;读 GET JSON 优先直接 navigate 到该 URL) |
| `recipe` / `siteguide` | 跑某站现成配方(`recipeId`+`inputs`) / 取某站内置指南(`site`,含入口/关键页/可用配方;非 sitemap.xml) |
| `screenshot` | 仅在需要视觉确认时用 |
| `console` / `pdf` / `upload` / `dialog` | 控制台日志 / 导出 PDF / 上传文件 / 处理原生弹窗 |

> **直接调用 `browser` 工具时,`wait` 不是顶层 action**:`action: "wait"` 会报 `INVALID_ARGS`。等待请用 `act` + `request.kind: "wait"`(等 `loadState` / `textGone` / `timeoutMs`)。同理,`evaluate` / `saveResource` 等原子操作也只能作为 `act` 的子操作(`request.kind`),顶层 action 枚举里没有它们。**此限制仅针对直接调用 `browser` 工具的 `action` 参数;配方 `recipeDraft.steps[].action` 里仅 `wait` / `evaluate` 是配方 DSL(由运行器转换为 `act`,不在此限制内),`saveResource` 在配方中同样不可用(`RecipeStepSchema` 不接受它)。**
