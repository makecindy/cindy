# 远程桌面退出与断线锁屏

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

远程桌面的 `start` / `heartbeat` 可追加布尔 `lockOnExit`。新版 Desktop 与 Mobile
提前同步退出锁屏策略，被控端在本机断开、信令断开或现有心跳过期时本地执行锁屏；
存活连接的 resume / takeover 和显示器切换不触发。锁屏期间重复断开或心跳过期
不能取消锁屏，撤权与认证身份变化仍可取消。旧请求缺少字段时保留原行为（旧手机的
`privacyScreen.lockOnExit` 继续兼容），新字段优先于该隐私屏幕附带偏好。
旧被控端忽略新字段，主动退出仍发送原 `stop.lockScreen`；断网兜底需要被控端升级。
不带 `lockScreen` 的协议 `stop` 仍用于重连和切显示器的清理，不执行锁屏。
Desktop 本地关窗不等待远端停止回执，后台清理只作用于原 peer / lease，不重置共享链路。
此扩展沿用已有业务通道，不改变 relay、服务端协议或权限范围。
