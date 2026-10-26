# UI 模拟数据：免登录看真实界面

> **读取时机**：要在 Desktop 或 Mobile 上检查界面、截图、做 UI 回归，又不想登录真实
> 账号或碰真实数据时；新增或修改模拟任务、`--mock` 启动参数时。

Desktop 与 Mobile 共用一套模拟数据：两个项目、十来个不同状态的任务和它们的消息。开发版
加 `--mock` 启动后直接进入主界面，不登录、不连服务器，也不碰任何正式或共享数据。适合检查
任务列表、任务页、消息渲染、深浅色和多语言这类只关心界面的改动；登录、发送、跨设备、
真实 Agent 运行仍要用真实账号验证。

| 端 | 启动 | 数据落在哪 |
| --- | --- | --- |
| Desktop | `pnpm restart:desktop:remote -- --mock` | 独立沙箱 `ui-mock`（与 `dev` 沙箱、正式版分开） |
| Mobile 模拟器 | `pnpm mobile:sim:start -- --mock`（`whoami`、`rebuild` 同样加 `--mock`） | 只在 App 进程内存里 |

## 一套数据，两端共用

正本在 `packages/maker-shared/src/uiMock.ts`（`@cindy/maker-shared/ui-mock`）：

- `UI_MOCK_PROJECTS`：演示项目 `cindy-demo`、`design-system` 及几个小文件。
- `UI_MOCK_TASKS`：运行中、等待确认、排队、置顶、超长标题、英文、无文件夹对话、自动化、
  已归档等任务；`登录页窄窗口错位排查` 一条覆盖标题、表格、代码块、列表、引用、思考与工具
  调用。
- `buildUiMockRows()`：按 Desktop 数据库行的格式生成任务与消息。Mobile 平时从电脑收到的
  也是这些行，所以两端看到的是同一份内容。

`visual-*` 开头的任务 id 被 Mobile 用来叠加运行时状态（运行中、权限确认、排队消息）；
这些状态在 Desktop 上来自真实 Agent，不在数据库里，所以 Desktop 只把它们显示成普通任务。
Mobile 另外保留双端一致性测试用的 `session-primary` 与 Orca 两条任务
（`SHARED_REMOTE_CONTROL_FIXTURE`）。

要加一种界面状态，就在 `UI_MOCK_TASKS` 里加一条任务，两端会一起出现。只用 Desktop
已有的消息格式（`user`、`assistant`、`thinking`、工具调用与结果），不要为模拟数据新增
数据库字段或协议。

## Desktop

```bash
pnpm restart:desktop:remote -- --mock
pnpm restart:desktop:remote -- --mock --isolated=<名字>   # 另开一份模拟沙箱，可与别的 worktree 并行
```

- 默认沙箱名 `ui-mock`，其余规则与「Agent 启动入口」的隔离沙箱完全一致；仍以
  `DESKTOP_DEV_VERDICT=ready` 为启动成功的唯一依据。
- 新沙箱首次启动直接进入免账号的「未登录」模式（相当于点过一次「跳过登录」）。之后在
  沙箱里自己登录或切换模式，以你的选择为准。
- 每次本地数据库就绪时补齐缺失的模拟任务；已存在的任务不覆盖，测试中改名、归档、删消息等
  改动会保留，删掉的模拟任务下次启动重新出现。演示项目写在沙箱的 `ui-mock/projects/`。
- 想回到初始状态：退出这个实例后删除沙箱目录（启动日志里 `Isolated dev user data` 一行
  给出的路径），再启动一次。
- 生效条件同时满足才会写入：源码运行（非安装包）、`--mock`、隔离沙箱、免账号的本地数据
  所有者。`--mock` 与 `--shared`、`--preserve-running` 组合直接拒绝；安装包或共享
  profile 里即使环境变量残留也会被忽略。实现见 `apps/desktop/src/main/index.ts`、
  `localDb/uiMockSeed.ts`。
- 单个组件的改动仍优先用 `pnpm ui:check`（几秒出全部场景截图）；`--mock` 用于需要完整
  主界面、真实路由和侧栏交互的检查。

## Mobile 模拟器

```bash
pnpm mobile:sim:start -- --mock
pnpm mobile:sim:whoami -- --mock --json
```

- 只换 JS bundle 的环境变量 `EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK=1`，不改原生指纹，已装的
  开发包可以直接用。
- 开关是 Metro 环境的一部分：在真实数据和模拟数据之间切换时，`sim:start` 会提示 Metro 是旧
  环境，加 `--takeover` 重启；`whoami` 不带相同的 `--mock` 会判定环境不一致。
- App 里是一台在线的模拟电脑和一台离线电脑，任务、消息、插件演示、文件浏览都由
  `apps/mobile/src/debug/visualMock.ts` 在内存里提供，写操作只在本次进程内生效，重启即还原。
- 生效条件是开发构建（`__DEV__`）；正式包不包含这条路径。

## 边界

- 模拟数据只用于开发与界面验收，不进安装包逻辑，不上传，不触发真实 Agent。
- 不在模拟数据里放真实姓名、邮箱、路径或聊天内容；要用真实数据预览手机界面时用
  `apps/mobile/scripts/export-realdata-visual-snapshot.mjs`，它导出的是敏感数据，按脚本
  里的限制使用。
- PR 截图来自模拟数据时要写明，不能当作真实账号、真实 Agent 行为已验证的证据。
