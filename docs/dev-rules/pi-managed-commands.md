# Pi 管理命令适配

2026-09-09：按本地 Pi 0.84.4 README、docs/packages.md、docs/rpc.md，以及上游
[v0.85.1 package-manager-cli.ts](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/package-manager-cli.ts)
核对。

## 命令范围

| CLI 输入 | 执行语义 |
|---|---|
| `pi update`、`pi update self`、`pi update pi`、`pi update --self` | 仅内核 |
| `pi update --self --force` | 强制安装当前官方版本 |
| `pi update --all`、`pi update --self --extensions` | 按原生顺序更新包，再更新内核 |
| `pi update --extensions` | 上游批量包更新，保留原生 pinned source 语义 |
| `pi update <source>`、`pi update --extension <source>` | 复用已有单包服务 |
| `pi install <source>`、`pi remove <source>`、`pi uninstall <source>` | 复用已有安装、移除服务 |
| `pi list`、`pi --version`、`pi --help`、`pi <管理子命令> --help` | 受控查询；list 隐去安装目录及 URL 凭证 |
| `pi config` | 明确提示需要交互式 TUI，指向既有包设置入口 |
| `pi update --models` | 明确未适配 Cindy provider 目录，不能对无 provider 的包 home 刷新后宣称完成 |

项目级 `-l/--local`、`--approve/-a` 不在本范围；明确报错，不扩大 project trust。
`--no-approve/-na` 保留。未知参数、混合目标、缺少 source、多条 shell 命令明确报错，
不再把未知 flag 静默解释为 package source。按字面参数解析，不执行 shell expansion。

这不是全体 slash 命令放行。`/compact`、`/model`、`/session` 等维持 Cindy 原有生命周期
所有权；Pi RPC 的 get_commands 也不包含原生 TUI 内建命令。`/pi ...` 仅为本管理入口的
完整文本别名，既有经 runtime 证实的扩展 slash 路径保持不变。

## 单一 Host 服务与兼容

`cindy_pi_command` 为管理入口，接受不带 pi 可执行文件的 argv 数组。旧
`cindy_pi_extension` 名称和 action/source 调用保留，注册相同执行体；两者沿既有带
runtime token 的私有 UI channel 到同一个 `mutatePiManagedPackage` Host 服务。
直接用户命令也调用该服务。请求在 Host 解析为包操作或带 kind 的内核/查询操作。

Full Access 使用通用档位，不再增加包审批；Ask/Auto、任务关闭、渠道策略仍沿原有边界。
不增加账号能力、远端本机文件访问或新的 device-link 通道。SSH/Review 保持没有本机管理
工具；设备互联继续使用原来的任务输入与工具批准链，不新增专属 UI。

## 独立二进制内核更新

[上游 config.ts](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/config.ts)
对 bun-binary 的 getSelfUpdateCommand 返回 undefined；0.84.4 同样如此。
因此只接上 native CLI 无法让 Cindy 的独立分发完成更新。

先执行上游命令。只有上游明确返回不支持当前安装形态的自更新，Host 才下载官方
GitHub release 对应平台资产，要求官方 SHA-256 digest，复用现有下载器和受限解包器。
新目录在激活前执行真实 `--version`，移动到最终目录后再次核验，再写 `.verified`。
运行中旧目录不覆盖、不删除；新启动的 Pi 进程现读 Host 的 ready binary 路径。
这不是修改 pin/CDN，也不需要更新当前调用进程才能回传结果。

内核及批量命令不走单包 retirement callback；内核结果标注新进程生效、旧任务保留。
单包生命周期仍归现有服务及另一项 P0 治理；本改动无未合分支依赖。
原生成功与 Host 分发成功分别记录 execution，不能把后者伪称原生命令成功。
版本真值始终来自可执行文件，移除按目录名读取及永久 promise 缓存。

## 验证与边界

定向测试覆盖：语法/别名/冲突、直接命令与工具调用共享服务、Full Access 初始及热切换、
普通动态 shell 不误判、原地更新后版本变化、独立目录安装、失败保留旧目录、摘要缺失及
URL 越界拒绝。Windows 安装布局使用平台注入测试，不声称 Windows 真机通过。

可选公网 smoke：`CINDY_PI_BINARY_UPDATE_SMOKE=1 pnpm --filter desktop exec vitest run
src/main/agent-binaries/__tests__/pi-self-update.test.ts`。仅临时目录，无本机用户配置或凭证；
Vitest 无 Electron net，因此 smoke 用 Node fetch + SHA-256，实际解包与版本探针使用
生产实现。生产 Electron 下载器仍由既有套件验证。当前运行的 Cindy/Pi 没有升级。

工具 schema/描述发生一次稳定变化；不改 system prompt 拼接顺序、provider/model 路由、
usage 或逐 token translator。mocked RPC 测试检查命令回执进入原有消息流且调用者保持存活。
未启动 dev、未调用付费 API，未实测模型选择工具的成功率、真实 prompt cache 或响应延迟。
UI 仅同步五语 Full Access 说明；沿用既有双主题组件，Light/Dark 均未进行实机目检。

### 测试环境

全量关联门禁需要安装 Electron 产物与当前 Node 对应的 better-sqlite3 原生绑定。
技能链接夹具的 appData/userData 必须放在独立临时根，避免共享测试目录的技能锁
影响验证；保留真实锁与全部链接断言。shutdown 的 deferred 夹具使用实际需要的
Promise<void>，不声明未使用且不安全的可选泛型参数。
