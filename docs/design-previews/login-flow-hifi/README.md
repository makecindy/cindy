# login-flow-hifi — 桌面登录链路高保真 QA demo

由 qa-hifi-demo 工具链生成的可交互 QA 工件:`truth.json` 里的每个文案/几何/颜色叶子都带
provenance(源文件相对路径 + 定位方式 + 整文件 sha256),由 `extract.mjs` 从产品源码机械提取,
**禁止手改** `truth.json` / `index.html` 内嵌 `<script id="qa-truth">` 块。

- 在线体验(内网):<https://login-flow-hifi.workers.xd.team>
- 本地体验:浏览器直接打开 `index.html`

## 复现 / 校验 / 更新(防漂移)

工具链脚本目前随 qa-hifi-demo skill 分发(`~/.claude/skills/qa-hifi-demo/scripts/`),
在**仓库根**执行(需要 Node 22+;verify 需宿主可解析 playwright):

```bash
# 1. 漂移检查:现跑 extract.mjs 与在案 truth.json 逐字节比对;登录源码变了会 exit 2 + 差异清单
node <skill>/scripts/truth.mjs --demo docs/design-previews/login-flow-hifi --check

# 2. 重新提取 + 回写 truth.json 与 index.html 内嵌真值块(源码变更后的更新方式)
node <skill>/scripts/truth.mjs --demo docs/design-previews/login-flow-hifi --embed

# 3. 全量验收门(A 真值一致 / B 状态覆盖 / C 交互鲁棒 / D 渲染绑定 / F 适配还原),重新生成 report.json
node <skill>/scripts/verify.mjs --demo docs/design-previews/login-flow-hifi
```

`report.json` 是**生成物快照**(记录生成时刻的输入 hash 与门结果),不是持续保证;
改动登录组件 / design token / loginScale 公式 / `login.*` 文案后,应重跑上述 1→2→3 并连同
demo 一起提交,保持证据与源码同步。CI 侧的自动漂移门尚未接入(需要把工具链脚本入仓或
以依赖方式分发),属仓库治理决策,单独跟进,不在单个功能 PR 里顺手改。

## 覆盖范围

桌面端登录链路 17 个状态(via 可达 10 + 状态补齐 tab 7,理由见 `spec.json.states[].note`);
matrix = 国区/Global × light/dark × zh-CN/en/ja/ko(verify.cases 收敛为 4 个代表组合);
门 E(像素基准)无真沙盒截图,未比对——如实声明,不作为承诺。
