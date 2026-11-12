# agent-net 验证记录

当前核心的结果与未解决问题见
[`2026-11-05-port-change/README.md`](2026-11-05-port-change/README.md)（只换端口时不重新测速；换网后安静探测不再翻倍）。
按最终代码复跑的单连接和共享矩阵、与上一轮的对比、公网换端口新旧对比都在这个目录里。上一轮是
[`2026-11-05-shared-shallow-queue/README.md`](2026-11-05-shared-shallow-queue/README.md)（多条连接挤浅队列），
换地址和真机 UDP 的结果见 [`2026-11-05-migration/README.md`](2026-11-05-migration/README.md)（第 5 步）。
更早的目录保留每轮对比、命令、退出码和源码指纹，不能当成当前版本的结果。

为便于跨机器继续工作，归档记录中的个人主目录已替换为 `<home>`，临时工作目录
已替换为 `<scratch>`，仓库所在目录已替换为 `<repo>`；复跑时使用新机器上的实际目录。测试数值、命令参数和源码
指纹保持原样。源码指纹按 LF 行尾计算，Windows 上 Git 检出成 CRLF 时要先换回 LF 再算。
构建产物和仅供对照的 KCP 下载源码不随 Git 提交；首次运行 KCP
对比前，在 `packages/agent-net-core` 执行 `sh sim/fetch-kcp.sh`。
