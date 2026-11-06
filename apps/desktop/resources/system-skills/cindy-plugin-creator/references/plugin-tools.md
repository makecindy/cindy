## 3. tools:给 AI 看的说明书(最重要的一节)

```json
"tools": [{
  "name": "prepare_image", // 小写字母开头,1–64 位小写/数字/下划线/连字符;禁用宿主保留键(见 §2.1)
  "description": "整理图片生成参数，返回提示词与插件保存的模型偏好，供当前 Agent 调用 Cindy Core media 工具。",
  "parameters": {
    "type": "object",
    "properties": {
      "prompt": { "type": "string", "description": "图片内容的文字描述(用户原话透传,不要扩写)" }
    },
    "required": ["prompt"]
  }
}]
```

媒体生成由当前 Agent 执行；插件获取生成结果走通用附件交接，完整流程见 [§4.0.4](plugin-media.md)。

措辞套路(实测有效):description 写清"干什么 + 返回什么";参数 description 里直接
写该工具自己的行为规则(如"用户原话透传,不要扩写"、"仅当用户显式说 X 才传 Y")——
AI 会照做。直接声明工具时,工具/参数 description 是单工具局部契约的落点;两段式目录中,
当前类别内、随实时工具集合与参数变化的规则走 §3.5 的类目 RULES。多工具或跨类别的完整
工作流与长期稳定共同原则走 §3.6 的 Manual。都不要塞进 `whenToUse`,也不要重复维护。

交互页面工具返回 `{content, structuredContent, _meta}`，**结果发给谁取决于调用方**：

| 调用方 | 结果流向 |
| --- | --- |
| AI 经 `ghost_call` 调用 | `content` / `structuredContent` 进入模型；根 `_meta` 只给页面 |
| 页面经 `app.callServerTool` 调用 | 整个结果只回页面，不自动进入模型；包括 `content` / `structuredContent` |

页面需要让 AI 知道时，用 `updateModelContext` 提交精简上下文（不触发回复），或在用户明确
点击时用 `sendMessage` 发消息让 AI 继续。工具同时对 `model` 和 `app` 可见时，仍把只应给页面
的数据放根 `_meta`，避免 AI 调用时泄露。凭证不应放进任何页面结果。模型/页面可见性及示例见
[§4.23](plugin-interactive-pages.md)。

**校验应在工具调用时完成**：包括普通工具和开页面工具，不限于两段式目录。插件要在返回
成功前校验参数与业务约束；错误指出具体字段、期望格式和修改方法，让模型能在当前调用
结果中修正，不能等页面渲染失败才暴露。`parameters` 声明不代替插件的运行时校验。

希望 AI 默认用页面处理某类业务时，把“哪些任务应先打开页面”写在**开页面工具的
description** 中；功能重叠的文字结果工具在自己的 description 里指向该工具。例如
“比较多条记录时先调用 open_view；仅需单条摘要时用本工具”。`whenToUse` 仍只放发现线索，
不塞页面操作规则；信息分工见 [§3.6](plugin-manual.md)。这是给模型的选择指引，宿主不强制
模型打开页面。

### 3.1 @ 插件入口

Composer 的 `@` 面板只展示已安装且可用的插件入口；插件作者无需声明资源搜索字段。
历史的 `manifest.atResourceProvider` 已移除且不再生效，不能通过该字段接入资源搜索。

### 3.2 工具审批声明

`tools[].approval` 可省略，沿用任务权限模式；`"each-call"` 要求逐次确认，不能被“本会话允许”覆盖。`"auto"` 请求免于逐次确认，会作为权限列在安装或扩权更新确认中；只有用户确认的当前实例才生效，插件自报不会自行获得授权。不要把写入工具误标为只读，也不要把声明当作业务操作授权。旧宿主忽略此字段。
