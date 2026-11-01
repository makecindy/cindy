# Headless Linux 入口精简方案

状态：方案已实现；验证结果与限制见 `headless-runtime-validation.md`。日期：2026-11-01。

## 目标与边界

将 VPS 作为 Desktop / Mobile 控制的执行节点，先减少入口加载和前台客户端残留带来的资源占用。第一阶段保留现有业务能力，不删除 TUI 功能，不改变账号区域、供应商、任务协议或在线部署。

代码基线：`85002b04fc`。原工作区存在未完成的合并，实验在独立 worktree 中进行，不包含该合并的未提交修改。

部署的 build-info 为 `0.1.115 / cn`，没有 commit 字段，不能凭版本号证明其与本地源码完全一致。以下源码结论针对本地基线。

## 测量证据

现有部署的 30 秒采样：

| 角色 | PSS | CPU（单核百分比） |
| --- | ---: | ---: |
| serve 后台进程 | 543 MiB | 0.133% |
| SSH 会话中的 CLI | 507 MiB | 0.000% |
| Codex app-server | 224 MiB | 0.100% |

前台 CLI 的标准输入指向已删除的 PTY，父进程为 bash；证明终端已经消失，不能单凭这一点确定残留原因。未停止进程，未读取密钥、完整命令行、环境变量或任务内容。未确认业务任务完全空闲，因此这不是严格的空闲基线。服务 cgroup 与进程 PSS 的统计口径不同，不混用作节省比例。

## 已确认的加载关系

- `src/cli.tsx` 静态导入 `service.ts`、`ui/tui.tsx` 和 `plugins/browser.ts`。
- CLI 使用的 `terminalText` 来自 `ui/input.tsx`，该文件还导入 React 和 Ink。只延迟加载 `runTui` 不能完整切断界面依赖。
- `scripts/build.mjs` 将整个 CLI 打包为单个 `dist/cli.js`。只改为 `import()` 而不调整构建边界，不能证明已减少解析或常驻内存。
- `runTui` 在 `waitUntilExit()` 完成后清理 renderer 和 client；需复现 PTY 断开时该等待是否结束，不能直接认定为 Ink 缺陷。
- `version.ts` 使用 `import.meta.url` 计算运行目录，并持有可变的运行时配置。拆包需避免改变路径和复制配置单例。
- 打包脚本递归复制 `dist`，可以包含分块，但必须验证实际归档与安装后的运行路径。

## 最小实现顺序

### 1. 建立真正的加载边界

保留现有 `cli.js` 命令入口和参数语义。将 `terminalText` 提取为不依赖 React / Ink 的纯文本模块，由 CLI 和 UI 共用；在选中 serve、TUI、browser 命令后才加载对应实现。

使用 ESM code splitting，使延迟导入形成独立产物，共享模块保持单例。初版将 chunks 放在 dist 同层，减少 import.meta.url 相对目录变化；仍需逐项核对 worker、资源、native 模块和开发模式路径。不能只用 bundle 大小判断是否成功。

用构建 metafile 检查从 CLI / serve 出发的静态依赖闭包：后台不得可达 React、Ink 和 TUI；普通状态查询不得静态加载 TerminalService。若公共 barrel export 又引入重依赖，只收窄该路径，不开展全仓重构。

### 2. 复现并修复前台断线退出

在隔离 Linux 测试环境中使用伪终端启动客户端，模拟终端 EOF、PTY 关闭和 SIGHUP，观察客户端是否退出、连接是否关闭、后台任务是否继续。

仅在复现后补必要的生命周期处理：清理 renderer、关闭本客户端连接、注销监听器。不调用服务停止接口，不杀执行引擎，不让前台退出取消后台任务。需要同时覆盖正常退出和供应商终端交接。

### 3. 按相同条件复测

记录原版与修改版的 build commit、Node 版本、配置和能力集合。分别测量 CLI 查询、服务就绪、TUI 开启、TUI 退出四个阶段的 PSS 与固定区间 CPU；测量稳定窗口并重复，记录范围。在线实例不为此次测量重启。

## 验收门槛

| 检查 | 通过条件 |
| --- | --- |
| 加载边界 | 构建产物的后台静态依赖闭包没有 React / Ink / TUI |
| 命令兼容 | help、version、status 和原有参数保持兼容 |
| 路径兼容 | 从任意工作目录启动，worker、数据库迁移和资源均可定位 |
| 分发完整性 | 新 chunks 包含在安装包中，安装后的烟雾测试通过 |
| 远程控制 | 连接、发起任务、事件返回、停止与恢复流程正常 |
| 断线清理 | 模拟终端断开后客户端退出，后台服务和任务继续 |
| 收益 | 报告同条件 PSS / CPU 差值，不预设节省百分比 |

## 后续阶段

本阶段不回收 Codex app-server，也不关闭伙伴、IM 或插件。引擎空闲回收需另行定义活跃任务、等待授权、会话恢复和超时规则；业务能力裁剪待用户选定保留项后实施。

第二阶段补充（2026-11-01，用户已选择）：headless 本地 Codex 采用 Desktop 的 `disableCodexPluginRuntime` 策略，停用 Codex 原生 `plugins` / `remote_plugin`，不修改 Cindy `.cindy` 插件系统。这消除了本次实测的原生插件下载 Git 残留；本地已接入普通 Codex 的 5 分钟空闲回收，保留授权、排队与恢复保护，验证范围见 `headless-engine-idle-assessment.md` 末节。在线 VPS 未部署此改动。
