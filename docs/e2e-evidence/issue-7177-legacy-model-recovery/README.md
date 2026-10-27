# #7177：接受已保存模型的旧状态恢复验证

日期：2026-10-26。代码基线 `806b459005cbf21fb40721d35af91ff7e7f776c6`，包含 #6759 和 #6950。
修复位于本记录所属提交；推送后的运行回归另行记录其源码 SHA。

## 问题与修复

旧包 0.1.115 的例行模型恢复会按本机目录校验旧来源；已合并修复补齐了共享执行位置和永久保存的版本标记。
剩余缺口是存量无版本标记的恢复记录：即使永久配置已经保存，普通发送仍先尝试恢复旧来源。
本次复用 `local-db:bots:update`，用 `acceptSavedModelSelectionVersion` 显式接受已读取的永久选择。
同值接受也校验可用性、取得发送锁、在原事务中推进版本并写恢复标记；切换未就绪时保留标记。
现有伙伴工具显式提交完整 `modelChain` 同样走此分支；普通改名不改变恢复状态。

没有新增数据库 migration、IPC channel、UI 按钮或自动 fallback。

## 自动化验证

| 检查 | 实际结果 |
| --- | --- |
| 修复前最小回归 | exit 1：接受后版本仍为 1，预期为 2 |
| 四个相关文件 | 765 通过、1 失败；新增测试误用返回字段 `displayName`，已改为真实字段 `name` |
| 修正后两项新增回归 | exit 0：2 通过；70.51 秒，其中测试体 522ms，现有大文件收集 68.19 秒 |
| `pnpm check:test-hygiene` | exit 0 |
| Desktop 等效类型检查 | exit 0，615.72 秒，无 TypeScript 诊断 |
| `git diff --check` | exit 0 |

四文件命令：

```sh
pnpm --filter desktop exec vitest run \
  src/main/localDb/ipc/__tests__/botCanonicalSession.test.ts \
  src/main/localDb/worker/opHandlers/__tests__/botTx.test.ts \
  src/main/maker-ipc/__tests__/botModelRouteReconciler.test.ts \
  src/main/maker-ipc/__tests__/scheduledModelSelection.test.ts --maxWorkers=1
```

修正后定向命令（上述第一文件）：`-t 'accepts the saved permanent choice|reaccepts the same model'`。
首轮 package 类型检查 exit 1、无诊断，不计通过；等效重跑：

```sh
NODE_OPTIONS=--max-old-space-size=12288 node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json
```

新增用例属于 DB tier，通过真实配置 IPC、事务和既有冷态恢复/路由协调器验证：同值接受、冷态跳过旧来源、失败保留、成功清理、过期版本拒绝，以及工具同值提交与普通改名的区别。
没有新增测试文件或重复导入；运行时间主要由既有大型测试文件的加载决定。

## 提交前真实运行

在本 worktree 的 Global 独立开发实例上验证，`desktop-whoami` 返回 `DESKTOP_DEV_VERDICT=ready`、`commitVerified=true`。
启动器首次超时，实例随后完成初始化；未把超时当作成功。

只读提取旧正式数据中的模型配置和实际无标记恢复记录，在独立 QA 伙伴上建立模型状态副本。
未复制聊天、身份提示词或凭证，未将开发构建连接正式数据库。这是旧正式模型状态副本验收，**不是整个正式库副本或正式安装包升级验收**。

| 场景 | 实际结果 |
| --- | --- |
| 历史永久选择 Pi + 旧 Codex 恢复记录 | 真实输入框发送前报旧来源不可用；队首保留 1 条，未回复 |
| 显式接受已保存选择 | 配置版本 1 → 2，capabilities 完全不变 |
| 现有重试按钮处理原输入 | 实际回复 `QA7177_LEGACY_SAVED_MODEL_OK`；原 clientId 仅落库 1 条 |
| 恢复后手动例行 | history.status=success，实际结果 `QA7177_LEGACY_ROUTINE_OK` |
| 例行后的普通输入 | 实际回复 `QA7177_LEGACY_AFTER_ROUTINE_OK` |
| 当前永久共享 Codex + 同一旧恢复记录 | 接受后实际回复 `QA7177_CURRENT_SAVED_ROUTE_OK`；provider 与共享位置保持原值 |

完成时队列为空、error/recovery 为 null、执行结束、旧 baseline 清空；例行保持停用，仅手动触发。
原正式模型、provider、共享位置及 baseline 再次只读核对均未改变。

## 边界与风险

原正式库 schema=129，开发构建 migration 到 131；依照数据库规则，未用开发构建升级正式 profile。
未更新、替换或重启正式 Cindy。未声称整仓测试、远端 CI、跨账号全套验收或正式包已通过。
本记录已脱敏，不公开原始任务、伙伴、执行设备、来源标识或账号数据。

## 推送后完整恢复链复跑

源码提交：`d6517ea6bd4c6a31ae2e287bdff78cbfb90642f3`。
2026-10-26 16:36:10–16:36:57（Asia/Shanghai），同一 worktree 的独立实例重新构建后复跑。
启动器仍先返回 `STARTUP_TIMEOUT`（exit 1），后续 `desktop-whoami --json` 明确读回该 SHA、
`commitVerified=true`、`isolated=true`、`state=ready` 后才开始。没有把启动器超时当作通过。

[脱敏阶段记录](checks.json)由本次运行结果提取，私有标识已移除。

| 顺序 | 真实入口与观察结果 |
| --- | --- |
| 1 | 在空闲 QA 副本注入旧正式无标记 baseline；真实输入框发送被 `[INVALID_PARAMS]` 拒绝，队首 1 条、无回复 |
| 2 | 配置 API 接受已保存永久选择，版本 2 → 3，capabilities 完全未变 |
| 3 | 点击现有重试，原输入实际回复 `QA7177_D6517EA6_RETAINED_OK`；原 clientId 仅落库 1 条 |
| 4 | 仅手动触发停用的 QA 例行，history 为 success，实际结果 `QA7177_D6517EA6_ROUTINE_OK` |
| 5 | 真实输入框再发送普通输入，实际回复 `QA7177_D6517EA6_AFTER_ROUTINE_OK` |
| 6 | 当前共享 Codex 模型副本注入同份旧状态；接受已保存选择后实际回复 `QA7177_D6517EA6_SHARED_OK` |
| 7 | 两条持久路由保持各自永久选择，baseline 均为 null；队列、错误、恢复态清空，执行结束 |
| 8 | 原正式模型、provider、共享执行位置、baseline 四项再次只读核对，均与提取时一致 |

回归驱动 exit 0。记录提交仅增加证据，生产代码仍对应上述源码提交。
推送目的地为已配置个人 fork 的 `cindy/serene-euclid`；上游 origin 写入返回 403，未修改 main。
查询该源码 SHA 的 fork check runs 为 0；未将本地验收写成远端 CI 或正式包验收通过。

## PR #7241：安全边界延期切换补充

Greptile 指出同引擎选择会进入 runtime control 的 pending，而非 Harness 切换登记表。
清理前只检查后者，会在同引擎选择尚未应用时丢失恢复记录。已将生产应用步骤提取到同一模块的
`createBotModelRouteApplier`，同时检查两处 pending；register 复用该步骤，沿用原切换和清理入口。

在既有 `botModelRouteReconciler.test.ts` 增加 unit tier 表驱动回归：调用生产应用步骤及真实
runtime control，覆盖同引擎/跨引擎延期、取消失败的待执行选择后保留记录，以及再次应用成功后清理。
已有测试仅模拟 staging 抛错，没有覆盖 staging 成功但尚未生效的情况。

- 先红：保留原来的单登记表检查，定向用例 1 失败、1 通过（1.11 秒）；同引擎分支错误地成功。
- 后绿：`botModelRouteReconciler`、`sessionRuntimeControl`、`scheduledModelSelection` 三文件 141 项通过，exit 0（1.69 秒）。
- 单独运行修改文件：40 项通过，exit 0（1.24 秒，测试体 272ms）。
- 同一 Desktop 直接编译器类型检查命令：exit 0（180.16 秒）。

上述是评审补修的自动化验证；前述真实模型状态副本结果仍对应明确记录的 `d6517ea6bd`，
不将它冒称为该补修的新构建实测。
