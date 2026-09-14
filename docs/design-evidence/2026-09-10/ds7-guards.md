# DS-7 设计检查本地候选证据

2026-09-10；执行者 Codex。风险分类：CI 门禁调整。分支 `ds/7-design-guards`，开工重新 fetch 后的基线及未提交 HEAD 为 `3047a83c6f43ce6b0fb94de9df26db81c881e737`。本页只记录结果；完整计划与 SC 继续只维护用户桌面主计划。本节是首轮本地候选记录；之后的提交授权与验证见文末，未修改远端规则或进入DS-8。

## 固定历史误报

范围：base `79c89d14a9f073d93485c7e7d5c0bec79bd6a961` → DS-6 merge `6559d2610a35e5ff85adf9b41c2a620ac4a4c196`。DS-6 最终 [#4135](https://github.com/makecindy/cindy/pull/4135) 的 head 为 `62472f559c8e2d729b93a6546bd500e86d8989a5`。

分别加载 `9d6ee6ddbafaf31cc885f014c52e0e5597b2ed96` 与开工 `3047a83c6f` 的 matcher/例外表，都得到 **raw13 / allowed2 / unexpected11**。候选同范围 **raw0 / allowed0 / unexpected0**，额外14项仅为几何/表单报告。09-08旧候选9项是不同快照，不混计。

[原始13项定位与两个固定版本](./ds7-historical-matcher.json)：CustomProviderDialog 2703/3057 的 #4108；confirm-dialog 327（3处）/378 的语义包装；ds6-forms 99/177 的4个PR编号；governance 299 的 #4022。剩余两个 allowed 是旧inventory里的PR编号。没有靠整文件豁免消除它们。

## 20张历史回放

先按新增生产消费判断预期，再运行候选。合并状态不是正确性标签。各样本阻断预期均为0，理由见[逐样本记录](./ds7-replay.json)；真实检测能力由独立违规注入证明。报告数包含非阻断颜色观察和未知几何/采用，不是“违规数”。执行者在声明范围内未发现最终误拦/漏报；**首轮独立复核未进行；用户随后明确改为执行者自行review＋e2e，结果见文末**。

| PR / 内容 | raw | allowed | block | report |
| --- | --- | --- | --- | --- |
| [#3920](https://github.com/makecindy/cindy/pull/3920) feat(design-system): DS-4 Button 与 Input 标准组件 | 24 | 1 | 0 | 29 |
| [#4010](https://github.com/makecindy/cindy/pull/4010) fix(design-system): DS-4b 设置输入框旧主题兼容收口 | 0 | 0 | 0 | 0 |
| [#4022](https://github.com/makecindy/cindy/pull/4022) docs(design-system): DS-5 对齐执行路线与双端设计合同 | 0 | 0 | 0 | 0 |
| [#4135](https://github.com/makecindy/cindy/pull/4135) feat(design-system): DS-6 完成表单与确认组件复用 | 0 | 0 | 0 | 14 |
| [#4072](https://github.com/makecindy/cindy/pull/4072) docs(design): 按可见层与登记分配圆角并明确审查边界 | 0 | 0 | 0 | 0 |
| [#4076](https://github.com/makecindy/cindy/pull/4076) fix(desktop): 优化用量历史图表配色、交互反馈与文字层级 | 38 | 20 | 0 | 32 |
| [#4164](https://github.com/makecindy/cindy/pull/4164) fix(desktop): 优化用量历史模型与 harness 配色 | 17 | 0 | 0 | 17 |
| [#4146](https://github.com/makecindy/cindy/pull/4146) feat(bots): 统一持久授权卡与授权完成续接 | 0 | 0 | 0 | 3 |
| [#4190](https://github.com/makecindy/cindy/pull/4190) fix(desktop): 统一登录页面返回入口 | 0 | 0 | 0 | 0 |
| [#4133](https://github.com/makecindy/cindy/pull/4133) fix(mobile): 恢复消息菜单图标并统一跨端规范 | 4 | 0 | 0 | 4 |
| [#4191](https://github.com/makecindy/cindy/pull/4191) fix(mobile): 普通同步使用延迟标题动画，异常保留悬浮提示 | 0 | 0 | 0 | 0 |
| [#4069](https://github.com/makecindy/cindy/pull/4069) fix(mobile): 统一待发送与正式消息的附件布局 | 0 | 0 | 0 | 0 |
| [#4081](https://github.com/makecindy/cindy/pull/4081) perf(device-link): 按可见内容分页并按需读取工作详情 | 0 | 0 | 0 | 0 |
| [#4065](https://github.com/makecindy/cindy/pull/4065) feat(remote-desktop): 手机远程桌面、网络协商与断线恢复 | 7 | 3 | 0 | 11 |
| [#4038](https://github.com/makecindy/cindy/pull/4038) perf(desktop): 将大段差异计算移出渲染主线程 | 0 | 0 | 0 | 3 |
| [#4040](https://github.com/makecindy/cindy/pull/4040) perf(file-browser): 合并文件树刷新请求 | 0 | 0 | 0 | 0 |
| [#3905](https://github.com/makecindy/cindy/pull/3905) fix(mobile): 修复 iOS HDR 截图发送失败 | 0 | 0 | 0 | 0 |
| [#4033](https://github.com/makecindy/cindy/pull/4033) fix(mobile): 自建 OTA 原生事务恢复（需冷更） | 0 | 0 | 0 | 0 |
| [#4098](https://github.com/makecindy/cindy/pull/4098) feat(skillhub): 支持本地技能启停、卸载与详情跳转 | 0 | 0 | 0 | 7 |
| [#4067](https://github.com/makecindy/cindy/pull/4067) feat(bots): 伙伴例行任务与本地事件触发 | 0 | 0 | 0 | 11 |

逐样本 JSON 包含完整 base/head、脚本 SHA256、实际计数、预期理由及报告分类。`scannedCandidateHash` 只绑定被审计文本源及新增行，不冒充整个工作区/CI文件的标识；完整候选文件hash另在桌面主计划附件。

首轮报告发现括号编号、`color(surface)` 普通调用、`color (owner-approved...)` 与空 `rgb()` 文档的假命中，已修正并补回归。最终报告不再出现；未知几何与待决命中保持报告，没有因历史已合入而自动获批。

复跑一个固定样本：

```bash
node scripts/hardcoded-color-audit.mjs --base-ref <样本base> --head-ref <样本head> --report --json
```

全部回放（只读，不写 Git 引用）：

```bash
node --input-type=module <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { audit } from './scripts/hardcoded-color-audit.mjs';
const evidence = JSON.parse(fs.readFileSync('docs/design-evidence/2026-09-10/ds7-replay.json', 'utf8'));
for (const sample of evidence.samples) {
  const result = audit({ baseRef: sample.base, headRef: sample.head });
  assert.deepEqual(result.scriptHashes, evidence.scriptHashes);
  assert.deepEqual(result.counts, sample.actual);
  assert.equal(result.counts.unexpected, sample.expectedBlock);
  console.log(sample.pr, result.counts);
}
JS
```

## 正反例与失败传播

测试入口：`scripts/__tests__/hardcoded-color-audit.test.mjs`、`design-inventory.test.mjs`。

- HEX（含纯数字）、RGB/HSL/OKLCH、渐变/阴影、嵌套 fallback 与混合表达式可定位新增行/列，输出原因与语义入口；多行字面原始起点另保留。语义引用、局部/全局alias、PR文本、合法来源与窄例外均有反例。
- 每个原豁免renderer消费者注入新未批准色必红；Toast、composer、素材及指定hljs原批准值合法。属性边界防止 `color` 批准被 `background-color` 冒用，CSS选择器单双引号等价。
- 没有冻结全部存量为新批准。globals.css 两项按 DESIGN §15.4 的正式整改值保留，其它未批准旧值不是自动允许新增的清单；未改旧行不触发增量阻断。
- 分类器测试包括keycap、四类登记图元、普通动作/容器/textarea与hit/indicator。生产报告只自动识别显式用量图层/target/indicator与可见kbd，其它框或缺少身份的按钮保留unknown。分类器测试不冒充生产覆盖；几何/间距/表单采用全部report，用户radius与Permission待决项未变更。
- 临时Git fixture包含staged/unstaged/untracked三个违规：真实CLI exit1、report exit0、合法commit候选exit0、错误引用/参数/解析exit2。仅隔离fixture使用commit-tree，真实任务无提交或索引写入。
- 再执行实际workflow的verify shell：16组success/failure/cancelled/skipped组合，以及违规脚本→checks failure→verify非零成立；Windows汇总4种状态也成立。

## CI 与管理员边界

`client-ci` 仅在 `verify-checks` 增加颜色与台账两个步骤；去掉这两个新增步骤后的完整YAML对象与开工版本逐项相等。既有runner、Linux/Windows分片、伙伴数据库、Device Link、Pi manager、Desktop Git integration、类型/迁移/术语等检查没有删除或改条件。新增测试已加入test:runner。这是**本地候选接线，main尚未启用**。

2026-09-10 02:57:00 +08:00 只读 `GET repos/makecindy/cindy/rules/branches/main`：required为 **DCO（App 1861）、Windows unit tests（15368）、verify**；至少1批准与审查线程解决要求仍在。DCO是外部App；远端required未修改。没有管理员实际Approve前不得合并（治理§8）。

## 台账与工程验证

同一inventory在2026-09-10共49个surface：35 Desktop＋14 Mobile。实际动态路由、远程桌面再导出、共享消息与授权呈现、根布局连接反馈、设置调试/日志入口进入静态发现；布局、开发预览和资源实例不单计。新增/删除/改名入口、开发开关移除与精确大小写路径均有反例。

共享文件会重复计数，不能将列简单求和。Mobile的RN ThemeColors/typeScale未计入CSS var统计，0不表示未用Token。服务端动态内容、间接import和原生呈现仍为发现盲区。

生成两次字节一致、人工区全部保留、freshness通过；快照SHA256 `0803f4438ac60c948081bea98c9a7750d6a324d49293361d5065d36c011c94a6`。人工编辑仅回填真实合入状态和新增Mobile owner/下一动作；Desktop settings仍pilot、Mobile全部legacy。发现维护Codex，kirozeng协调，长期页面owner待认领，2026-09-17复查。

- Desktop/Mobile typecheck均退出0；本批未改产品包实现，仍核对现有CI入口。
- 根 `VITE_CINDY_AUTH_REGION=global pnpm test:unit:related` 因CI/根脚本改动自动全量，退出0：28个workspace通过，6个原有notApplicable不纳入；runner 526通过、1个原有跳过。Desktop 132.7秒、Mobile 20.4秒、maker-core 149.4秒；没有用短超时终止。
- 窄属性例外最终收紧后，完整 `pnpm test:runner` 再次退出0（526通过、1个原有跳过）；本批集中脚本/台账/接线共62项通过，`git diff --check`通过。中途一次文档链接检查发现本页尚未落盘，补齐后复跑通过；未弱化检查。没有运行产品UI，不声称新增双端实机目检。

## 遗留与回退

[治理§8/§13](../../design-rules/design-governance.md)登记最终覆盖、盲区和回退。新增颜色阻断可切report或撤新增接线，保留既有保护及有效台账；不碰远端required、主题值或用户数据。DS-8接收静态源/消费者/主题边界；DS-12接收未知几何、动态值/自绘、Mobile报告和广泛表单采用，仍须正反例、回放和管理员审核后升级。没有开始下一批。

G2真实独立贡献者、DS-4/4b与DS-6共69张图片公开交接、Windows/原生拖窗/实体IME/200%缩放及完整生产模型选择入口等证据仍待：kirozeng安排试用/上传/平台验收，Codex复查与修复，2026-09-17复查。无新参与者或可访问附件，不称目标完成。DS-7独立样本复核、治理管理员批准保留为合并前审核项；本地检查不代替审批。

完整diff已逐文件自查：仅脚本、必要测试、CI与文档；依赖版本、产品UI、Token JSON、Mobile原生输入、用户数据和权限业务均无diff。28个workspace全量覆盖保留的设计/排版/主题与DS-6行为单测；Windows本机未执行，保留CI全量分片待未来PR运行，不称跨平台实跑通过。

## 提交阶段更新（2026-09-10）

用户明确授权先提交PR，手机端重构方案明确后再一起调整设计系统；随后明确跳过双审，由执行者自行review和e2e，通过后推送。本次不声称独立双审完成；管理员按治理§8的合并前实际批准仍必须保留。

已用DCO提交保全首轮候选 `881f07acf83cc525e9b0ef7a7326442353db78c7`，并合并当时最新main `fd4c1d03348daa670d09e6713841420a3f8c48df` 验证兼容性。仅inventory生成区发生冲突，按合并后的真实源码重生成，人工记录原样保留；main继承的产品修改不进入本PR相对最新main的diff。上方首轮快照hash仍只绑定原快照。

执行者自行review覆盖共享颜色分类、窄例外的属性/选择器、工作区与commit审计、Mobile入口及人工保全、可见层报告、CI失败传播、文档声称与本批范围。没有发现未修复P0/P1。原20个历史样本的内容预期仍适用，并按冻结base/head与脚本hash重新回放，不用已合入状态代替正确性判断。

E2E在独立临时Git仓构造真实base/head，用当前workflow的 `pnpm check:design-colors` 命令，再执行当前verify汇总shell：语义颜色、原批准Toast色通过；真HEX、fallback、新增未批准Toast色均使脚本及汇总exit1；Mobile布局/颜色样例仅报告；错误ref exit2。共7条场景通过。这里验证的是本地真实脚本到汇总链，不冒称远端Actions执行，也不冒称产品UI实机E2E。Mobile新路由仍需同步inventory，颜色报告通过不代替入口新鲜度。

手机端重构不会由本批冻结布局/组件：DS-7仅发现实际入口，新的颜色diff保护在Mobile保持report，既有Mobile守卫照常保留。DS-10与未成熟采用规则等重构方案明确后重新评估；这项等待不阻止无关的成熟Desktop保护。

合并后提交门禁结果：root related按当前调度全量退出0（28个workspace通过、6个原有notApplicable；runner527通过/1个原有跳过）；双端typecheck、台账新鲜度、20张冻结回放、7个E2E场景及现行静态检查全部通过。合并后的49入口台账SHA256为 `bd600d245dfd778ad0c945526dc0eb8b5f2659f2c4706e169ade8b014e731793`，只更新生成事实，人工区保留。
