## 4.19 表单弹窗(form 能力)

要用户填一组设置(几项文字、下拉、开关,或一张可增删的条目清单)时,声明 `"form": true`,
经管子请主机弹一个**主机画的**表单弹窗:和 Cindy 自己的表单同一套组件、遮罩盖住整个窗口,
用户点「保存」后把填好的值交回插件。只问「是/否」用确认弹窗(§4.18);在设置页或面板里自己画
一个假弹窗,遮罩只能压暗自己那一块,盖不住 Cindy 窗口。

```js
const r = await cindy.form({
  title: '顾雍',                                   // 必填,≤40 字
  description: '消息先对上是哪件事再交出去。',        // 可选,≤300 字
  fields: [
    { type: 'switch', key: 'enabled', label: '关注中' },
    { type: 'choice', key: 'scope', label: '看哪些消息',
      options: [{ value: 'mention', label: '只看 @我的' }, { value: 'all', label: '全部消息' }] },
    { type: 'list', key: 'topics', label: '要处理的事', itemLabel: '事情', addText: '再加一件事', maxItems: 5,
      fields: [
        { type: 'text', key: 'what', label: '什么样的消息', required: true, maxLength: 60 },
        { type: 'select', key: 'project', label: '交给哪个项目', placeholder: '选择项目', required: true,
          options: [{ value: 'chat', label: '对话' }, { value: '/work/event', label: '活动' }] },
        { type: 'textarea', key: 'how', label: '让 Cindy 做什么', maxLength: 120 },
      ] },
  ],
  values: { enabled: true, scope: 'mention', topics: [{ id: 't1', what: '活动场地', project: '/work/event', how: '' }] },
  submitText: '保存',          // 可选,≤12 字;缺省用主机的「保存」
  cancelText: '取消',          // 可选,同上
  action: { id: 'unfollow', text: '删除关注', danger: true, icon: 'trash', confirm: '删除这个关注?这里的设置也会一起删掉。' }, // 可选
});
if (r.ok && r.outcome === 'submit') {
  // r.values:按字段收口过的值,列表条目带回原来的 id,新加的条目没有 id
} else if (r.ok && r.outcome === 'action') {
  // r.action === 'unfollow':用户点了额外操作(带 confirm 的已经过主机二次确认)
} else if (r.ok) {
  // outcome === 'cancel':取消 / Esc / 超时 / 窗口关了 —— 什么都别做
} else {
  // r.errorCode: PERMISSION_DENIED / INVALID_REQUEST / RATE_LIMITED / BUSY / UNAVAILABLE / INTERNAL
  // UNAVAILABLE 也包括「Cindy 窗口不在前台」;按需退回自己的页面
}
```

字段:

| type | 画成 | 值 | 额外参数 |
| --- | --- | --- | --- |
| `text` / `textarea` | 单行 / 多行输入 | 字符串 | `placeholder`、`required`、`maxLength`(1–2000,缺省 200) |
| `select` | 下拉 | 选项的 value;不在选项里时为空串 | `options`(≤50,value ≤512 字)、`placeholder`、`required` |
| `choice` | 分段单选 | 选项的 value;缺省第一个 | `options`(≤5,label ≤12 字) |
| `switch` | 开关 | 布尔 | — |
| `list` | 一张张可增删的卡片 | `[{ id?, <字段 key>: 值 }]` | `itemLabel`、`addText`、`maxItems`(1–20)、`fields`(≤8 个基础字段,不能再套列表) |

所有字段都有 `key`(字母开头、字母数字下划线、≤32,不能是 `id`)与 `label`(≤40),可选 `hint`(≤120)。
顶层最多 12 个字段。

版式:弹窗固定高度,内容在中间滚动;每个字段一行,左边标签(约 6 个汉字宽,长了会换行)、右边控件,
所以**标签尽量短、能不写 hint 就不写**,让 placeholder 和选项本身把意思说清。列表条目平时收成一行摘要,
同时只展开一条编辑:摘要标题取条目里**第一个 `text` 字段**的内容,副标题是各 `select` / `choice` 的选中项
(按字段顺序),所以把最能代表这一条的文字字段放在第一个。必填项在用户点保存时才检查,没填的条目会被展开并就地提示。

规则与红线:

- **`ok:true` 只代表问到了,答案看 `outcome`**。用户的输入只在点了「保存」后才交给你,`values`
  已按你的表单收口(多余的 key 丢掉、下拉值不在选项里清空、文本截到 maxLength、条目截到 maxItems),
  但**业务校验仍要自己再做一遍**;
- 列表条目的 `id` 是你给已有条目的不透明标识(`[A-Za-z0-9_.:-]`,≤64),主机原样带回,用它把改动对回
  自己的记录;新加的条目没有 id,由你分配;
- 弹窗的壳、身份头(你的图标+名字)、按钮与必填校验都**由主机画**,你只供文案,且会被净化(控制字符
  剥除)+ 卡长度;超长直接 INVALID_REQUEST,不静默截断。点击链路主机独占,你点不了自己的按钮;
- **只在用户正看着 Cindy 时弹**:没有获得焦点的 Cindy 窗口时回 UNAVAILABLE。表单应由用户的点击
  触发,不要在后台自己弹;远程查看设置页时点的按钮也会拿到 UNAVAILABLE,这时退回自己的页面;
- 同一插件两次请求最小间隔 1 秒,从上一次请求或上一个表单关掉算起(RATE_LIMITED);**全局同时只有一个
  表单**(BUSY,不排队);
- 没人应答 10 分钟按取消处理并收起弹窗。从面板或设置页经 BroadcastChannel 转给电子脑等结果时,
  页面那边的请求超时要按这个量级设,别让页面先超时;
- `action` 是底部唯一的额外操作,单独画在底部左侧(取消、保存在右侧),适合删除这类不属于「提交表单」
  的操作;`icon: 'trash'` 时画成垃圾桶图标按钮,`text` 作为悬停提示与读屏名字;带 `confirm` 时主机先用
  同款确认框再问一次,用户确认后才回 `outcome: 'action'`。删除这类操作请同时给 `danger` 与 `confirm`;
- 手机插件页(带 `mobilePageId`)与 Node Host 暂不支持,分别回 UNAVAILABLE 与不支持;
- **检测接口再用**:旧版 Cindy 没有 `cindy.form`(`typeof cindy.form !== 'function'`),新增的
  `form` 声明在旧客户端只是保留数据、不生效;插件要能退回自己的页面,`minCindyVersion` 不能替代这一步。
