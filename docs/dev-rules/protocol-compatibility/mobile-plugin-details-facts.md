# 移动插件 Details 事实

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

同一 plugin-capabilities.data 可选追加 details（key/title/value 数组），由本插件 InstalledGhost
投影 PC 同源版本、作者、签名来源、标识、包含能力与面板声明。签名标签复用 shared ghostTrustLabelKey，
不传签名文件、批准记录或密钥标识，不用作者自报推断官方。安装目录按用户明确要求单独只读投影本插件
的 ghost.dir，仅走原同账号、当前 owner 的资源通道；不提供路径写入或文件操作，不扩 IPC 白名单。
当前 PC 窗口的停靠位置不在此声明投影内，有面板只报告存在，无面板沿用 PC 文案。
旧 Host 缺字段时新手机仅显示原有 Version 与资源 Identifier，说明其余数据未提供；旧控制端忽略新增字段。
服务端、relay、协议版本及原生 fingerprint 均不变。
