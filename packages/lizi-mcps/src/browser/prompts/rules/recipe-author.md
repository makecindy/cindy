### 给站点写配方(recipe authoring)

当某个站点会被反复操作、值得沉淀成确定性流程时,用下面的流程给它写一份**配方**(declarative recipe),之后 `action: "recipe"` 一步跑完、几乎不让模型对着 DOM 盲探。配方包含可执行步骤;写完用 `action: "saveRecipe"` 存进你的本地层(L2),内置同名配方会被你的版本覆盖,删掉本地文件即恢复内置。

#### 作者流程(recon → 发现 → 抽取 → 验证 → 沉淀)

1. **侦察**:先 `action: "siteguide"` + `site` 看有没有现成指南/配方;没有就 `navigate` 到目标页 + **scoped `snapshot`**(带 `selector` 收窄)摸清结构,`action: "requests"`(带**具体** `filter`)看页面发了哪些 XHR/fetch。
2. **优先发现接口**:很多列表/详情背后是 JSON API。找到接口 URL 后,把可变部分(关键词、页码、subreddit 等)抽成 `inputs` 变量,URL 里用 `{{var}}` 占位。**读 GET JSON 接口最稳的姿势:`navigate` 到该 URL,再 `extract` `{ fields: { body: "body" } }` 读回 JSON**(不要用 responseBody 来读历史响应,它是"等下一个匹配响应")。
3. **鉴权**:判断是否需要登录。需要就在 siteguide 的 `auth` 字段写清楚,并在配方里把登录态相关步骤设 `optional: true` 做探测;真正登录由用户在持久浏览器里完成一次。
4. **抽取**:扒 DOM 字段用 `extract`——**先 scoped `snapshot` 确认选择器在页面上真实存在再写**(别凭空猜选择器、别把属性拼进选择器)。`fields` 的 string 是纯 CSS 选择器(取 textContent),取属性用 `{selector, attr}`,取链接用 `{selector, type:"href"}`。列表用 `from` + `multiple`。
5. **交互步**:`click` / `type` / `select` 直接写**稳定 CSS `selector`**(运行时由 act 解析,不写死 snapshot ref,跨会话不腐烂)。`type` 配 `submit: true` 提交表单。
6. **验证**:用 `action:"recipe", site, recipeDraft, inputs` 当场试跑。交互和读取步骤须有 `guard:{url,selector?,text?}`：完整 URL 精确匹配，标准 CSS selector 须唯一可见匹配，可选 text 精确匹配（去首尾空格）。URL 应包含账号/项目身份；同 URL 多账号时用页面账号元素校验。最后一步须带 `expect:{minCount?,requiredFields?,equals?}`，用 `as` 和 `output:"{{变量}}"` 返回经过验证的结果。expect 检查每条记录的顶层字段，equals 的字符串可插值。guard/expect 不可 optional。
7. **沉淀**:`action: "saveRecipe"`,传 `site`(站点 host)+ `recipeDraft`(配方对象)+ 可选 `siteGuideDraft`。只能保存本任务中刚试跑成功的同一份 draft 和 site；改动内容必须重新验证。不要提供宿主管理的 validation 字段。每站可保存多个 id。

#### 取数策略(先判断站点属于哪种,再选 step)

绝大多数列表/详情背后都是 JSON 接口,按是否需要登录态分两类:

- **公开接口(public)**:`navigate` 到接口 URL,再 `extract { fields: { body: "body" } }` 读回整段 JSON/XML。适合无需 cookie 的公开 GET 接口(如 hn.algolia.com、api.stackexchange.com、dev.to/api、export.arxiv.org、/w/api.php)。简单、不需要构造同源请求。
- **带 cookie / 反爬(cookie)**:有些站(Reddit、多数社交站)对**直接 navigate 到 .json** 会喂 SPA HTML 挡爬,或者结果依赖登录态。正确姿势是**先 `navigate` 到站点主域,再用 `evaluate` 步在页面内 `fetch`**:
  ```json
  { "action": "navigate", "url": "https://www.reddit.com" },
  { "action": "wait", "loadState": "load" },
  { "action": "evaluate", "as": "posts",
    "fn": "async () => { const r = await fetch('/r/{{subreddit|js}}/hot.json?limit=25&raw_json=1', { credentials: 'include' }); const d = await r.json(); return (d.data?.children||[]).map(c => ({ title: c.data.title, score: c.data.score, url: 'https://www.reddit.com'+c.data.permalink })); }" }
  ```
  `wait.fn` 必须是同步条件表达式/函数，不支持 async；等待异步内容时检查页面上的就绪标记。`evaluate` 的 `fn` 是一段**函数表达式源码**(可 `async`,会被 await),在页面上下文运行:因为已经在目标域上,`fetch(相对路径, { credentials: 'include' })` 自动带上该站 cookie(登录态),且是同源请求、不触发反爬。fn 的返回值用 `as` 存起来、`output` 引用(runner 会自动解包,见下)。**登录本身由用户在持久浏览器里完成一次**,配方只负责带着 cookie 取数。

#### recipe schema(写 `recipeDraft` 时照这个)

```json
{
  "id": "唯一 id(覆盖内置就用同 id)",
  "match": ["host 子串(可选,提示用)"],
  "description": "一句话说明",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://site/api?q={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "items",
      "guard": { "url": "https://site/api?q={{query|url}}" },
      "expect": { "minCount": 1, "requiredFields": ["title", "url"] },
      "extract": { "from": ".row", "multiple": true,
        "fields": { "title": ".t", "url": { "selector": "a", "type": "href" } } } }
  ],
  "output": "{{items}}"
}
```

- step `action` 取自:`navigate` / `click` / `type` / `select` / `wait` / `extract` / `evaluate` / `requests` / `responseBody`。
- `evaluate` 跑一段页面内 JS(函数表达式源码,可 async),`{{var}}` 会插值进源码——用于上面的 cookie/反爬站同源 fetch。
- **凡被 `{{var}}` 引用的输入都必须声明 `required: true`**:引擎不套任何默认值,引用了未传入的变量会抛 `missing recipe variable`。
- **`evaluate`/`extract` 步的页面内返回值会被 runner 自动解包**:`as` 存的变量、以及 `output: "{{var}}"` 直接就是 fn 返回的数组/对象(runner 去掉了 `{ result: ... }` 外壳),消费方直接用、不用再读 `.result`。
- **插值修饰符**:`{{q|url}}` 把值 `encodeURIComponent`(放进 URL query 时用),`{{q|js}}` 把值转义成 JS 字符串字面量安全形式(放进 `evaluate` 的 `fn` 源码里、用引号包起来时用),避免含空格/引号/`&` 的值破坏 URL 或源码。
- `as` 把该步结果存进变量;`{{var}}` 在后续 step 与 `output` 里插值;`output` 写 `{{单个变量}}` 会原样返回该变量(结构化)。
- 任一非 `optional` step 失败即停止,返回 `failedStep`——这时 fallback 到手动 `snapshot`+`extract`。

#### 取舍

- **分页**:第一版把页码/cursor 做成 `inputs`,一次配方跑一页,翻页多调几次。
- 偶发任务直接精确读取；只有重复使用、收益明确的流程才沉淀。正常 guard/expect 由代码执行，不调用额外模型、不定时刷新。
- 配方失败后先观察当前页面；当前任务同一 id 最多试跑一轮修订，成功后保存，失败则普通操作完成任务。不要换 id 绕过预算。输入预检或敏感页面读取预检未下发调用时，不消耗修复机会，也不暂停已保存版本。已有自动维护配方实际执行失败会暂停复用，跨任务保留，后续任务可重新验证修订版。
- `expect.minCount` 必须是正整数；`equals` 引用的变量在该步骤执行前必须已提供或由前一步产生，缺失属于输入错误。
- 写操作失败或后置读取失败，先核实写入是否已经生效；不要为了验证配方再次提交、发送、购买或发布。修复验证用只读检查、测试环境或下一次确有授权的操作。工具不会自动重放任何步骤。
- 不把密码、验证码、Cookie、令牌或实际业务数据写进配方，变动值用 inputs。
