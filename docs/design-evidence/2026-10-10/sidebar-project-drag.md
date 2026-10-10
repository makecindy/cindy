# 侧栏任务跨项目拖动：UI 交付证据

对应 [PR #5713](https://github.com/makecindy/cindy/pull/5713)。
日期：2026-10-10。平台：macOS arm64 / Electron 41.10.3，完整隔离应用，
1280 × 1200 CSS px。主进程启动基线为 `f87e68030cef9502af48ad51de335dc1ca9a74dc`；
Renderer 经 HMR 更新至 `5cb5b0647ef1790dfa50887da3dcd9cf041ec0bc`，
三个受影响 Renderer 文件的 SHA-256 均与该提交逐字比对。

## 新增可见层与规范核对

依据 [DESIGN.md](../../design-rules/DESIGN.md) §2、§5、§10、§14。
自动颜色检查无新增原始颜色或意外命中；三条 `report/visible-layer-radius`
为可见层分类报告，逐项结论如下，不将报告本身视为自动合规证明。

| 可见层 | 分类与实际实现 | 运行期检查 |
| --- | --- | --- |
| Project 分组落点外框 | 包含标题和多条任务的内容容器；`rounded-xl`，12px | 浅深主题、列表及置顶多列卡片均为 12px |
| Chat 分组落点外框 | 包含标题和多条任务的内容容器；`rounded-xl`，12px | 浅深主题均为 12px |
| 临时 Move to Chat 落点 | 单一移动动作入口；保留 pill，最小高度 32px、水平内边距 12px | 拖动期间可见，`user-select: none` |

Project 与 Chat 的落点背景使用 `sidebar-item-hover`，1px 内描边使用
`border-default`。实测浅色边框 `#E4E4DF`、深色 `#313131`，均与主题 token 一致；
没有用键盘 Focus Blue 表示拖放。全部新增控制层文字禁止选择，长标题保留现有截断。
背景、描边不改变布局尺寸，不引入浮起阴影。右键移动入口保留，不增加确认弹窗。

离开当前落点立即清除高亮并取消延迟展开；在同一落点内部穿过子元素保留计时。
有效移动接管 drop 后不提交途经置顶区域产生的临时排序；正常排序仍可独立使用。

## 验证结果

使用隔离实例中的合成验收任务，未发送模型请求。真实输入先触发 Chromium 原生拖动，
随后由 CDP 投递捕获的原生拖动数据；移动走生产 Renderer → IPC → 主机 → 数据库。
IPC 仅额外用于准备数据、偏好和读取断言。

- **22/22 完整应用矩阵**：Light/Dark × 列表、置顶两列、置顶三列；12 次 Project/Chat
  归类移动、6 次实际改变顺序的普通置顶排序，以及列表下 4 次离开/取消。
  每次移动确认数据库归属、置顶顺序不变及重新加载后的持久化；每次排序确认新顺序持久化。
  主项目列表本身无卡片模式，多列指置顶区域。
- **独立跨目录补证**：每种主题各一次通过 UI 移入 A，再通过 UI 从 A 移至 B，4/4 通过。
  A→B 前后均为项目任务且工作目录不同；均验证数据库、置顶顺序与重新加载。
  上述矩阵的 12 次移动主要是保留目录 B 的 Chat/Project 归类切换，不冒充 12 次跨目录移动。
- **Chat 近景补证**：两种主题下真实悬停非空 Chat 分组，取消后数据库和置顶顺序未改变。
- **3 条键盘路径**：Tab 到达 Project/Chat 标题，Enter 展开或切换，Space 收起或恢复；
  Escape 关闭实际任务菜单。未把 CDP `dragCancel` 记作系统 Escape 拖动验收。
- **自动回归**：拖放与排序隔离 2 文件 / 29 项通过，Desktop 全量类型检查通过，
  `git diff --check` 通过。新增回归先在旧实现中复现同侧栏留白未取消展开，修正后通过。

独立目检四张浅深 Project/Chat 近景及浅色两列、深色三列代表图，未发现本次新增落点的
明确视觉缺口；长标题截断、多条任务外框及相邻分组边界清楚。

## 公开截图证据

下列页面含可保存为 `.html` 的自包含代码，直接内嵌真实 Electron PNG 原始字节，
无脚本或外部请求。近景为 296 × 223，表示实际悬停，不表示移动完成。
PNG 保留渲染器透明度，展示页以主题背景承接，不冒充系统磨砂最终合成。
图片不存入产品 Git 仓库。

| 主题 | 非空 Project 落点 | 非空 Chat 落点 |
| --- | --- | --- |
| 浅色 | [PR 正文](https://github.com/makecindy/cindy/pull/5713) | [HTML 证据](https://github.com/makecindy/cindy/pull/5713#issuecomment-6095401339) |
| 深色 | [HTML 证据](https://github.com/makecindy/cindy/pull/5713#issuecomment-6095402612) | [HTML 证据](https://github.com/makecindy/cindy/pull/5713#issuecomment-6095405446) |

## 验证边界

Windows、远端双电脑、系统鼠标/键盘拖动全链路、触屏、读屏及全部键盘流程未实测。
既有组件 harness 的 pointer fallback 结果与本次完整应用结果分别记录。
这些证据不验证 PR #5714 的运行中任务后台移动。维护者/设计师最终视觉批准及仓库 CI
仍按 PR 门禁执行，局部通过不代表合并批准。
