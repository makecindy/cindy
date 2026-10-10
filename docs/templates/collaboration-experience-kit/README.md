# Collaboration Experience Kit

这是一个可直接复制到新项目的协作经验包。它把 Agent 入口、开发工作流、PR 证据、
review 分层和 UI 约束拆成独立模板，避免方法论、流程规则和项目专属实现混在同一个
文件里。

## 包内内容

| 文件 | 复制后用途 |
| --- | --- |
| [AGENT_ENTRY.template.md](./AGENT_ENTRY.template.md) | 改名为仓库根目录的 AGENTS.md 或等价共用入口。 |
| [WORKFLOW.template.md](./WORKFLOW.template.md) | 作为集中工作流正本，例如 docs/dev-rules/development-workflow.md。 |
| [PR_TEMPLATE.md](./PR_TEMPLATE.md) | 放到 .github/PULL_REQUEST_TEMPLATE.md。 |
| [REVIEW_GUIDE.template.md](./REVIEW_GUIDE.template.md) | 作为 review 口径正本，例如根目录 REVIEW.md。 |
| [UI_UX_RULES.template.md](./UI_UX_RULES.template.md) | 有产品界面时使用；无界面项目可删除。 |
| [SETUP_CHECKLIST.md](./SETUP_CHECKLIST.md) | 落地验收清单；完成初始化后保留或删除均可。 |
| [manifest.json](./manifest.json) | 记录占位符、目标路径和可选文件，便于人工或脚本校验。 |

## 快速使用

1. 整目录复制到目标仓库，建议放在 TEMPLATE_TARGET_DIR。
2. 按 manifest.json 的 targets 把模板复制或改名到目标位置。
3. 全局替换占位符，先填默认分支、测试门禁、类型检查、格式检查和签名机制。
4. 删除不适用的可选文件；不要为了保留文件而引入空规则。
5. 用 SETUP_CHECKLIST.md 验收后，把经验包从运行规则中移除，只保留已改名后的正式文档。

## 替换原则

- 先启用最小基线，再按风险增加专项规则。
- 一类规则只保留一个权威正本；其他文档只做索引和链接。
- 命令必须真实存在；暂时没有自动化时，明确标记为人工检查，而不是写成假门禁。
- 团队重复纠正的问题优先升级为模板字段、脚本或 CI 检查。

本包不包含某个具体产品的路径、命令和历史决策，可以在不同代码仓之间复用。
