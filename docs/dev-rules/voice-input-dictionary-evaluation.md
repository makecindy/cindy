# 语音个人词汇学习评测

## 产品合同

词条是供以后识别和润色参考的个人词汇，不要求是专有名词，也不要求同时有误识别别名。
用户这次明确纠正或补充的名字、术语、可复用表达可以学习；未修改的词、普通语气和事实调整
不自动成为新证据。词汇单位由模型理解，不由字符 diff 或分词器决定。

别名是独立的、可选的纠错证据。补充名称、改换讨论对象、两段文本分别出现某两个词，都不
足以证明别名关系。`aliases: []` 是合法动作，进入正式词表后仍参与润色背景，但不生成
纠错提示。明确名字允许一次入库；不确定的表达可以候选或忽略。

候选累计 3 次被接受的学习记录后，由程序保底转为正式词条，不再依赖模型决定晋升。
同一次返回里同词的多个动作合并为一次记录，合并别名，正式动作优先；低置信度动作不计数。
晋升承接原候选计数及已有别名，不凭空补造历史映射，也不是完整修改流水。
跨设备合计和旧候选快照适用同一阈值，用户删除抑制仍优先。展示仍受词条和别名数量上限约束。
计数是累计记录权重，包含历史导入，不能声称每个数字都是独立且正确的用户纠正。

例子：

| 编辑 | 值得记住 | 纠错别名 |
| --- | --- | --- |
| Slate 机器人 → Slack 机器人 | Slack | Slate |
| 机器人 → Slack 机器人 | Slack | 无 |
| 补充 warmup | warmup | 无 |
| 提示谈过一次 → 提示弹过一次 | 弹过一次 | 谈过一次；不能泛化成单字替换 |
| CPU、Cindy 未改，只改周围语气 | 无新学习 | 无；历史错别名不构成本次证据 |

## 固定案例与标签

公共语料：`scripts/fixtures/voice-dictionary-v1.json`（32 例）、
`scripts/fixtures/voice-dictionary-v2.json`（24 例）、`scripts/fixtures/voice-dictionary-v3.json`
（48 例，加入明确别名必学目标及更多长文本、历史干扰）以及
`scripts/fixtures/voice-dictionary-v4.json`（24 例，覆盖新的名称家族、普通词纠音和负例）。
共 128 例，内容为构造案例，不包含真实语音、
用户身份、日志路径或服务凭证。运行前冻结语料；运行目录保留其副本和 SHA-256。

- `dev` 是可用于改提示词的样例，也可能出现在提示词中，不能当泛化成绩。
- `regression` 是运行前冻结的回归集，覆盖新词、纠错、多词名称、空格、原始 ASR、
  已有候选、普通修改、脏词典背景和大段文本门禁。结果按 category 分开报告。
- 真实记录单独保存在仓库外，保留匹配来源和不确定性。由插入历史与最终发送内容重建的
  样本，不等于原始 Advisor 请求；缺少原始 ASR、上下文或历史词典时必须注明。
- 已经测试过的真实样本只能叫回放/回归。新一轮泛化评估应另取未看过的日期与术语家族，
  冻结标签后再调用模型。出现失败后再改 prompt，不能继续称同一批为未见测试集。
- `terms[].accept` 是同一语义目标的可接受写法；`required: false` 用于事先标出的边界
  判断，不进入召回分母。不得看到模型答案后临时扩大可接受集合。
- aliases 单独标注。默认纠错别名可省略，但输出的每一对必须有依据；未列出的配对计错。
  要专门测别名召回时，将确证配对标为 `required: true`，并单列结果。
  v3 的明确名称纠正已设置必学别名；不能靠空 aliases 提高精确率却隐去这些遗漏。
  对存在多个合理跨度的上下文短语，事先列出允许的词条和对应别名，粒度失分与不相关错配
  分开解释，仍保留冻结标签下的原始分数。
- 标签争议先保存原始判分，另建版本说明原因，对所有比较组统一重算。不要覆盖旧报告。

## 四层结果，分别解释

1. **请求/结构**：错误、超时、JSON/schema 不合规、实际返回模型、用量与耗时。
   失败保留在分母，不能只统计成功请求。
   输出 aliases 必须是字符串数组；照搬输入历史词表的 `{text, count}` 对象属于结构错误，
   即使程序最终保留了无别名词条，也不能算结构通过。
2. **模型语义**：原始输出的词汇召回、误学词、错误别名，以及正式入库或候选选择。
   正确词配错别名，应记为“词汇正确 + 别名错误”，不是整条漏学。
   同时报告正确别名数量及出现过别名的案例数，不能靠始终输出空别名宣称纠错能力提高。
   v8 提示词先原样列出本次局部修改，再结合读音、字形与语境判断纠音、新词或普通修改；
   不先概括全文意思，以免模型顺手纠正原文而抹掉误听证据。`edits` 是模型理解输入的
   辅助输出，程序仍只接纳 `actions`，不以辅助字段为程序门禁。
   同一词在全文别处已写对，不会抵消当前这一处纠正；补充术语写法与普通修辞需分别判断。
3. **程序接纳**：同一输出通过实际 Advisor 后的上述指标，与原始输出逐例对比。
   `entryHit` 只算正式动作，候选不冒充已经学会。门禁跳过也算端到端漏学，单独注明原因。
   当前大段改写门禁可能误拦相距很远的两处小纠正，`gate_limit` 专门保留这一限制。
4. **保存与使用**：离线集成测试验证空别名入库、候选晋升、频次、重启读取、删除抑制、
   词表背景与别名提示分离。直接调用模型的 accepted 结果不等于已经持久化；
   这些测试也不证明真实音频识别率或最终润色改字率。后两者需要另建音频/润色回放。

每个方案至少重复三次，报告各类结果、全部重复都正确的案例数，以及逐例失败。
多次采样不等于独立用户样本，不能将“69 例 × 3 次”描述成“207 条真实记录”。

多方案迭代先用开发/回归集选定并冻结 prompt，再调用留出的验证集。基线与候选使用相同
模型、输入、历史、接纳逻辑及传输条件；空闲超时、并发和缓存范围的差异必须记录。
相对提升同时检查词汇精确率、必学召回、正式入库及有效别名覆盖，不能只选一个变好的指标。
置信区间按案例成组重采样，保留同案例的重复结果；构造验证集不等同于新真实用户样本。
v3 首轮验证暴露了 v6 的漏学，随后转为开发/回归集。v4 在 v7/v8 选型前冻结，首次
用于最终方案与基线的确认；现在结果已知，后续再用同样只能称回归集。两者均由评测者
构造并标注，并非独立作者盲测；新一轮确认应另取样本，不能重复称为未见测试。

建议进入人工发布评估的门槛：明确负例三次均不误学，别名错误为零；必学词召回至少 90%，
词汇精确率至少 95%，且相对基线不退步；请求与结构错误必须解释和复测。
边界样本、开发样本、已知门禁缺陷分层报告，同时保留包含全部案例的总分，不能借分类隐藏
整体漏学。未达标仍可交付实验代码与失败报告，但不能宣称已达到可发布质量。
这是一版小规模回归标准，不是总体准确率的统计保证。

## 离线验证

在仓库根执行：

```sh
node --test scripts/__tests__/voice-dictionary-eval.test.mjs
pnpm --filter @cindy/voice-input-core exec vitest run src/__tests__/DictationDictionaryAdvisor.test.ts
pnpm --filter desktop exec vitest run src/main/voice-input/__tests__/dictionarySyncStore.test.ts src/renderer/voice-input/__tests__/dictionaryLearningSettings.test.ts
pnpm --filter @cindy/voice-input-core build
pnpm --filter desktop typecheck
```

常规单测禁止访问真实模型和账号。提交前仍按仓库要求运行 `pnpm test:unit:related`。

## 显式模型评测

Node 22.18+ 支持直接载入实际 Advisor TypeScript。评测调用实际 payload 构造与接纳逻辑，
不复制一套 prompt。模型连接由仓库外 adapter 提供，便于复用当前环境已授权的连接；
不要把 token 写进脚本、命令行或版本库。

adapter 导出 `async requestJson(request)`，输入与 `TextModelClient.requestJson` 相同
（model、system、user、schemaName、promptCacheScope），返回：

```js
// 调用当前授权的模型客户端后，保留原始输出与元数据；不要记录 headers/credentials。
return {
  value: parsedJson,
  rawText: modelOutputText,
  metadata: { returnedModel, usage, elapsedMs },
};
```

transport 自行设置请求超时，不得把评测标签、rationale 或期望答案传给模型。runner 只传
sample.input。真实记录只发给用户已经授权用于此次评测的模型服务。

```sh
node --experimental-strip-types scripts/voice-input-dictionary-eval.mjs \
  --cases scripts/fixtures/voice-dictionary-v1.json \
  --adapter /absolute/local/model-adapter.mjs \
  --model MODEL_ID --repeats 3 \
  --out /absolute/local/evaluation-new-run
```

`--split dev` 先试开发样例；`--advisor /absolute/local/Advisor.baseline.ts` 可运行保留的
基线实现。新旧组使用同一语料、模型、重复次数和背景。交错/同期运行，记录日期与实际模型
以降低服务变化影响。修改 prompt、接纳规则或背景时分别说明，不能把联合改进都归功于 prompt。

默认并发为 2，可用 `--concurrency 1` 降低服务压力。请求失败时，可显式使用
`--retry-from /absolute/local/previous-run` 在新目录补测；语料、Advisor、adapter、评分器、模型、
重复次数与 split 必须一致。主成绩始终包含首次失败，恢复表现单列 `recovery`，不得
用恢复分替换主分。结构或语义错误不选择性重抽样。adapter 如依赖环境采样参数，应固定
这些非敏感参数并保留记录，不能在复测间改变条件。

输出目录必须在仓库外且尚不存在；结果不覆盖、失败不静默重试。产物包含语料、源码快照、
manifest、逐例原始与接纳结果、总表及分类汇总。可用相同 `scoreActions` 对保留的 raw JSON
重新判分，不必为标签修正再次付费调用模型。请求失败或 schema 失败返回非零退出码；
语义门槛由报告与人工评估判断，不能把脚本退出 0 当成模型质量通过。
