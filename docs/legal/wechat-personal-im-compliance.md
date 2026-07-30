# 个人微信 IM 合规与发布记录

> 状态：`release-blocked`。本文记录个人微信 IM 的协议来源、数据处理和发布门禁，
> 不代表腾讯已允许 Cindy 商业分发，也不代表产品、法务或隐私审核已经完成。

## 接入边界

Cindy Desktop 通过腾讯 iLink 协议连接用户主动绑定的个人微信账号，仅支持私聊。
协议行为和少量纯工具逻辑独立改写自腾讯开源项目
[`openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)：

- 固定版本：`v2.4.6`
- 固定 commit：`cef0bfc390393f716903e16d50408118047f87e0`
- 获取日期：2026-07-27
- 源码许可：MIT
- 仓库内来源与派生文件清单：
  [`packages/wechat-ilink/UPSTREAM.md`](../../packages/wechat-ilink/UPSTREAM.md)
- 上游许可原文：
  [`packages/wechat-ilink/LICENSE.tencent-openclaw-weixin`](../../packages/wechat-ilink/LICENSE.tencent-openclaw-weixin)

MIT 源码许可只覆盖相应源码，不自动授予 iLink 服务、微信品牌、绑定页面或商业分发权。
正式发布必须取得腾讯对第三方接入方式、应用标识、品牌展示、目标地区和分发渠道的明确确认。

本功能与 Mobile 使用的微信 Open SDK 登录是两条独立链路。Open SDK 的合规记录见
[`wechat-open-sdk-compliance.md`](./wechat-open-sdk-compliance.md)，不得互相替代签核。

## 数据处理

用户完成绑定后，Cindy Desktop 会处理：

- 微信私聊文本、引用上下文和平台消息标识；
- 用户主动发送的图片、语音、文件和视频；
- 回复所需的 `context_token`、轮询 cursor、收件箱和发件箱状态；
- 绑定凭证、绑定 epoch、错误诊断码和连接时间。

处理边界：

- 绑定凭证只进入 Desktop Main 的系统安全存储，不进入 Renderer、日志或仓库；
- 消息任务和可靠队列保存在当前 Cindy 账号的本地数据库中，敏感 payload 使用独立数据密钥；
- 入站媒体只落在 Cindy 受管附件目录；用户通过系统目录选择器指定的是 Agent 工作目录，
  不改变媒体存储边界；
- 用户选择的 Agent/provider 可能把消息和附件发送给对应模型服务，隐私政策必须按真实
  provider 行为披露；
- Cindy 服务端不承担首版微信消息中转；
- 解绑会先关闭绑定 epoch，再停止传输、清理队列与受管媒体，最后删除凭证和数据密钥。

## 用户可见行为

- 绑定前明确说明将打开腾讯控制的外部页面，页面可能显示 OpenClaw 品牌；
- 重绑前明确说明新的 Cindy/OpenClaw 连接可能替换已有连接；
- 个人微信不允许 Full Access，高风险确认只在 Desktop 完成；
- 有效的签名兼容策略只允许停用功能，不能远程改 endpoint、协议参数或下载代码；
- 远程 `reason` 只作为受限诊断码，不能作为 HTML/Markdown 或任意 UI 文案渲染。

## 发布前签核清单

- [ ] 腾讯确认 Cindy 可按目标地区、版本和渠道使用 iLink 并商业分发。
- [ ] 腾讯确认应用标识、绑定页 OpenClaw 品牌展示和重绑排他行为可接受。
- [ ] 产品/法务确认用户协议、隐私政策和帮助文档已覆盖上述数据处理。
- [ ] 安全团队生成独立 Ed25519 密钥；私钥不进入本仓、构建机日志或更新器密钥系统。
- [ ] 发布负责人填入内置 manifest URL、公钥和帮助链接固定前缀，并完成签名停用演练。
- [ ] Windows 与 macOS 完成首次绑定、重绑、解绑、断网恢复、五种媒体和熔断回归。
- [ ] `pnpm licenses:generate` 后生成产物无意外差异，`pnpm test:runner` 通过，安装包内
  NOTICE/SBOM 已核对。
- [ ] 记录签核日期、签核人、目标版本、目标地区和发行渠道。

未全部完成前，个人微信入口不得作为 GA 能力发布。
