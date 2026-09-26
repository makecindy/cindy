# 校验下载与受管工具安装

Desktop 下载已知大小／SHA-256 的发行资产，统一调用
`apps/desktop/src/main/downloader/index.ts` 的 `download()`。
Agent runtime、Cindy Make 工具、Ollama runtime、插件包、Skill 包及更新包共用该入口。
业务模块保留来源选择、包格式、授权、安装和 UI 错误映射；不再复制 HTTP、写盘、哈希、
进度、超时、重试或断点续传实现。

## 调用约定

- `sha256` 必填。`expectedSize` 同时检查响应头与实际字节；`maxBytes` 在写盘前限制流大小。
- `isUrlAllowed` 检查初始 URL 和每次重定向。插件包继续 `redirect: 'error'`；
  Ollama 使用其官方发行资产白名单。统一下载不得放宽调用方已有来源限制。
- `signal` 取消排队、请求和重试等待；连接／闲置超时可重试，`timeout.totalMs`
  限制含排队的整体时长。业务取消与超时分别返回 `ABORTED` 和 `TIMEOUT`。
- 默认保留部分文件以续传；一次性安装暂存目录可用 `resume: false`。
  调用方只有在下载 Promise 结束后才可 `cleanup()` 或删除暂存目录。
- 默认校验成功后替换目标，下载失败保留原目标；`existingTarget: 'error'`
  原子地拒绝覆盖已有文件。不要让多个进程共写同一个暂存路径。
- 同一目标同时只能有一份下载；完全相同的参数可复用在途 Promise，来源、策略、回调或
  取消信号不同则拒绝冲突，不能共享另一调用方更宽松的校验结果。
- `download()` resolve 表示大小和 SHA-256 已通过且文件已就位。
  最终完成通知之后的取消不撤销已经发布的文件。缓存命中同样检查来源策略、大小与哈希。
- 进度描述当前尝试；服务器忽略 Range 时重新从零下载，UI 应保留自身已有的显示平滑策略。
  速度和节流由公共下载器计算，不再在资产安装入口复制。
- HTTP 走 Electron `net.request`（逐跳检查重定向），沿用系统代理；流按块等待落盘，避免大资产无限堆积内存。
  网络错误不回传可能含签名 URL 的原始异常。

## 受管工具安装

`main/managed-tools/installer.ts` 和 `archive.ts` 提供通用的发行包解压、版本检查、
完整代次发布及安装路径发现。调用方传入可信的 `ToolArtifact` 与用户数据根目录，
成功取得绝对执行路径，直接用它启动工具，不依赖系统 PATH 或 Homebrew。

Cindy Make 保留旧导出和安装目录，旧 `current.json` 不需迁移。GitHub CLI 使用
`git-context/ghArtifact.ts` 中固定版本的官方发行包和摘要，安装到
`userData/managed-tools`。新工具应复用这里；发行版选择、登录和产品入口不进入下载器。
Ollama 本次共用下载层，仍保留其现有 runtime 解压和启动布局。

## GitHub 连接

本机 PR 徽标缺少 gh／登录态时，点击打开 `GithubSetupDialog`。主进程统一发现
受管安装、系统安装和 `~/.local/bin`，使用绝对路径调用 gh，不要求刷新 PATH 或重启。
GitHub 插件详情与「我的 Issues」通过 `GithubConnectButton` 复用同一窗口。
连接成功后分别重新加载插件配置区与强制刷新 Issues；列表已有请求时排队刷新，避免漏掉新登录态。
Issues 连接入口是可选增强，不作为原有 Cindy Issue 列表和提交能力的前置条件。
GitHub 插件由宿主显示单一账号区，通过固定 GitHub `/user` 请求验证用户名与当前来源；
优先 gh，取不到凭证时才使用备用 PAT，不把网络或单项操作权限错误当作退出登录。
插件 1.2.8 起在 `/secrets` 的 `hostManagedSetup` 为 true 时仅显示折叠的备用 Token 区，
旧宿主仍保留插件自带状态和测试连接。保存/清除 PAT、登录完成、窗口重新聚焦时刷新
宿主账号状态；账号切换重挂载，丢弃旧请求，凭证明文不进入渲染进程。
宿主统一折叠「其他连接方式」，并兼容官方插件 1.2.7 的旧设置页：仅隐藏重复的账号说明
和测试按钮，保留插件的只写 Token 表单；不更改插件安装内容或官方来源校验。
账号行与折叠区使用不同的 React key，避免账号切换或刷新时遗留重复行。
`githubSetup.ts` 先检查现有安装和登录，必要时安装并用非交互管道启动官方设备码流程。
Renderer 只接收阶段、进度、设备码和固定 GitHub 授权地址，不接收 token 或 CLI 原始输出。
点击遮罩不会关闭窗口或取消操作；取消按钮或 Esc 会请求中止下载／登录，已安装的工具保留。
新登录在 gh 默认的 `repo/read:org/gist` 外申请 `workflow/project/notifications/read:packages/write:packages`，
覆盖日常工作流、Projects、通知和包发布；最终授权由用户在 GitHub 页面确认，已有登录不强制重新授权。
安装、下载、授权和完成各有独立文案与操作。下载复用 `DownloadMeter`，
成功后只提供「完成」，并停止轮询；再次打开不把上一次成功当作新的登录检查结果。

登录成功用 `gh auth status --hostname github.com` 复核，然后清除 token 和 PR 缓存，
通过 `git-context:github-connected` 立即刷新顶栏及侧栏。缓存代数隔离登录前的在途响应。
安装／登录 IPC 仅限受信本机主窗口，不开放给共享任务或 device-link；SSH／手机远程查看
继续使用被控端现有 PR 查询和刷新通道，不会误操作控制端的 GitHub 账号。

## 边界

本模块处理有发布者摘要的文件资产，不承担凭证获取、模型服务的 pull 协议、
设备直传或媒体资源归属授权。它们可保留专用协议；不能为统一形式取消摘要要求，
也不能把远端 SSH 下载静默改为本机写盘。

应用更新复用底层传输，本次不改变更新包选择、签名验证、安装替换和重启流程。
底层改动仍需覆盖更新包调用方式；更新器本体遵守 `cindy-updater.md`。

回归入口：`main/downloader/__tests__`、`main/managed-tools/__tests__`，以及
Ollama、plugin-market、SkillHub、Cindy Make 和 agent-binaries 的相关测试。
