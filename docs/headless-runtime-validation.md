# Headless Linux 第一阶段验证报告

2026-11-01；基线 `85002b04fc`；分支 `perf/headless-runtime-stage1`。

## 结论与范围

已拆分 CLI／后台／TUI 的加载边界，减少前台内存及 CLI 启动 CPU，修复真实 PTY 无信号断开后的残留和清理时的 EIO。全部业务模块保留；后台常驻内存尚无稳定改善证据，不宣称 daemon 已完成轻量化。

在线 VPS 未修改、未重启、未部署。测试在本机 WSL Ubuntu 26.04 使用新建未登录 profile，没有复制真实账号配置、访问用户工作目录或发起收费推理。

## 实现

- 保留 cli.js 和命令参数；按命令加载 service、TUI、browser，doctor 的浏览器检查也延迟加载。
- ESM 分块与入口同目录，保持资源路径；清理旧生成分块，避免陈旧产物进入包。
- terminalText 提取为纯文本模块，原 UI 导出兼容，CLI 不再通过该函数加载 Ink。
- TUI 处理 stdin end/close、SIGHUP、SIGTERM、EIO/EPIPE，卸载界面、关闭客户端并撤销监听器；等待 Ink 最后一帧的异步错误完成。其他错误仍暴露。
- 未调用后台停止接口；未改模型、权限、协议、数据库迁移、账号区域或引擎回收策略。

## 最终资源对照

相同独立包依赖、官方 Node 22.22.0、构建版本、Global 区域及新 profile。基线包只换回原始单文件 CLI，worker 与资源不变；从独立 profile cwd 启动。

| 指标 | 基线 | 优化版 |
| --- | ---: | ---: |
| TUI PSS | 482.4 MiB | 108.6 MiB |
| --version 峰值 RSS 中位数 | 508.9 MiB | 112.4 MiB |
| --version CPU 秒中位数 | 3.609 | 0.483 |
| --version 墙钟秒中位数 | 3.037 | 0.326 |
| --help 峰值 RSS 中位数 | 508.0 MiB | 111.0 MiB |
| --help CPU 秒中位数 | 3.607 | 0.469 |
| 后台 PSS 采样范围 | 501.5–544.6 MiB | 542.0–542.3 MiB |
| 后台单核 CPU，10 秒窗口 | 0–5.40% | 0–0.30% |

TUI 减少约 373.9 MiB（77.5%）；CLI 查询峰值内存减少约 78%，启动 CPU 时间减少约 87%。CLI 每条命令重复三次，CPU 是用户态与内核态之和。RSS 与 PSS 不混用。两版 TUI 的 10 秒 CPU 窗口均为 0%，不宣称空闲 CPU 改善。

后台包含启动和垃圾回收波动：基线后段约 502.5 MiB，优化版约 542.3 MiB，反而更高；不能据此证明后台内存下降，也不把短窗口 CPU 差值解释为稳定节省比例。测量不包含登录、活跃 Agent、浏览器或并发业务。早期源码目录的 83% TUI 降幅不作为最终指标。

原始数据：`headless-runtime-results.json`；工具：`apps/cindy-terminal/scripts/measure-headless.py`。

## 真实断线回归

无信号关闭 PTY：基线 5 秒仍存活，需测试器回收；最终包 exit 0，无残留。普通挂断以 SIGHUP 退出；SIGTERM 和 Ctrl-Q 清理后 exit 0。后台始终存活。stdin end/close 和 EIO 单测均先红后绿；最终包无未处理的 EIO，不把信号退出称为 exit 0。

## 验证账本

- typecheck、完整构建、help/version、diff 检查通过；构建有既有 image-resizer direct-eval 警告。
- check-entry-loading.mjs 通过：CLI 静态闭包无 service/React/Ink/TUI，后台无 React/Ink/TUI。
- input、authentication、lifecycle、service-manager、maintenance、shell 六文件 56 项通过，Vitest 9.40 秒。lifecycle 直接通过 Node 运行 Vitest 单独验证：3 项通过，Vitest 3.01 秒、墙钟 3.82 秒，满足 5 秒预算；经 pnpm 启动的早期记录为 5.66 秒。
- 生产 package-runtime 打包及自带原生依赖/help/version smoke 通过；最终独立包从非安装目录启动服务、查询状态并完成 PTY 验证，分块、数据库和 worker 路径可用。
- Linux 宿主/远控集成测试优化前后均为 33 通过、3 失败、1 Windows 专用跳过。未修改源码基线实际复现相同失败：task tags 与 locked vault 两例显式 5000ms 超时；通知文本预期 Finished，实际 Finished private path。未放宽断言、超时或脱敏行为。
- 集成通过项包含真实私有传输、事件、连接恢复、文件服务、数据库重启、附件、加密配置交接、工作目录及客户端释放。
- Windows 同组 33/37 通过，另有三个路径相关失败，不作为 Linux 成功证据。
- check:test-hygiene 失败于五个未修改的 Desktop 基线计数：agent-input-coordinator、orcaWorkerCreationService、deviceProvidersCache、useFeishuBot、WebMicAudioEngine.keepAliveIdle。未修改门禁基线放行；没有声称整仓 CI 全绿。

未执行真实账号的 Desktop/Mobile 端到端操作或模型推理，不能据此声称所有业务组合均已验证。

## 环境和复现

Ubuntu 自带 Node 22.22.1 未编译 TypeScript 支持，原始 TS migration 报 ERR_NO_TYPESCRIPT；正式测量使用打包固定的官方 Node 22.22.0。官方 linux-x64 tar.gz SHA256：`c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744`。向量扩展从本地文件补齐并核对 LFS 哈希；没有修改 native 源码或迁移。引擎及 Electron 下载有网络失败，本次未使用这些引擎推理。

```sh
APP_VERSION=0.1.115 pnpm --filter cindy-terminal build
node apps/cindy-terminal/scripts/check-entry-loading.mjs
CINDY_MEASURE_NODE=/absolute/runtime/node python3 apps/cindy-terminal/scripts/measure-headless.py /absolute/app/dist/cli.js /absolute/resources.json
CINDY_MEASURE_NODE=/absolute/runtime/node python3 apps/cindy-terminal/scripts/measure-headless.py /absolute/app/dist/cli.js /absolute/cli.json --cli-only
```

--lifecycle-only 仅检查断线。诊断/profile 在临时目录，工具只回收自己创建的进程；报告记录失败，不用脚本返回码替代逐项结果检查。

中国大陆版通过 CINDY_AUTH_REGION=cn 构建，build-info 已核对为 cn，启动和全部生命周期 smoke 通过，后台保持存活；正式资源对照为 Global 未登录环境。任何在线替换均不属于本轮交付。

大陆版交付包 SHA256：`7a29142fde65f26d867e6cbc47f7686534d8437e52179403f1924f0cc974486e`。包为本次本地验证构建，不等同于上游正式发行版或已通过完整 CI 的版本。
