# 注销横幅被覆盖 bug · 修复前复现 demo(deletion-banner-repro)

> **本 demo 是「修复前证据」**:复现 `feat/login-deletion-bubble` 修复的 P1 bug——账号注销状态横幅被登录面板 100% 覆盖不可见(desk + mobile)。与它配对的修复后验收 demo 在 `../login-deletion-bubble/`。

## truth 钉在 base commit(不随分支漂移)

- 提取基线 = **本 PR 的 base commit `75baac1ee`**(origin/main 分叉点;该 commit 的 main 源码即修复前状态)。
- `extract.mjs` 的源码读取**全部走 `git show 75baac1ee:<repo-relative-path>`**(execFileSync,cwd=仓根),**不读工作区文件**——工作区已是修复后代码,读了就不是「修复前」。
- 每个 truth 叶子的 `provenance.hash` 按 pinned 字节计算;`provenance.source` 指向 `_pinned/`(提取时由 `git show` 落盘的源文件全集,先清空再写,与提取严格一致)。**`_pinned/` 已 gitignore 不入仓**——extract 每次运行自动再生(确定性字节),仓库里不放产品源文件副本(reviewer 不见、grep 不命中);skill 校验器按磁盘文件复核 hash,本地 extract 跑过即可验。
- 为什么钉 SHA 而非工作区:本 demo 断言的是**修复前**的结构事实(如 `makeStyles.deletionStatus` 无底色、横幅在 `{stateContent}` 之前的渲染序),修复后这些结构已不存在;钉 SHA 后 drift-check 恒定有意义(语义 = 提取器或 pinned 基线被改动),读工作区则必然失效。

## 如何重跑

```bash
# 漂移检查(extract 现跑 ≡ truth.json + provenance 校验)
node ~/.claude/skills/qa-hifi-demo/scripts/truth.mjs --demo docs/design-previews/deletion-banner-repro --check
# 门 A-D/F
node ~/.claude/skills/qa-hifi-demo/scripts/verify.mjs --demo docs/design-previews/deletion-banner-repro
# 自定义重叠门(重叠率 100% / elementFromPoint 命中面板 / 意图帧自证)
# 本仓 node_modules 无 playwright 时用 QA_HIFI_MODULE_ROOT 指向装了的目录
QA_HIFI_MODULE_ROOT=<装了 playwright 的目录> node docs/design-previews/deletion-banner-repro/overlap-gate.mjs
```

当前基线结果(2026-07-26,@75baac1ee):verify 门 A/B(24/24)/C/D(496/496) 全绿、门 F 未配置、overlap-gate 12/12——**bug 在 base commit 上必然存在**,这正是「修复前证据」要证明的事。

## 目录

- `spec.json` / `extract.mjs` / `truth.json` / `index.html` / `report.json` — qa-hifi-demo 标准五件
- `overlap-gate.mjs` — 自定义重叠门脚本
- `_pinned/` — `git show 75baac1ee` 落盘的 provenance 源文件(**gitignored,extract 每次运行自动再生,不入仓**)
- `evidence/` — overlap-gate.json + 目检截图
