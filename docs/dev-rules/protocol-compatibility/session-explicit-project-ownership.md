# Session 显式项目归属（2026-10-30）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Session 列表与搜索摘要新增可选 `projectDir`，数据库 migration 0137 新增可空
`sessions.project_dir`。项目任务的缺省/null 继续按 `workingDir` 归组；
`workspaceKind: dialogue` 始终表示不绑项目，不从执行目录推断归属。新值只用于项目身份，
命令、文件、Git 与权限仍使用实际 `workingDir`。新客户端兼容旧宿主缺字段；旧客户端
忽略新字段，执行目录与项目不同时仍显示旧分组，需升级查看端获得一致归属。
没有修改 device-link allowlist、账号边界或任务路径权限。

灵动岛沿用同一归属：本机元数据读取和移动更新保留 `projectDir`，远程任务经现有
Renderer → Main 输入附带可选 `projectDir`，旧输入缺字段时回落到执行目录。
该字段只影响项目名称；伙伴群名和无项目任务的显示规则保持原样，不新增 channel 或能力。

手机首页与桌面远程镜像的既有列表缓存保留可选 `projectDir`（含显式 null），路径不截断，
旧缓存缺字段时继续回落到执行目录。移动菜单由共享组件按同一归属规则禁用当前项目，
避免把仍在 checkout 执行的任务误移回项目根目录；不新增缓存或存储版本。

跨电脑复制未另选目标项目时，沿用既有 destination 描述传递源项目的相对路径，
优先读取显式归属（不折叠已登记的 worktree 项目）；旧任务仍从 cwd 推断。
归属只决定目标项目位置，打包与恢复仍使用实际执行目录，不扩充复制协议或权限。

本机 Agent 工具的新建模式中，省略 `project_path` 继承来源归属，字符串选择已有项目，
显式 `null` 创建不绑项目的任务；适配层必须保留缺省与 null 的区别。
无法确定来源归属时明确失败，不以新执行目录登记项目。来源不绑项目且省略 `project_path` 时，
宿主按请求的 `working_dir` 向上匹配最近的已登记可见项目（`resolveSessionProject`），匹配不到
仍不绑项目；创建回执新增可选 `project_note`，旧调用方忽略即可。
不绑项目且未传 `working_dir` 时复用既有托管目录创建流程；传目录或使用 worktree 也不改变归属。
创建回执返回 `project_path`、实际 `working_dir` 与 `workspace_kind`；
`list_projects` / `create_project` 保留 `working_dir` 并新增 `project_path` 回执。
`list_projects` 另新增 `projects_root`（`path`、`source`：`setting`／`inferred`／`default`、`exists`），只读、仅本机；旧调用方忽略该字段即可（#8259）。
`send_to_session` 的既有任务投递不要求项目，跨电脑投递合同不变。
