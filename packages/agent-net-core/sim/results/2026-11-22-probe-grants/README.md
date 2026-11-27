# 回探测的确认带上所有流的额度（2026-11-22）

核心指纹 `0256935c2e06`（算法同 `2026-11-22-stream-levels`：`src/*.rs` 按 LF 逐个 SHA-256，按 `sha256sum` 的格式、按文件名排好再取 SHA-1），
逐文件见 `source-sha256.json`。对照的是主干核心（指纹 `abd8f90ecb34`）。改了 `src/connection.rs`、`sim/tests/streams.rs`、`sim/mutants.py`、
`README.md`；`prebuilt/core.wasm` 和 `prebuilt/manifest.json` 按新源码重编（378584 → 378620 字节，导出不变）。核心 `[dependencies]` 仍为空，
**线格式不变**。

## 查到的问题

会话 v2（[协议记录](../../../../../docs/dev-rules/protocol-compatibility/agent-net-session.md)「会话 v2」）把大消息放在自己的流上，一条连接上
它是第 6 条流（数据、控制、三条通道之后）。CI 的原生互通测试在三个系统上都失败：电脑回给手机的 1 MB 结果收到 163122 字节后不再有字节，
15 秒后报停住。临时加的诊断显示电脑端还积着 893 KB、手机引擎没有可读的数据——发送端停在新流初始的 128 个分片额度上，一直没拿到新额度。

额度跟着确认出去，一个确认最多带两条流（`MAX_GRANTS_PER_PACKET`），按流号从小到大挑还要重发的。发送端等额度时发探测，接收端收到探测
把每条流都标成要重发一次——回它的确认带的还是编号最小的两条。新流最初那三份额度只要没送到（这次是手机轮询慢：探测和 128 个分片同一批到，
回的第一个确认就被前两条占了），之后每个探测换来的确认都一样，第 6 条流永远轮不到。本机把手机引擎的每次调用推迟 5 毫秒就能复现（3/3），
CI 机器上不推迟也必现。

这个问题在核心里早就有，只是 v1 的通道流都在连接刚建好时开、最初的额度早送到了，碰不上。

## 改了什么

收到探测时记一下（`grant_all`），下一个确认带上放得下的所有流的额度，不受两条的限制；平时的确认照旧最多两条。一个包放得下一百多条
额度帧（每条 9 字节），核心每条连接最多 128 条流。只有回探测的确认变长，探测本来就少。

另试过「每个确认从上一个带到的流后面接着轮」：同样能补回来，但第 6 条流要等第三个探测，比回探测时全带慢（见下），没有采用。

## 验证

**新增测试**（`sim/tests/streams.rs`）`a_later_stream_gets_its_lost_credit_back`：先开 5 条流各发一点、额度都送到；再开一条流发 1 MiB，
开头 100 毫秒回来的确认全丢（最初的额度跟着丢），之后线路正常。

| 核心 | 结果 |
|---|---|
| 主干 | 30 秒后仍停在 161636 字节（128 个分片） |
| 只按顺序轮着带（试过、未采用） | 确认恢复后 1.36 秒传完 |
| 本次 | 确认恢复后 0.42 秒传完 |

测试要求确认恢复后 1 秒内传完。

**变异检验**：`sim/mutants.py` 新增「流：回探测的确认只带两条流的额度」（去掉 `grant_all = true`），被上面的测试抓到。

**原有矩阵**：大数据夹着小请求（`exp_mixed.rs`，取自 `2026-11-19-priority-buffer/exp`，8 MiB，12 个种子，9 条线路），主干与改后逐行相同
（`matrix/before-mixed.txt`、`matrix/after-mixed.txt`）。

**测试**：`cargo test --profile sim --workspace` 全部通过（151 个，2 个按原设计忽略）。

**真实原生库**（本机回环 UDP、真时钟）：`packages/agent-net/src/__tests__/native.integration.test.ts`「carries sessions on the real native engine…」
的一种构建改成每次调用晚 5 毫秒回来。旧核心编出的原生库上 3/3 停住，新核心 5/5 通过（推迟 3、5、8 毫秒）；把新核心的 `grant_all = true`
去掉、原生库照样报告 `probe-grants` 时 2/2 停住。

**没有重跑**：单连接对比、一阵一阵、起速、共享矩阵和公网。改动只在收到探测后的那个确认里多带额度帧，不影响默认流、发送节奏和拥塞控制；
上面的矩阵和原生互通测试覆盖了多条流的场景。

## 兼容

- 线格式不变：多出来的额度帧旧版照常解析。
- 旧版接收端（Desktop 旧版本、旧安装包里的手机原生库）仍有这个问题。Desktop 与 Node Host 的核心随 JS 一起发布；手机的原生库随安装包，
  所以原生库多报一项 `probe-grants`，手机 JS 只在有它的引擎上用会话 v2 的正文流，否则照 v1（`packages/agent-net/src/nativeTransport.ts` 的 `bodies`）。

## 复跑

```sh
cd packages/agent-net-core
cargo test --profile sim --workspace
PYTHONIOENCODING=utf-8 python -X utf8 sim/mutants.py 流：回探测
cp sim/results/2026-11-19-priority-buffer/exp/exp_mixed.rs sim/tests/        # 实验，跑完删掉
AGENT_NET_BULK_MIB=8 AGENT_NET_SEEDS=12 cargo test --profile sim -p agent-net-sim --test exp_mixed -- --nocapture
```

主干的对照：把主干的 `packages/agent-net-core` 导出到别处（`git archive origin/main packages/agent-net-core`），放进同一个 `exp_mixed.rs` 跑同一条命令。
