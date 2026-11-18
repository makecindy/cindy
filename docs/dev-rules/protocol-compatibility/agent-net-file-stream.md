# 文件直传走 Agent-Net 会话（2026-11-17）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项约定。
> 会话层本身见 [Agent-Net 会话层](agent-net-session.md)。

两台都开着 Agent-Net 的同账号 Desktop 之间，原来文件直传（文件浏览下载、附件、视频按段播放、文件夹下载、迁移任务、发插件包）
只有建连消息走会话，文件字节仍走 WebRTC，还要从服务端取 TURN 设置。现在文件字节也走会话，不再起 WebRTC。

- **协商**：被控端在 `device-link:file-peer` 的 `caps` 回答里多带 `streamTransport: true`。控制端只有在对方带了这一项、而且和
  对方有会话（同账号、两边都开着 Agent-Net）时才用；否则（旧版 Desktop、旧版手机、没开 Agent-Net、跨账号）照旧 WebRTC。
  手机 2026-11-18 起同样用（`apps/mobile/src/device-link/peerFileTransport.tsx`）：会话连接的动作不进 WebView 里的 WebRTC 运行时，
  在 RN 里经同一个调用通道发；块按顺序写进同一个文件句柄、同一套检查，会话断开时收掉（`resetMobilePeer`）。回归
  `apps/mobile/src/__tests__/peerFileLifecycle.test.tsx`「downloads over the Agent-Net session when the computer offers stream transport」
  （去掉会话分支时会取 ICE、发 offer）。真机还没测。
  旧版被控端不会收到下面三个新动作。
- **三个新动作**（同一通道，`packages/device-link/src/filePeer.ts` 解析与限值）：
  - `stream-open`：建一条不经 WebRTC 的文件连接，回 `{ connection }`；和 `offer` 一样占四条连接的名额、带 `sessionBound`。
  - `stream-rpc`：原来数据通道里的 RPC（`payload` 是同样的 `{channel, args}`，`body` 是附件块的 base64，最多 1 MiB），
    被控端走同一个处理函数与同一套检查；`timeoutMs` 让调用方按需等待（大附件收尾要重算摘要），上限 1 小时，和数据通道一样。
  - `stream-read`：按顺序取一个票据的下一块，每块最多 256 KiB；控制端同时有 4 块在路上（和数据通道的 1 MiB 窗口一样），
    被控端按到达顺序一块一块读；最后一次 0 字节的读让被控端关掉源文件。
- **不变的检查**：每个请求都先过 `touch`（允许被控、撤销名单、数据所有者），只认这条连接的发起方；票据、偏移、文件改动
  检查和 WebRTC 路径共用同一个函数（`readSource`、`writeSink`、`serveRpc`）。跨账号对端不走文件直传，和原来一样。
- **会话上的编码**：`stream-read` 的结果不进结果缓存、不算标记，走后台通道（`isFilePeerStreamRead`），免得把列表的缓存挤掉、
  挡住普通请求。base64 比原始字节多三分之一。
- **被控端的准入与去重**（2026-11-17 review）：文件块（`stream-read`、`stream-rpc`，`isFilePeerStreamTransfer`）不进被控端的重复请求
  记忆（会话不重发，块又多又大，会把别的控制端非幂等调用的记录挤掉）；在「每个控制端在途 4 MiB」之外另有 4 MiB 额度：上传一次
  在途 3 块、每块 base64 约 1.4 MB，原来第三块单独就超限，整个上传以 BACKPRESSURE 失败。总在途上限不变，每条连接同时只有一个上传。
- **走哪条路按这次调用实际走的路**：控制端只在发给对方的调用确实走会话时（`outboundOnSession`）才让字节走会话；Device Link 上还留着
  这个对端的链路时调用照旧走 Device Link，字节也照旧走 WebRTC，不会把整个文件按块经 Device Link 发。
- **复用连接用这次传输自己的调用**：会话上的文件连接按传输复用，块走这一次传输的调用（`receivePeerFile` 每次换上）。原来一直用打开它的
  那次传输的调用；那次一结束它的调用就报 FILE_PEER_CANCELLED（`fileAccess.ts`），紧接着的下一次下载立即失败、进 30 秒冷却、改走云端中转。
- **上传的块同一个通道、按顺序到**：附件块写入（带块内容的 `stream-rpc`）和 `stream-read` 一样一律走后台通道。原来按大小分通道，
  1 MiB 的块走后台、最后一小块走普通通道，越过前面还在路上的块先到，按顺序追加的接收端报 FILE_PEER_BLOCK，整个上传改走云端中转。
- **随会话收掉**：会话上开的文件连接带 `sessionBound`，被控端没有空闲计时器（WebRTC 的随数据通道关闭）。会话一断，两端都收掉
  这个对端在会话上的文件连接（`stopFilePeerStreams`，不再发关闭通知）；原来控制端重启或断了会话，被控端就留下一条，攒满四条后
  这台电脑上所有文件直传都报 FILE_PEER_BUSY。
- **自建中转**：不涉及中转协议，不需要递增 `RELAY_VERSION`。
- **日志**：`stream-read` 成功不逐块记日志（100 MB 就是 400 行），失败照记；会话上的连接没有数据通道缓冲可看，
  不起发送端的排空监测，「send done」就是结束。
- **真机（2026-11-17，Windows ↔ macOS，同一个 XD 账号，官方 Agent-Net）**：3 MB 预览取件 22 毫秒建好连接、148 毫秒传完；
  「下载到本地」100 MB 9.4 秒（约每秒 11 MB，同一文件走云端中转 19.7 秒）；文件夹下载由对方把打好的包经会话推回来。
  三次内容哈希都和源文件一致，日志里没有 WebRTC。媒体预览超过 64 MB 照旧走云端中转按段取，这是原有的设计，和 Device Link 一样。

- **真机复验（2026-11-17 下午，同一组电脑，这一轮所有修复与传输核心窗口改动之后）**：3 MB 之后紧接着 100 MB，同一条会话连接，
  138 毫秒与 4.3 秒（每秒约 24.5 MB，和上午一样，窗口改动没有变慢）；文件夹下载（45 MB）对方经会话推回来 1.45 秒（每秒约 32 MB），
  48 个块全部写入、没有 BACKPRESSURE，整次 3.3 秒；内容哈希都一致。上面两个问题都是这次复验里发现的，修之前分别是紧接着的 100 MB
  走云端中转 20.8 秒、文件夹 11 秒（上传失败后走云端中转）。被控端没开「允许被控」时对方推不回来、照旧走云端中转，和 Device Link 一样。
- **第二次 rebase 后的对比（2026-11-17 晚，同一组电脑，每轮都用新生成的文件；XDMini 负载很高，1 分钟平均负载约 24）**：

  | 同一组操作 | Agent-Net 开 | Agent-Net 关（Device Link） |
  |---|---|---|
  | 建链 | 15 毫秒 | 77 毫秒 |
  | 列任务 | 25 毫秒 | 74–82 毫秒（经中转） |
  | 100 MB 下载 | 5.6 秒（会话，每秒约 19.5 MB） | 9.3 秒（WebRTC 这次打通了直连，每秒约 12.6 MB） |
  | 文件夹 45 MB（对方推回） | 3.3 秒（会话，传输 2.3 秒） | 5.0 秒（WebRTC，传输 3.5 秒） |

  内容哈希都一致；Agent-Net 关着时走的是原来的路径（中转帧与 WebRTC），没有会话。再打开不用重启，回到直连加密。

回归：`apps/desktop/src/main/device-link/__tests__/filePeer.test.ts`「carries a download and an upload over the Agent-Net session
instead of WebRTC, with the same checks」（不开采集窗口、不取 TURN；块数、上传块的原始字节；撤销后不再给字节），关掉会话路径时失败；
`packages/device-link/src/__tests__/filePeer.test.ts`（新动作的限值）；同一 Desktop 文件「ends a peer's session file connections with its
Agent-Net session and frees their slots」与「carries the next download on a reused session connection with that download's own calls」；
`agentNetSessionLinks.test.ts`「keeps the blocks of one upload in send order on the background lane」；`apps/desktop/src/main/__tests__/deviceLinkDispatch.test.ts`「会话上的文件块整窗在途时都被执行」
（不加额度时只执行两块）。

## 无链路推送也走会话

允许被控请求、插件同步、语音词典快照这三个不需要控制链路的同账号推送，有会话时走会话（`packages/agent-net/src/session/sessionRouting.ts` 的 `sendPush`），
否则照旧 Device Link 的无链路推送。同时会话上收推送和 Device Link 一样：只在本机开着的控制链路上收，只有这三个通道例外
（`isUnlinkedPushChannel`）。原来会话上什么推送都收，同账号的一台电脑没建链也能往这台的业务里推任意通道。
回归：`agentNetSessionLinks.test.ts`「takes pushes only on a control link except the unlinked ones」。

## 远程桌面的续租与输入走控制通道

远程桌面通道里，续租心跳、键鼠输入（WebRTC 输入通道不通时的兜底）和停止走会话的控制通道，截图、SDP 照旧走普通通道
（`agentNetRequestLane`）。回复沿用请求的通道。画面、声音和输入本身仍走 WebRTC（用户 2026-11-17 确认保留）。
会话断开时远程控制随之结束、只看不控的后台观看可以继续，这是有意的安全规则（信号断了被控端没法再确认这次控制），
和 Device Link 中转断开时一样，没有改。
