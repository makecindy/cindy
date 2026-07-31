<!--
PR Title 不是下面的正文标题，而是 GitHub PR 页面最上方的标题。
格式：<type>(<scope>): <简短描述>（scope 可省略）

type：feat / fix / refactor / perf / chore / docs / test / revert / build / ci
示例：docs(readme): 补充本地模式与远程开发说明；fix: 修复登录跳转
-->

## 这次改了什么

### 摘要

<!-- 用大白话说明改了什么，以及为什么改。保持单一目标。 -->

### 变更类型

- [ ] `feat` 新功能
- [ ] `fix` 缺陷修复
- [ ] `refactor` / `perf` 重构或性能优化
- [ ] `docs` / `test` / `chore` 文档、测试或工程维护
- [ ] 其他：

### 范围

- 关联 Issue / 需求：
- 本 PR 包含：
- 明确不包含：
- 用户可见变化：
- 是否存在 breaking change：无 / 有，说明：

### UI 变化

<!-- 涉及 UI 时附截图或录屏，并注明平台；不涉及则写“不涉及”。 -->

- 引用的设计规范：

<!-- 涉及 UI 时必填：列出本次改动遵循的设计规范章节与约束，并说明如何满足。
规范正本为 docs/design-rules/DESIGN.md（相关文档索引见
docs/design-rules/cindy-design-system.md）。写到具体章节/条款，
如“DESIGN.md §间距与栅格：卡片内边距 16px”。
改动命中 UI 代码路径但确无视觉/交互/文案变化时，写“不涉及：<理由>”；
完全不涉及 UI 则写“不涉及”。CI（pr-design-basis）会在变更命中 UI 路径时
校验本字段，判定逻辑见 scripts/check-pr-design-basis.mjs。 -->

## 怎么验证的

### 自动验证

<!-- 列出实际执行的命令及结果，不要只写“已测试”。 -->

```text
pnpm ...
结果：
```

### 手工验证

<!-- 写明操作路径、平台、账号或环境；不涉及则写“不涉及”。 -->

### 未执行的验证

<!-- 没有执行某项验证时，说明原因；没有则写“无”。mobile 本地验证需注明
branch/worktree、Metro 归属与 __DEV__ build label 证据。 -->

## 风险

### 风险分类

- [ ] 无已知风险
- [ ] SQLite / migration
- [ ] system prompt
- [ ] 协议兼容
- [ ] 权限 / 安全 / 用户数据
- [ ] 存量插件兼容（批准状态 / 指纹 / manifest 校验 / 安装布局 / 包格式）
- [ ] 原生层 / fingerprint / OTA
- [ ] 跨平台差异
- [ ] 其他：

### 影响与回滚

- 影响范围：
- 回滚 / 降级方式：

<!-- 命中 SQLite migration、system prompt、协议、原生层、fingerprint/OTA 或跨平台差异时，
必须写清影响和回滚/降级方式；不涉及风险时明确写“无”。

命中「存量插件兼容」时，必须写明「存量插件影响：无」或「有 + 迁移与提示方案」，并说明
基于旧布局的升级用例跑在哪。会让用户已装插件失效或需要重装／重新确认的改动与冷更同级，
需把关人对该影响明确确认；规则见 docs/dev-rules/plugin-security-and-authoring.md 第 5 节。

改动会改变 mobile runtime fingerprint（即触发冷更）时，还要写明为什么冷更不可避免、
存量装机的影响范围与发版节奏建议；这类 PR 与技术框架变动同级，需仓库指定的把关人针对
冷更明确确认后才能合并（提交者身份不构成例外），规则见
docs/dev-rules/mobile-development.md 的「冷更边界」。 -->

### 提交前检查

- [ ] 已 review 完整 diff
- [ ] 每个 commit 都带 DCO 签名（`git commit -s`，见 [DCO](../DCO)）
- [ ] UI 改动已在「UI 变化」注明引用的设计规范章节（不涉及 UI 则跳过）
- [ ] 未提交凭证、令牌或授权文件
- [ ] 已补充必要文档
- [ ] 已确认测试结果或说明未执行原因
