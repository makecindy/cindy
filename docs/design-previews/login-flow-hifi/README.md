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
matrix = 国区/Global/Dev × light/dark × zh-CN/zh-TW/en/ja/ko(verify.cases 收敛为 5 个代表组合:
`cn-light-zh` / `cn-dark-ja` / `global-light-en` / `global-dark-ko` / `dev-light-zh-TW`);
门 E(像素基准)无真沙盒截图,未比对——如实声明,不作为承诺。

Dev 档随区域徽标改判(2026-07-27)加入:徽标按区域取值(cn→`CN` / dev→`Dev` / global 不挂,
见 `DESIGN.md` §16.3),不覆盖 dev 就测不到 `login.regionPill.dev` 与 Dev 的布局。demo 内
`identifierMethod` / `urls` / providers 仿真三处区域分支统一走 `regionKey()`,镜像源码
`resolveIdentifierMethod` 与 `legalLinks` 的「dev 归 cn 系」口径(truth 的这两项只有
cn / global 两键,dev 直接索引会 undefined 并中断渲染)。

> ⚠️ **`report.json` 当前已过期(2026-07-27)**:它是 2026-07-25 的快照,`inputHashes` 与
> `coverage.cases` 都早于后续区域徽标和五语覆盖改动(不含 `dev-light-zh-TW`),**其 `ok: true` 不代表
> 当前 `spec.json` / `index.html` / `truth.json` 已通过门 A–F**。`truth.json` 与内嵌真值块
> 已按上面第 2 步重新回写并逐一核对 provenance hash(18 个源文件全匹配),但第 3 步的
> `verify.mjs` 需要 qa-hifi-demo 工具链,该工具链未入仓、也不在常规开发机上,故本次未能重跑。
> 在有工具链的环境跑一次 `verify.mjs` 并提交刷新后的 report 即可解除本标注。
