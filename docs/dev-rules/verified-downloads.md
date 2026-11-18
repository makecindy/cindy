# 校验下载与受管工具安装

> **读取时机**：新增或修改文件下载、受管工具安装、下载／安装进度或它们的界面之前
> **适用路径**：`apps/desktop/src/main/{downloader,managed-tools,agent-binaries}/**`、
> `apps/desktop/src/shared/downloadProgress.ts`、
> `apps/desktop/src/renderer/components/ui/**/download*`、
> `apps/desktop/src/main/git-context/{ghArtifact,ghBinary,githubSetup,githubSetupIpc}.ts`、
> `apps/desktop/src/renderer/features/cc-agent/GithubSetupDialog.tsx`、
> `apps/desktop/src/main/local-model-runtime/{ollamaInstall,llamaCppDownloads}.ts`、
> `apps/desktop/src/main/{plugin-market/download,skillhub/installService,cindy-brain/downloadSlot,wallpaper-video,updateService}.ts`、
> `apps/desktop/src/main/voice-input/speaker/speakerModelStore.ts`、
> `apps/desktop/src/main/cindy-make/{toolInstaller,prepare}.ts`

Desktop 下载已知大小／SHA-256 的发行资产，统一调用
`apps/desktop/src/main/downloader/index.ts` 的 `download()`。
Agent runtime、Cindy Make 工具、GitHub CLI、Ollama runtime、llama.cpp runtime 与 GGUF 模型、
插件包、Skill 包、语音模型、壁纸及更新包共用该入口。
业务模块保留来源选择、包格式、授权、安装和 UI 错误映射；不再复制 HTTP、写盘、哈希、
进度、超时、重试或断点续传实现。

## 调用约定

- `sha256` 必填。`expectedSize` 同时检查响应头与实际字节；`maxBytes` 在写盘前限制流大小。
- `isUrlAllowed` 检查初始 URL 和每次重定向。插件包继续 `redirect: 'error'`；
  Ollama 使用其官方发行资产白名单。统一下载不得放宽调用方已有来源限制。
- `signal` 取消排队、请求、缓存／续传哈希和重试等待；连接／闲置超时可重试，`timeout.totalMs`
  限制取得下载槽位后的活动时长（含校验和重试等待，不含排队）。业务取消与超时分别返回 `ABORTED` 和 `TIMEOUT`。
  `TIMEOUT` 的 `timeoutReason` 区分 `connect`／`idle`／`slow`／`total`，供界面说明重试原因。
- **龟速换连接**：持续有零星数据时闲置超时永远不会触发，用户只看到进度停住（2026-11-17
  GitHub CLI 安装停在 93% 数分钟）。因此一次尝试在 `timeout.lowSpeedWindowMs`（默认 30 秒）
  内平均低于 `lowSpeedBytesPerSecond`（默认 4 KiB/s）时，以 `TIMEOUT`／`slow` 结束并重连续传。
  仅在重连能保留已写数据时启用：`resume` 不为 false、`maxAttempts` 大于 1、服务器以 206 响应
  或声明 `Accept-Ranges: bytes`，且本次没有被服务器忽略 Range。不满足时慢速下载照常继续，
  `maxAttempts: 1` 或 `resume: false` 的调用方行为不变。
- **有进展的重试不耗尽次数**：一次失败的尝试若为下一次留下至少 64 KiB 可续传的新数据，
  失败计数与退避重新开始；每次下载最多这样重置 20 次，之后按 `maxAttempts` 正常耗尽。
  没有新数据的失败照常计数。重连只在已有进展或龟速窗口结束后发生，单个下载的额外请求有界。
- 默认保留部分文件以续传；一次性安装暂存目录可用 `resume: false`。
  此模式不创建或写入续传元数据，避免将一次性授权 URL 留在磁盘；失败时删除部分文件。
  调用方只有在下载 Promise 结束后才可 `cleanup()` 或删除暂存目录。
- 默认校验成功后替换目标，下载失败保留原目标；`existingTarget: 'error'`
  原子地拒绝覆盖已有文件。不要让多个进程共写同一个暂存路径。
  下载成品与工具 `current.json` 共用 `replaceFile` 发布；Windows 拒绝 rename 覆盖时
  复用原生原子替换工具，不先删除旧目标。校验失败或发布失败不能主动删除旧目标。
- 同一目标同时只能有一份下载；完全相同的参数可复用在途 Promise，来源、策略、回调或
  取消信号不同则拒绝冲突，不能共享另一调用方更宽松的校验结果。
- `download()` resolve 表示大小和 SHA-256 已通过且文件已就位。
  最终完成通知之后的取消不撤销已经发布的文件。缓存命中同样检查来源策略、大小与哈希。
- 原始进度描述当前尝试；服务器忽略 Range 时重新从零下载。给用户看的进度一律经下一节的
  转换层生成，不在调用方各自做平滑、防倒退或节流。速度由公共下载器计算。
- HTTP 走 Electron `net.request`（逐跳检查重定向），沿用系统代理；流按块等待落盘，避免大资产无限堆积内存。
  网络错误不回传可能含签名 URL 的原始异常。

## 下载进度与界面

用户能看到的下载／安装进度只有一种数据形状和一个界面组件：

| 层 | 入口 | 职责 |
| --- | --- | --- |
| 数据 | `shared/downloadProgress.ts` 的 `DownloadProgress` | 阶段、已下载、总大小、显示百分比、速度、剩余秒数、第几次尝试与重试原因 |
| Main | `main/downloader` 导出的 `createDownloadProgressReporter` | 把 `onProgress`／`onRetry`／`onVerifying` 转成 `DownloadProgress`；字节与百分比不倒退，阶段变化与最后一个字节立即推送，其余按 200ms 节流；暂停、取消后迟到的回调被忽略 |
| 界面 | `renderer/components/ui/download-meter.tsx` 的 `DownloadMeter` | 视觉规则见 [DESIGN.md §4 Download progress](../design-rules/DESIGN.md#download-progress) |

- 阶段与插件下载事件（`plugin-download-api.md`）一致，另加宿主专用的 `preparing`、`installing`、
  `paused`：`preparing` → `queued` → `downloading` ⇄ `retrying` → `verifying` → `installing` →
  `completed`／`failed`／`cancelled`。下载器看不到的步骤由调用方 `setPhase()`；不走公共下载器的
  传输（如 Ollama 自有的 pull 协议、外部安装脚本）用 `setBytes()` 喂入字节，仍输出同一形状。
- 新的下载界面直接把 `reporter.callbacks` 展开进 `download()`，在推送给界面的已有状态里加一个
  `download?: DownloadProgress` 字段。已有字段保留；持久化过的结构（如写进聊天消息的
  Cindy Make 报告）只增不改，旧记录缺少 `download` 时界面回退旧显示。
- 这些都是本机 IPC，不经 device-link，也不是插件协议；插件侧仍按 `GhostPipeDownloadProgress`。
- 新增或修改下载、安装进度时：传输走 `download()`，显示走 `DownloadMeter`，不再复制字节／速度
  格式化、进度条或「卡住」时的提示文案；需要新状态时扩充 `DownloadProgress` 与 `downloadProgress.*`
  文案，而不是在业务界面单独处理。
- 现状（2026-11-17）：GitHub CLI、Cindy Make、Ollama 安装与模型拉取、llama.cpp、语音模型、SkillHub
  安装目标选择、电脑控制驱动更新、Pi 内核与本地数据库异常页的更新准备使用 `DownloadMeter`。
  启动页（§16 品牌画布）与壁纸缩略图（`wallpaper.md` 2026-10-19 裁决：不显示百分比、不另起一行）
  保留自有进度条，但状态文字、重试原因与读屏文本取自同一份 `DownloadProgress`。
  尚未覆盖：插件市场安装没有进度通道（需新增 IPC 与手机端回执，另行设计）；SkillHub 详情页的
  「更新到新版本」仍只显示按钮运行态。
- 重试次数：插件市场与 SkillHub 的包从 Cindy 服务器下载，2026-11-17 起 `maxAttempts` 由 1 改为 3
  （退避约 1 秒、2 秒，4xx 含签名过期不重试，无扇出；插件仍受原 `totalMs` 总时限约束）。SkillHub
  使用 `resume: false`，每次重试从头下载，龟速换连接不适用。

## 受管工具安装

`main/managed-tools/installer.ts` 和 `archive.ts` 提供通用的发行包解压、版本检查、
完整代次发布及安装路径发现。调用方传入可信的 `ToolArtifact` 与用户数据根目录，
成功取得绝对执行路径，直接用它启动工具，不依赖系统 PATH 或 Homebrew。
下载与解压共用 160 MiB 归档上限；下载时在写盘前截停超限内容。

Cindy Make 保留旧导出和安装目录，旧 `current.json` 不需迁移。GitHub CLI 使用
`git-context/ghArtifact.ts` 中固定版本的官方发行包和摘要，安装到
`userData/managed-tools`。新工具应复用这里；发行版选择、登录和产品入口不进入下载器。
Ollama 本次共用下载层，仍保留其现有 runtime 解压和启动布局。

## Agent 版本探测与运行目录

启动安装的版本比较、Linux 回退安装验证与「关于」页共用
`main/agent-binaries/binary-version-probe.ts`；Linux 保留原有 15 秒验证超时及取消语义。
Codex 即使只执行 `--version` 也会写入辅助程序，因此版本探测显式使用唯一临时
`CODEX_HOME`，不继承用户或任务的运行目录；成功、失败或取消后均尝试清理。

装配 Maker 时只协调已有 Codex 登录，不提前准备 Skills、规则和插件。运行资源由
显式登录或 `getAuthEnv()` 按需准备，保留原有权限检查；已有本机登录的凭证协调仍可
建立 Cindy 私有的登录目录。这不改变二进制安装策略，也不删除已有用户目录。
回归见 `binary-version-probe.test.ts`、`linuxRuntimeMigration.test.ts`、
`binaryVersionIpc.test.ts` 和 `authAssetPreparation.test.ts`。

## GitHub 连接

本机 PR 徽标缺少 gh／登录态时，在 PR 信息浮窗内点击安装／登录入口打开 `GithubSetupDialog`。主进程统一发现
受管安装、系统安装和 `~/.local/bin`，使用绝对路径调用 gh，不要求刷新 PATH 或重启。
GitHub 插件详情与「我的 Issues」通过 `GithubConnectButton` 复用同一窗口。
连接成功后分别重新加载插件配置区与强制刷新 Issues；列表已有请求时排队刷新，避免漏掉新登录态。
Issues 连接入口是可选增强，不作为原有 Cindy Issue 列表和提交能力的前置条件。
已解析到 GitHub 身份时，搜索失败保留账号并使用刷新入口，不再次显示连接按钮。
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
安装、下载、授权和完成各有独立文案与操作。下载显示标准 `DownloadMeter`（含重试原因、速度与剩余时间），
成功后只提供「完成」，并停止轮询；再次打开不把上一次成功当作新的登录检查结果。

登录前后及插件探测共用 `gh api --hostname github.com user --silent` 检查当前活动账号，兼容不支持 `auth status --active` 的旧版 gh，也避免失效备用账号干扰；只消费退出码，不读取账号响应或 token。成功后清除 token 和 PR 缓存，
通过 `git-context:github-connected` 立即刷新顶栏及侧栏。缓存代数隔离登录前的在途响应。
宿主管理的检查、登录和取 token 共用 `ghAccountEnv()`，仅在子进程环境中移除
`GH_TOKEN` / `GITHUB_TOKEN`（含 Windows 大小写变体），统一使用 gh 保存的本机账号；
保留代理与配置目录，不修改全局环境或 Agent 终端的 token。回归见 `githubSetupActiveAccount.test.ts`。
安装／登录 IPC 仅限受信本机主窗口，不开放给共享任务或 device-link；SSH／手机远程查看
继续使用被控端现有 PR 查询和刷新通道，不会误操作控制端的 GitHub 账号。

## 边界

本模块处理有发布者摘要的文件资产，不承担凭证获取、模型服务的 pull 协议、
设备直传或媒体资源归属授权。它们可保留专用协议；不能为统一形式取消摘要要求，
也不能把远端 SSH 下载静默改为本机写盘。不走 `download()` 但仍需统一显示的有：Ollama 模型拉取
（Ollama 自有 pull 协议）和电脑控制驱动更新（官方安装脚本里的 curl，Main 按文件大小采样），
二者用 `setBytes()` 输出 `DownloadProgress`；远程 SSH 安装与 Android platform-tools 不在本机显示进度。

llama.cpp 使用独立的 `createDownloader()` 队列，多 GB 模型不阻塞更新包和其他安装；请求经
`outboundFetch` 注入，保留环境变量代理与 PAC。暂停保留 `.part`／`.meta.json` 续传，取消在下载
Promise 结束后 `cleanup()`；续传时的磁盘错误暂停而不删除已下载部分。

应用更新复用底层传输，本次不改变更新包选择、签名验证、安装替换和重启流程。
底层改动仍需覆盖更新包调用方式；更新器本体遵守 `cindy-updater.md`。

回归入口：`main/downloader/__tests__`、`main/managed-tools/__tests__`，以及
`main/downloader/__tests__/progressReporter.test.ts`、`renderer/components/ui/__tests__/downloadMeter.test.tsx`，
以及 Ollama、llama.cpp、plugin-market、SkillHub、Cindy Make、语音模型、壁纸、更新和 agent-binaries 的相关测试。
