# overlay-smoke —— 桌面浮窗（overlay）smoke 测试插件

这是 Task 10 半 1 的端到端验收夹具：一个最小可用的 overlay 插件，用于验证
Cindy Core 新增的「插件桌面浮窗」能力（透明、置顶、不抢焦点、命中切换、点击穿透）。

- 显示一个 96×96 的半透明蓝圆（窗口 160×160）。
- 鼠标移到圆上 → 命中 → `set-interactive(true)`，圆内点击计数 +1；
  移到圆外 → 恢复穿透（点击落到下层应用）。
- 页面（`overlay.html`）是**零桥**页面：不引用 `window.cindy` 或任何 preload 能力，
  命中判定结果只经 `BroadcastChannel` 交给电子脑（`main.js`）转发为
  `overlay-request { kind:'set-interactive' }`。
- 电子脑使用 `launch: 'resident'`：Cindy 启动 / 插件启用即拉起，并立即
  `mount` + `show`，让圆自动出现（与设计 §4.5「猫插件 resident 启动自动 mount」同模型）。
  详情页会因此多一行「常驻运行」披露，属预期。

## 文件

| 文件 | 作用 |
| --- | --- |
| `ghost.json` | 最小合法清单（schemaVersion 3，`overlay` 声明 160×160） |
| `main.js` | 电子脑：挂载浮窗、转发 `overlay-interactive` → `set-interactive` |
| `overlay.html` | 零桥页面：透明底 + 圆样式，通过 `<script src="overlay.js">` 加载命中逻辑（CSP 只允许同源外部脚本） |
| `overlay.js` | 零桥脚本：命中判定、click 计数、显示状态块（同源外部脚本，避开 inline script CSP 限制） |

## 1. 打包成 `.cindy`

`.cindy` 就是 zip。在**本目录**（`__fixtures__/overlay-smoke/`）打开 PowerShell 执行：

```powershell
$src = "<夹具目录绝对路径>"
$zip = "$src\..\overlay-smoke-0.0.3.zip"
Compress-Archive -Path "$src\ghost.json","$src\main.js","$src\overlay.html","$src\overlay.js" -DestinationPath $zip -Force
Move-Item $zip "$src\..\overlay-smoke-0.0.3.cindy" -Force
```

- `Compress-Archive` 只接受 `.zip` 扩展名，故**先产出 `.zip` 再改名为 `.cindy`**（`.cindy` 本身即 zip）。
- 只打包这四个文件（README 不进包）。`ghost.json` 必须位于 zip 根目录。
- `-Force` 会覆盖已存在的旧 `.zip`；`Move-Item -Force` 覆盖旧 `.cindy`。

## 2. 在 Cindy 本地安装

1. 打开 Cindy，进入「插件」入口（Plugins）。
2. 本地安装：把 `overlay-smoke-0.0.3.cindy` 拖入窗口，或从磁盘选择该文件。
3. 按确认框完成安装与授权（resident 常驻会多一行如实披露）。
4. 确认插件已启用。启用的同时电子脑被拉起，圆应自动出现在屏幕上。

> **更新已安装的旧版本**：Cindy 本地安装不会原地替换已装的同名插件；更新前请先在插件
> 管理里**卸载旧版**（如 0.0.2），再安装新版（0.0.3），或按 Cindy 插件更新流程操作，
> 否则可能仍加载旧包。

## 3. 人工验收清单（对照设计 §6.3 的 Core 项）

> 本夹具只覆盖 mount/show/set-interactive + 命中/计数；`move` 多显示器与
> `cursor-subscribe` 光标流需要调用这些接口的插件（如像素猫）另验，本 smoke 不涉及。

- [ ] **1. 透明表现**：圆显示且半透明蓝；无边框、无阴影、无任务栏图标、无标题栏。
- [ ] **2. 圆外点击穿透**：把鼠标移到圆的**外面**（窗口透明四角），点击应落到桌面或
      下层应用（如记事本获得点击/光标）。
- [ ] **3. 圆内点击计数**：鼠标移入圆内（状态块 `hit: yes`），单击圆内，状态块
      `click` 计数 +1；连续多点几下，计数同步递增。
- [ ] **4. 打字不中断（记事本垫底）**：在记事本连续打字，同时鼠标多次掠过浮窗
      （进出圆），无输入丢失、无焦点切换（焦点始终在记事本）。
- [ ] **5. 详情页开关生效后可再开**：在插件详情页关闭「桌面浮窗」→ 圆消失，且
      此时电子脑再 mount 被拒（结构化 `OVERLAY_USER_DISABLED`）；重新开启开关 →
      圆可再显示。
- [ ] **6. 禁用/卸载后无残留**：禁用或卸载插件 → 浮窗窗口销毁、无残留；
      重新安装/启用后恢复正常。
- [ ] **7. 任务管理器空闲无持续 CPU**：圆静止、无鼠标掠过时，观察任务管理器中
      Cindy 相关进程空闲无持续 CPU（光标流随 hide 停止；本 smoke 未订阅光标流，
      也不应有持续动画）。
- [ ] **8. 杀渲染进程主应用不受影响**：用 devTools 或任务管理器结束浮窗渲染进程 →
      Cindy 主应用不受影响、不崩溃，浮窗恢复有界（一次以内）。

## 附：链路回顾（实现对齐）

```
overlay.html（零桥）                main.js（电子脑）                宿主
  mousemove 命中判定 ──BroadcastChannel──▶ overlay-interactive
                                                        ──cindy.send──▶ overlay-request
                                                                        { kind:'set-interactive',
                                                                          interactive }
                                                        ◀────────────  setIgnoreMouseEvents(false/true)
  click 计数（仅交互态收到）
```
