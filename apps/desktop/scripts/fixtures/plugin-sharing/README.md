# 插件分享 Web 确认原型

原型供本地确认已实现的分享界面，不连接业务服务，不使用登录凭证，不执行插件安装或更新。

## 与实际界面的关系

- 客户端直接导入 `MarketPluginDetailView`、`GhostPluginDetailView`、`PluginShareButton`、`ShareDialog`、`ToastContainer`，不复制这些组件的 JSX 或覆盖其样式。
- 全量使用当前 worktree 的 `globals.css`、Tailwind 配置、Inter／HarmonyOS 字体、主题注册与 `ThemeService`，提供 Default 和 Cindy 的浅色、深色主题。画布像素即内容区域的 CSS 像素，不做缩放。
- 分享图、落地页直接由服务端同一 worktree 的 `createApp`、`createShareService`、`createPluginModule`、`pluginShareImage`、`renderPage` 输出。网页保持实际官网风格，不随客户端主题切换。
- 外层页签和下拉框只是原型控制台，不是产品 UI。画布只呈现插件内容区域，不伪造客户端侧栏、系统标题栏或原生窗口毛玻璃。
- Host 数据接口使用本地演示适配。只有本示例不会显示的设置、能力偏好、GitHub 账号及 Library 子视图被替换为空，实际详情、分享及提示组件均未替换。
- 复制链接、复制图片使用浏览器剪贴板；保存使用浏览器下载。成功／失败提示仍由实际组件显示，但系统原生保存对话框、文件授权和应用唤起不能在浏览器中等同复现。落地页的 `cindy://` 点击被原型拦截，避免唤起真实客户端。

## 示例资料

`fixture.json` 的 Mermaid 名称、简介、工具、作者、版本和图标来自本地官方插件 `cindy-mermaid` 的清单及中英文 locale（生成时版本 `1.1.2`）。分享者昵称、账号资料引用、资源 ID 和发布时间为演示数据，不是已部署的市场记录。署名头像使用实际 Cindy 品牌资产。所有生成链接均为本机回环地址，二维码使用同一真实 SVG 模板。

## 启动

先在本任务服务端 worktree 运行：

```bash
pnpm --filter share-server exec tsx scripts/preview.ts <客户端worktree>/apps/desktop/scripts/fixtures/plugin-sharing/fixture.json
```

再在本任务客户端 worktree 运行：

```bash
node apps/desktop/scripts/fixtures/plugin-sharing/preview.mjs
```

浏览器打开 `http://127.0.0.1:4178`。两个服务仅监听 `127.0.0.1:4178` 和 `127.0.0.1:4179`，按 Ctrl-C 停止。编译产物写入系统临时目录，不写入产品构建。此入口不会启动 Electron 或自动启动／反复启动浏览器。

## 确认方式

1. 在市场详情或已安装详情的顶栏右侧点击分享图标，查看实际分享面板。
2. 切换署名开关，观察图片和链接一起重新生成；关闭面板后焦点返回原图标。
3. 切换 Default／Cindy 的浅深主题，分别查看面板、控件与提示。
4. 切换中国大陆／Global，查看中英文文案、带区域及语言的链接、分享图片和落地页。
5. 选择未登录、资料不可用、加载、重试、下架、配置缺失、复制失败、取消或保存失败场景。落地页和独立图片页只开放各自适用的场景。
6. 接收落地页增加“分享已停用”和“链接参数被修改”场景。后者会删除署名参数并修改插件和语言提示，实际仍按原分享记录展示。
7. 分享图片页可以直接查看完整图片；接收落地页没有复制链接／保存图片等发送端工具。宽度选项用于确认当前浏览器下的窄窗口布局，不模拟手机系统或 User-Agent。

## 数据与运行边界

原型的 POST 创建、随机编号、重试复用、读取、公开资格检查与模板均走实际服务代码，数据库仓库替换为显式的进程内演示仓库，服务重启会丢失新创建的演示记录；这不是数据库持久化验收。生产实现使用 Share Server 独立 PostgreSQL，启动命令先执行正式迁移，失败不启动业务进程。本原型不调用这些命令，不连接 Auth/Plugin/数据库，账号验签和当前资料为固定 fixture。
