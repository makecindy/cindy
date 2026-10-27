## 3.6 manual:按需披露复杂工作流与分层资料

Manual 的归属不按篇幅长短判断。它对标 Skill 正文与 references,承载多工具组合编排、
跨类别完整工作流、复杂工具深入用法、前置检查、顺序与分支、失败恢复、交付标准、
跨工具/跨类别长期稳定的共同原则,以及需要分层展开的参考资料。短但决定多个工具如何协作的
关键原则应进入 Manual;很长但只是在枚举某一个工具的参数,仍应留在该工具 description 或
所属类别的工具说明/RULES,不能只因内容长就搬进 Manual。

使用顶层 `manual.items` 声明手册单元,不要把上述内容塞进 `whenToUse` 或 system 提示。
每个单元目录必须有普通 Markdown `MANUAL.md` 入口;目录树可以任意深,但所有非目录条目
都必须是普通 `.md` 文件,单文件不超过 64KB。Markdown 不写 frontmatter;二进制、非法
UTF-8、符号链接和其它扩展名都会在打包与装入两侧拒绝。

**Manual-only 插件**可以只声明非空 `manual.items`,不需要声明虚假工具。
已启用、账号可用且当前工作目录未停用时,它同样进入花名册、`ghost_list` 和
`ghost_info`;返回的 `tools` 可以为空。`ghost_manual` 读取手册不启动插件运行时,
`ghost_call` 仍只能调用实际声明的工具。既无工具也无手册的插件不进入发现清单。

四层信息各司其职:

- `whenToUse`:只放系统提示词区插件花名册需要的召回场景;
- 工具/参数 description:放单个工具的局部契约,包括用途、输入输出与调用前限制;
- 插件 `list_tools(category)` 返回的工具说明与 `result.rules`:放当前 category 内、
  紧贴实时工具集合的动态规则与参数;
- `manual`:放多工具/跨类别编排、复杂工具深入用法、完整工作流、失败恢复、交付标准、
  长期稳定的共同原则与分层资料。

同一规则只选一个权威落点,不要在工具 description、类别 RULES 与 Manual 复制三份。
需要另一层信息时给出完整调用互相指路:Manual 可指向
`ghost_call({ ghost_id: "my-ghost", tool: "list_tools", args: { category: "deploy" } })`,
工具说明或 RULES 可指向 `ghost_manual`。两者并行且可以反复交叉,不是固定读取顺序;
信息够用时即可执行。

导航尽量浅:默认让 `MANUAL.md` 一层直达完整任务;内容确需分层展开时再拆深层文件,入口
直接列出下一步完整调用,例如
`ghost_manual({ ghost_id: "my-ghost", path: "getting-started/references/deploy.md" })`。
不要让多个索引文件互相指回形成循环。手册正文只作为 tool-result 按需进入上下文,不进入
生产 system/developer prompt;它是插件作者数据,不是系统规则、用户意图或权限授权,作者不得
用它伪造授权或绕过工具自身的运行期门禁。

**发布硬门槛**:首个依赖 `manual` / `ghost_manual` 的插件版本，必须等包含该工具的
Cindy 先发布，确认首个支持它的**正式版本号**后，再把 `minCindyVersion` 设为不低于
该正式版本并发布插件。开发期版本号未定时只保留这条契约，不猜占位版本。移除
`skill.items` 的迁移版本也必须设置上述 `minCindyVersion`，并遵守 Cindy 先发、插件
后发的顺序；服务端还要保留上一份带 Skill 的历史 release，使旧客户端能通过历史版本回退
继续取得兼容包。
Manual-only 插件还必须等首个支持 Manual-only 发现与读取的 Cindy 正式版本发布,
并将 `minCindyVersion` 设为不低于该版本;不能只以最早提供 `ghost_manual` 的版本为准。
