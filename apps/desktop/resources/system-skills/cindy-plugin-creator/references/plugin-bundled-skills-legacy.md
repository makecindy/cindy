## 4.16 捆绑 Agent Skills(skill 能力)

插件随包 Skill **当前已停止新增,未来计划全部废弃**。新插件不要声明 `skill` 字段
或新增 `skill.items`。迁移时按职责映射,不是按篇幅搬运:

- Skill frontmatter 的 `name + description` 所承担的身份/召回作用,对标系统提示词区
  插件花名册的身份与 `recall`;插件侧用 `name` + `whenToUse` 提供这层信息;
- `manual.items` 只是插件容器级一级目录,不对标 Skill frontmatter;
- `MANUAL.md` 与深层 Markdown 承接 Skill 正文、references、复杂工作流与深入用法,
  只经 `ghost_manual` tool-result 按需进入上下文,不进入生产 system/developer prompt;
- 单工具局部契约下沉到工具/参数 description;当前类别内贴近实时工具集合的动态规则与参数
  下沉到 `list_tools(category)` 的工具说明和 `result.rules`;跨工具/跨类别编排与长期
  稳定原则进入 Manual。Manual 与 `list_tools` 用完整调用互相指路,不复制同一段规则。

以下只解释存量包的兼容形态,用于维护与迁移,**不要照抄到新插件**。存量插件装入且
启用后,主机把每个技能目录投影到 Cindy 的账号隔离目录,分别接入 Claude Code、
Codex、Pi,不写入用户的全局技能目录;停用/卸载即撤销这些入口。
已知企业 namespace 的实例用 `_ns__<namespace>__<插件id>--<技能name>`，
root 和存量未标记 namespace 的实例继续沿用旧链接名。

目录形态(每条 item 一个目录,内必须有 SKILL.md):

```
my-ghost/
  ghost.json
  main.js
  skills/
    my-skill/
      SKILL.md        ← frontmatter 必须有 name + description
      reference.md    ← 可选:技能附带的其它文件一并随链接可见
```

SKILL.md 硬规则(打包与装入双侧强制,任一不满足直接拒):

- frontmatter 的 `name` / `description` 必须与 `skill.items` 声明**逐字一致**
  ——插件详情展示的是清单声明,Agent 读到的是 SKILL.md,两者必须是同一份事实;
- `name`:小写字母/数字加单连字符分段(禁首尾/连续连字符),≤64 字符;
- SKILL.md 单文件 ≤64KB;items 最多 4 条。

这些入口仅供 Cindy 管理的 Agent 会话使用,不会自动暴露给外部 CLI,无需为旧的
全局目录发现方式添加环境守卫。技能如依赖插件工具,仍应说明实际依赖;调用时工具
不可用就报告缺失,不得据此假定已获得其它能力或权限。

信任与作用域(如实告知用户,也请作者自重):

- 技能指令由**主 Agent 以用户全部权限执行**,对所有项目、所有会话生效,
  **不受插件沙箱约束**——这是插件能力里信任面最高的一档,插件详情会把
  每个技能置顶逐条列出;
- 技能跟随插件的**全局**启用状态:仅在某个工作目录停用插件**不会**隐藏技能,
  只有全局停用或卸载才撤链(本期只有全局作用域);
- `skill.items` 的字段不参与 locales 本地化(必须与 SKILL.md 逐字一致,而
  SKILL.md 只有一份)。
