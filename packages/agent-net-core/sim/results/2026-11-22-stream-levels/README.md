# 八档优先级、放弃流、进展统计（2026-11-22）

核心指纹 `4fe33d993837`（算法同上一轮：`src/*.rs` 按 LF 逐个 SHA-256，按 `sha256sum` 的格式排好再取 SHA-1），逐文件见 `source-sha256.json`。
对照的是主干核心（指纹 `815d083b7cfe`）。改了 `src/stream.rs`、`src/connection.rs`、`src/secure.rs`、`src/lib.rs`、`wasm/src/lib.rs`、`wasm/node.mts`、
`sim/tests/streams.rs`、`sim/mutants.py`、`README.md`；`prebuilt/core.wasm` 和 `prebuilt/manifest.json` 按新源码重编（368255 → 377099 字节，多了 5 个导出，
原有导出的函数和参数不变）。核心 `[dependencies]` 仍为空，**线格式不变**。

这是[会话层 v2](../../../../../docs/agent-net-session-plan.md) 第 7 节第 1、3、5、6 项（v2-1），第 2 项核对后不改。

## 做了什么

1. **八档优先级**（`Priority` 从三个变体的枚举换成 0–7 的档，`PRIORITY_LEVELS`）。原来的 `Interactive`、`Normal`、`Background` 留作常量，
   是其中的 1、3、6。调度、按档防饿死、发送缓冲按档预留都只看档的先后，所以只用这三档时和只有三档时逐个分片相同（见下面的矩阵）。
   原来只认 `Interactive` 的三处（不等发送节奏、窗口里给它留一份、混合流量里算交互一方）改成 `is_urgent`：0、1 两档。会话层的 P0–P4 用 0–4 档。
   优先级不上线，两端各用各的档。
2. **放弃一条流**（`abandon_stream`）：写进来还没切成分片的字节丢掉，流随即结束（马上切一个带结束标记的分片）。已经发出、还没确认的分片照常重传。
   没有加新帧：旧版核心遇到不认识的帧会把整个包当坏包丢掉，连同里面的数据和确认；全连接共用分片序号，又不能简单地不再重传。试想过把作废的分片
   换成只有流头的空分片重传（旧版会把它当成空数据，照样往后交付），但对端可能已经收到覆盖原分片的校验包，拿空分片去算别的缺失分片会算错，所以没做。
   对端看到的是一条提前结束的流，内容全不全由上层看（会话 v2 的头里写着正文长度）。
3. **进展统计**：`stream_progress`（一条发出的流累计被确认的字节、还在缓冲里的字节、有字节在等时多久没有字节被确认）和 `send_progress`
   （每一档还在发送缓冲里的字节、整个发送方向多久没有进展）。确认都在收到包时处理，用收包的时刻记进展；一条流没有字节在等时开始写，
   从写入那一刻起算。
4. **驱动**：WASM 多了 `conn_open_stream_level`、`conn_set_level`、`conn_abandon`、`conn_stream_progress`、`conn_send_progress`，
   `node.mts` 按导出在不在判断，旧的预编译包上不报错；手机原生库见 `packages/agent-net-native` 的 `stream-levels`。
5. **流数上限（第 7 节第 2 项）没改**：两端都已及时回收（发送端结束标记被确认后删，接收端读完即删），流号不复用；旧版收到第 65 条同时存在的流会丢掉
   它的分片，所以放宽要等对端声明会话 v2，由会话层把同时开着的流控制在 64 条以内。

## 结果

**原有矩阵**：大数据夹着小请求（`exp_mixed.rs`，取自 `2026-11-19-priority-buffer/exp`，8 MiB，12 个种子，9 条线路，单独、普通流小请求、交互流小请求三列），
主干与改后逐行相同（`matrix/before-mixed.txt`、`matrix/after-mixed.txt`）。单连接对比、一阵一阵、起速和共享矩阵只走默认流，不经过这次改的调度和进展记账，没有重跑。

**本机回环、真实时钟**（`muxperf`，127.0.0.1 不加损伤，主干与改后交替各跑两次，每次 3 轮、每种情况 10 秒，`runs/muxperf-loopback.txt`）：
三种情况（只有交互消息、消息和文件走两条连接、走一条连接的两条流）上下行的交互往返 p50 两边都是 1.1–1.6 毫秒，p99 2.1–4.1 毫秒，
全部回了；回环上文件速度两边都在 0.4–0.6 Gbit/s 之间来回跳，不作比较。跑的时候本机同时在跑变异检验，两边一样受影响。

**测试**：`cargo test --profile sim --workspace` 全部通过（149 个，2 个按原设计忽略，`runs/tests.txt`）。新增 `sim/tests/streams.rs` 的 3 个：

- `every_level_sends_by_number_and_none_starves`：八档各一条 48 KiB 的流同时写、同时结束，2 Mbit/s、往返 40 毫秒；数小的先收完，最低档也收完。
- `abandoned_stream_drops_unsent_bytes_and_finishes`：后台流写进约 900 KB，100 毫秒后放弃，对端收到的正好是放弃前发出去的那部分，再收到结束；
  旁边的普通流照常收完；之后流不在了，再放弃返回 `None`。每一步都核对发送缓冲的账目。
- `progress_reports_stalls_and_acknowledged_bytes`：写 20 KB 后断网 1.5 秒，流和发送方向的停顿都过了 1.4 秒、确认字节为 0；通了以后确认字节增加、
  停顿回落到 0.5 秒以内；全部确认后发送方向停顿为 0、流不在了。

`packages/agent-net` 的 `native.integration.test.ts` 在真实 WASM 与真实原生 C ABI 之间加了两段：原生库按第 5 档开流、写 512 KB 后马上放弃，Node 收到的
正好是写入减去丢掉的部分；Node 按第 5 档开流写 2 MiB，确认过 100 KB 后放弃，原生库读到的正好是写入减去丢掉的部分；两边都在放弃后收到结束。

**变异检验**：`sim/mutants.py` 新增 3 条（八档里数大的反而先发、放弃后没发的字节照发、确认了字节不算这条流有进展），结果见 `runs/mutants.txt`。

## 没做的

- 第三层真实公网对比没有做：线格式不变，只用原来三档时调度逐个分片相同（模拟器矩阵逐行相同、回环相同）。
- 会话层还没用上这些接口（会话 v2，下一步）。手机原生库的 `stream-levels` 随下一次原生包（冷更新）生效。

## 复现

```text
cargo test --profile sim --workspace
PYTHONIOENCODING=utf-8 python -X utf8 sim/mutants.py 流：
cp sim/results/2026-11-19-priority-buffer/exp/exp_mixed.rs sim/tests/        # 实验，跑完删掉
AGENT_NET_BULK_MIB=8 AGENT_NET_SEEDS=12 cargo test --profile sim -p agent-net-sim --test exp_mixed -- --nocapture
```

主干的对照：把主干的 `packages/agent-net-core` 导出到别处（`git archive origin/main packages/agent-net-core`），放进同一个 `exp_mixed.rs` 跑同一条命令。
