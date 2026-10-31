## 3. tools:给 AI 看的说明书(最重要的一节)

```json
"tools": [{
  "name": "gen_image", // 小写字母开头,1–64 位小写/数字/下划线/连字符;禁用宿主保留键(见 §2.1)
  "description": "根据文字描述生成一张图片,并把它挂进画廊面板。返回可在聊天中渲染的图片地址。",
  "parameters": {
    "type": "object",
    "properties": {
      "prompt": { "type": "string", "description": "图片内容的文字描述(用户原话透传,不要扩写)" }
    },
    "required": ["prompt"]
  }
}]
```

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
