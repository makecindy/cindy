# Desktop 单测性能基准

> **读取时机**：调整 Desktop Vitest worker、测试分池或根级单测资源配额前

## 可复现命令

`benchmark:desktop-workers` 复用 `test-workspaces.config.mjs` 中 Desktop unit tier 的
完整排除规则，不会混入 DB、migration、guard 或 `*.bench.ts`。

```bash
pnpm benchmark:desktop-workers -- --workers 1,2,4,8 --runs 1 --output <report.json>
```

报告包含机器信息、墙钟、文件数、测试数、文件耗时 P50/P95/P99 和最慢文件。调整 worker
或分池前后必须使用同一 checkout、同一机器和同一测试范围比较；单次数据需同时保留稳定性
结果，不得只挑最快的一次。

## 2026-07-26 Windows 基线

环境：Windows x64、Node v24.15.0、32 available CPUs、63.8 GiB RAM。测试范围为
1,213 个文件、13,062 个测试。

| Workers | 结果 | 墙钟 | 相比上一档 | 相比 1 worker |
|---:|---|---:|---:|---:|
| 1 | 通过 | 710.6s | — | 1.00x |
| 2 | 通过 | 353.7s | -50.2% | 2.01x |
| 4 | 通过 | 183.5s | -48.1% | 3.87x |
| 8 | 通过 | 108.3s | -41.0% | 6.56x |

8-worker 复跑为 114.9s，说明该档在本机约为 108–115s。2-worker 首次运行曾在 116.7s
触发一次 `ERR_IPC_CHANNEL_CLOSED`，重跑 353.7s 通过；worker 数降低本身不能消除
Vitest/tinypool fork 通道的偶发退出问题。

随着 workers 增加，所有文件自身耗时之和从 247.0s（1 worker）升至 317.5s（8
workers），说明存在资源争用；但墙钟仍持续下降。综合速度、资源和实现复杂度，正式配置
采用单池最多 8 workers；低于 8 CPU 的主机按 `os.availableParallelism()` 自动下调。

## 长尾分布

8-worker 复跑中，最慢 200 个文件按路径聚合：

| 路径 | 文件数 | 文件耗时之和 |
|---|---:|---:|
| `src/main/git-review/**` | 10 | 180.7s |
| `src/main/__tests__/**` | 27 | 49.7s |
| `src/renderer/**` | 92 | 31.8s |
| `src/main/hook-control/**` | 1 | 11.9s |

最慢的单文件主要是创建真实 Git 仓库或子进程的测试：

| 文件 | 8-worker 文件耗时 |
|---|---:|
| `git-review/__tests__/stageOps.test.ts` | 42.1s |
| `git-review/__tests__/pushOps.test.ts` | 28.6s |
| `git-review/__tests__/branchReader.test.ts` | 23.8s |
| `main/__tests__/codexFileRewindExecutor.test.ts` | 23.4s |
| `git-review/__tests__/ipc.test.ts` | 22.0s |
| `git-review/__tests__/diffReader.test.ts` | 19.5s |

因此分池优先按“真实 Git／子进程长尾”和“其余测试”隔离，而不是只按 node/jsdom 环境
机械拆分。

## 分池评估

分池把 21 个 Git／子进程长尾文件放入 `git-io`，其余文件放入 `standard`；两个池并发，
且完整覆盖仍为 1,213 个文件、13,062 个测试。

| 配置 | 结果 | 总墙钟 | 说明 |
|---|---|---:|---|
| 单池 8 forks | 通过 | 108.3–114.9s | PR3 单池基线 |
| 3 forks + 5 forks | 通过 | 126.9s | standard 池成为长板 |
| 2 forks + 6 forks | 通过 | 111.6s | 与单池持平 |
| 2 threads + 6 forks | 通过 | 114.8s | standard 使用 threads 无收益 |
| 2 threads + 7 forks | 通过 | 111.1s | git-io 成为长板 |
| 3 threads + 7 forks | 连续两次通过 | 102.2–103.0s | 最快分池候选 |

另一次 `2 forks + 7 forks` 中，standard 池在 100.6s 完成，但 git-io 池触发
`ERR_IPC_CHANNEL_CLOSED`，因此不作为有效性能样本。

最快分池候选的平均墙钟为 102.6s：

- 相比现有单池 4 workers 的 183.5s，减少 80.9s（44.1%）。
- 相比单池 8 workers 的平均 111.6s，减少 9.0s（8.1%）。
- 但 worker 上限会从 8 提高到两池合计 10，并引入分区维护和双执行器复杂度。

因此分池相对单池 8 workers 的额外 8.1% 收益不足以抵消资源与维护成本，正式配置不采用
分池，保留单池最多 8 workers。
