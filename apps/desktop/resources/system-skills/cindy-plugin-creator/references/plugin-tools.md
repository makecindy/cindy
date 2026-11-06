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

交互页面工具返回 {content, structuredContent, _meta}：content 和 structuredContent 对 AI 可见，
根 _meta 只给页面。模型/页面可见性及示例见[§4.23](plugin-interactive-pages.md)。

### 3.1 @ 插件入口

Composer 的 `@` 面板只展示已安装且可用的插件入口；插件作者无需声明资源搜索字段。
历史的 `manifest.atResourceProvider` 已移除且不再生效，不能通过该字段接入资源搜索。

### 3.2 工具审批声明

`tools[].approval` 可省略，沿用任务权限模式；`"each-call"` 要求逐次确认，不能被“本会话允许”覆盖。`"auto"` 请求免于逐次确认，会作为权限列在安装或扩权更新确认中；只有用户确认的当前实例才生效，插件自报不会自行获得授权。不要把写入工具误标为只读，也不要把声明当作业务操作授权。旧宿主忽略此字段。
