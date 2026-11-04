# agent-net 验证记录

当前核心的结果与未解决问题见
[`2026-11-03-clock-start/README.md`](2026-11-03-clock-start/README.md)。
更早的目录保留每轮对比、命令、退出码和源码指纹，不能当成当前版本的结果。

为便于跨机器继续工作，归档记录中的个人主目录已替换为 `<home>`，临时工作目录
已替换为 `<scratch>`；复跑时使用新机器上的实际目录。测试数值、命令参数和源码
指纹保持原样。构建产物和仅供对照的 KCP 下载源码不随 Git 提交；首次运行 KCP
对比前，在 `packages/agent-net-core` 执行 `sh sim/fetch-kcp.sh`。
