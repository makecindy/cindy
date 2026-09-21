# 验证清单

本文说明修改或复用本目录时要检查什么。它不保存某次提交的一次性运行结果。

## 文档质量

- [ ] README 明确说明这是非强制经验模板，没有把建议伪装成本仓硬性规则。
- [ ] 除「本仓参考实现」外，正文不依赖 Cindy 专属路径才能理解。
- [ ] 占位项、最小基线和落地清单可以脱离上下文复制到新项目。
- [ ] 内部 Markdown 链接可解析，引用的命令在目标项目中真实存在。
- [ ] 没有凭证、令牌、私有地址、机器专属路径或一次性运行日志。

## 复用性验收

- [ ] 新维护者能从 README 找到 Agent 入口应放什么、规则应如何路由。
- [ ] 新维护者能确定本地提交前的最低验证集合。
- [ ] 新维护者能知道 PR 必须记录哪些证据。
- [ ] 新维护者能区分 P0、P1、P2，并理解 AI review 不替代 CI 和人工 review。
- [ ] 团队能根据规模删减基线，而不是被迫一次性接受全部实践。
- [ ] 需要成套落地时，collaboration-experience-kit 的 manifest 目标、占位符和可选
  文件说明与实际文件一致；路径见 docs/templates/collaboration-experience-kit/README.md。

## 本仓执行命令

修改本目录后执行：

```sh
git diff --check
pnpm check:dev-docs
pnpm test:unit:related
```

纯文档改动通常应跳过 workspace 单测；如果 related 选择器命中源码，继续完成命中的
测试和对应 package typecheck。commit 创建后再执行：

```sh
pnpm check:dco
```

任何门禁失败都不得提交或合入；不要通过缩小验证范围制造通过。
