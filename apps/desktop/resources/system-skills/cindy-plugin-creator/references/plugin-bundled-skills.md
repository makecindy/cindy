## 4.16 捆绑 Agent Skills(skill 能力)

插件可以随包带最多 4 个 Agent Skill。插件装入且启用后,主机把每个技能目录投影到
Cindy 的账号隔离目录,分别接入 Claude Code、Codex、Pi,不写入用户的全局技能目录;
停用/卸载即撤销这些入口。装了插件才有这些技能,不装就完全不出现。

**Skill 与 Manual 的分工**——按职责选,不按篇幅选:

- **用 Skill**:用户会点名或希望自动套用的完整工作流,需要斜杠命令入口(`/<name>`)、
  需要出现在 Agent 的技能列表里被自动召回,或需要随包带本地脚本让 Agent 在 shell
  里执行(包括定时任务的检查命令)。
- **用 Manual(§3.6)**:插件工具的深入用法、多工具编排、分支与失败恢复、参考资料。
  它只在 Agent 需要时经 `ghost_manual` 读取,不占技能列表。
- 单工具局部契约仍写在工具/参数 description;贴近实时工具集合的动态规则写在
  `list_tools(category)` 的工具说明和 `result.rules`。Skill、Manual 与 `list_tools`
  互相指路时给出完整调用,不复制同一段规则。

目录形态(每条 item 一个目录,内必须有 SKILL.md):

```
my-ghost/
  ghost.json
  main.js
  skills/
    my-skill/
      SKILL.md        ← frontmatter 必须有 name + description
      reference.md    ← 可选:技能附带的其它文件一并随链接可见
      scripts/run.mjs ← 可选:Agent 在 shell 里执行的脚本
```

SKILL.md 硬规则(打包与装入双侧强制,任一不满足直接拒):

- frontmatter 的 `name` / `description` 必须与 `skill.items` 声明**逐字一致**
  ——插件详情展示的是清单声明,Agent 读到的是 SKILL.md,两者必须是同一份事实;
- `name`:小写字母/数字加单连字符分段(禁首尾/连续连字符),≤64 字符;
- SKILL.md 单文件 ≤64KB;items 最多 4 条。

**命令名**:斜杠菜单里显示的就是 `name`,例如 `name: pr` 即 `/pr`。只有与其它技能
撞名时才显示带插件前缀的全名;在 Claude Code 里技能归在本地插件
`cindy-plugin-<插件id>` 下。磁盘上的链接名(`<插件id>--<技能name>`;已知企业
namespace 的实例为 `_ns__<namespace>__<插件id>--<技能name>`)不是命令名。

**脚本路径**:技能文件位于插件的批准快照里,路径带安装版本,插件一更新就换。
在当前会话里直接执行没有问题;要存下来长期使用(例如定时任务的检查命令)时,
在 SKILL.md 里让 Agent 先对技能目录取 `realpath`,用这个真实路径拼命令。主机保存
检查命令时,会把它换成该技能跨插件版本不变的入口(路径含 `/agent-skills/skills/`)。
依赖这一行为的插件版本,`minCindyVersion` 不得低于首个支持它的 Cindy 正式版本。
不要让 Agent 搜索磁盘找技能目录,也不要把系统临时目录下的链接路径存下来。

这些入口仅供 Cindy 管理的 Agent 会话使用,不会自动暴露给外部 CLI,无需为全局
目录发现方式添加环境守卫。技能如依赖插件工具,应说明实际依赖;调用时工具不可用
就报告缺失,不得据此假定已获得其它能力或权限。

信任与作用域(如实告知用户,也请作者自重):

- 技能指令由**主 Agent 以用户全部权限执行**,对所有项目、所有会话生效,
  **不受插件沙箱约束**——这是插件能力里信任面最高的一档,安装确认与插件详情会把
  每个技能置顶逐条列出;
- 技能跟随插件的**全局**启用状态:仅在某个工作目录停用插件**不会**隐藏技能,
  只有全局停用或卸载才撤链(本期只有全局作用域);
- `skill.items` 的字段不参与 locales 本地化(必须与 SKILL.md 逐字一致,而
  SKILL.md 只有一份)。
