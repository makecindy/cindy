# 前置检查的 xdt-node 运行器

xdt-node 使用随安装包提供的真实 Node。RunAsNode、NodeOptions 和 inspect fuse 继续关闭。普通 node、python 或 shell 命令仍按原退出码协议执行。

## 脚本协议与旧脚本迁移

xdt-node 的脚本必须在实际检查正文中回报开始，并在检查结束后回报最终结果。旧脚本只 exit 0/2 会被阻止；文件与配置不会自动改写。通过检查脚本安装工具或 UI 的修改流程审阅并更新脚本，再看安装自测结果。ESM 示例：

~~~js
const gate = process.env.CINDY_PRE_RUN_GATE_CLIENT
  ? (await import(process.env.CINDY_PRE_RUN_GATE_CLIENT)).default : null;
if (gate) await gate.enter();
// 在这里执行并等待实际检查；异常应抛出，不要声明完成。
const code = 0; // 0 放行，2 跳过
console.log('CINDY_PRECHECK_OK'); // 只在完整健康检查后输出
if (gate) await gate.complete(code);
process.exit(code);
~~~

CJS 可在 async 函数中使用同一动态 import 和 await 调用；未捕获异常必须保持非零退出。协议模块只在正文加载时提供 API，加载本身不发回报。fork 的 PID 与主进程不同，Worker 客户端拒绝回报；nonce/ack 只隔离本轮，不构成恶意同进程代码的安全沙箱。

只有 entered、completed、真实 Node 退出和 shell 退出一致为 0 或 2，且无超时/取消/协议错误，才放行或跳过。它不能证明任意业务判断正确或所有外部副作用都完成；completed 是脚本明确作出的完成声明。任何 stdout 文本、preload 完成或单纯 exit 0 均不代替协议。

## 支持范围

- 普通 .mjs/.cjs/.js、Node CLI argv、CLI/NODE_OPTIONS 的 ESM/CJS preload、conditions 由真实 Node 原生解析。不会重放 preload、移动参数、注入内部 --import/-r 或改变捕获的 parent URL/cwd。process.execPath 是真实 Node 文件。
- 新增正文协议的 await 会让事件循环继续运行，因此不承诺用户 timer 与未接入协议的旧脚本具有相同先后顺序。preload 的异步 exit 即使发生在 enter/complete 握手期间，也只能让该轮被阻止，不能制造有效完成。
- -e、-p、--input-type 保留原生参数，源码仍需显式协议。stdin 仍接收原 JSON 上下文；因此 node - 使用 stdin 作为程序源码与上下文输入冲突，不能当成已支持的组合。该既有冲突不会用临时脚本替代来掩盖。
- permission 参数不扩权。若限制读取协议模块，需用户明确允许该文件；业务文件权限不会代办或放宽。旧别名仅在实际 Node 支持时可用。loader/addon 仍由原生 Node 处理，尚不保证所有第三方组合。
- 系统 shell 解释剩余命令，业务 fd3 不作为控制通道；supervisor 的私有报告 fd 不继承给 shell。Node 失败不能被后续 ; true 掩盖；exit2 被 shell 改成0会报告冲突。单轮只允许一个受控 Node 根调用；后台化、多根或缺完成证明均阻止。任意嵌套 xdt-node 识别不在原前缀契约内。

## 运行资产与进程归属

forge prePackage 使用共享 Node pin、现有下载/哈希/解压基础设施准备目标平台文件。缺资产、下载/哈希/编译失败会阻止打包；运行期间不下载、不安装、不改全局 PATH。完整上游 Node LICENSE 随目标资源一起分发。Make 和 scheduler 共用 apps/desktop/resources/node-runtime-artifacts.json。

afterCopyExtraResources 在包内副本先校验目标 host 的完整文件与 pin manifest，再移除其他 host 和陈旧暂存目录；源码的多架构缓存和其他 tools 保留。目标不完整时，在删除任何代次前阻止打包。

macOS 的 ad-hoc 与 Developer ID 签名均在通用 tools 签名后，使用 standalone Node 专属的 allow-jit entitlement 重签目标 Node；不授予主 App 的 Apple Events、Keychain、音频或 library-validation 豁免。签后 strict 校验失败阻止产出；本机架构另外执行签后的 Node JIT smoke（清除构建者 NODE_OPTIONS，10 秒超时），跨架构只验签并明确记录未执行。签前 packaged smoke 不能替代这项签后检查，也不能替代真实签后 gate 的平台验收。

新增 native/pre-run-node/supervisor.c 无第三方 native 依赖：POSIX 使用 cc、pthread、进程组和 Unix peer PID；Windows 使用 MSVC C11、仅当前执行账号的 named pipe、挂起创建并绑定 KILL_ON_JOB_CLOSE Job Object 后恢复。Windows 构建需在目标 Windows SDK/MSVC 环境，Linux 同架构构建，macOS 可用 -arch 选择架构。不复用远程桌面的服务、提权 token 或插件 broker。

POSIX 超时/取消终止本轮 shell 进程组；主动 setsid 脱离组的用户子进程不在此保证内。Windows Job 禁止 breakaway；Windows/macOS x64/Linux 的真实运行与签名/TCC仍需对应实包验收。仅源码实现不等于这些平台已验证。

## 验证分层

默认 unit 保留纯结果/协议合同与一条真实 Node/stdin smoke。完整 CLI/preload/permission/长临时路径/fork/Worker/fd/取消/树杀矩阵进入 Desktop 已声明的 manual/exclusive integration tier，串行单 worker；它不由当前默认 CI 自动执行。资源准备与客户端回归必须分别记录命令、退出码、平台及缺项，不把源码扫描或 compiler success 当成实包验证。
