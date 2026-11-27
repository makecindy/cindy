# 自定义端点：显示名称匹配

本稿针对截图中的“添加自定义供应商”配置页。**添加供应商页面完全不改**；改动只发生在自定义端点页面的“显示名称”输入区域。

打开 `index.html` 可离线查看。初始状态预填 `dee`，用于直接展示需求中的下拉匹配态；也可以改搜 `open`、`anthropic`、`moon` 等关键词，查看多个目录结果；清空或继续输入即可查看自定义路径。

## 交互合同

- 输入任意关键词时，在“显示名称”输入框下方按名称、别名和协议标签筛选目录；例如 `dee` 匹配 `DeepSeek`，`open` 可匹配 `OpenAI` / `OpenRouter`，`anthropic` 匹配 `Anthropic`。每个结果展示协议与鉴权方式摘要。
- 点击 `DeepSeek` 后进入对应厂商配置路径，预填厂商默认 URL、协议和鉴权方式；这里模拟“跳转”，生产实现应复用现有厂商配置页面/表单状态，不改添加供应商入口。
- 用户不点击匹配项也可以继续填写基础 URL、API 密钥、模型和请求头，名称可以是任意值。
- 无匹配时不显示“必须选择供应商”的错误；下拉仍保留“继续输入也可以创建自定义供应商”，输入会作为自定义供应商名称保留。
- 点击返回可回到自定义端点页，保留用户已经输入的名称。

## 设计依据

- 沿用真实 `ProviderConnectionDialog.tsx` 的页面结构：标题、说明、显示名称、基础 URL、API 密钥、模型、请求头、测试连接、获取模型列表与底部保存操作。
- 颜色全部使用语义 CSS 变量，提供 Light / Dark 两套值；Surface / Elevated / Board 分层，无装饰性渐变。
- 容器使用 12px 圆角，普通操作使用胶囊形，列表项和输入在窄屏下保持至少 44px 命中高度。
- 下拉项是显示名称字段的附属层，不改变页面主结构；自定义路径保持主表单可编辑，避免把目录变成强制选择器。

依据：`docs/design-rules/DESIGN.md` §2、§4、§5、§10、§14；`docs/product-rules/core-product-principles.md` §2、§4.2；`apps/desktop/src/renderer/components/settings/ProviderConnectionDialog.tsx`。

验证：已通过 HTML 结构解析与内嵌 JavaScript 语法检查；未连接真实目录、IPC 或凭证存储，未执行生产代码修改。当前环境没有 Chromium，未生成浏览器截图。
