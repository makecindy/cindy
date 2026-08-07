/**
 * Plugins registration entry —— import this once (side-effect) to register all
 * built-in plugins via their module-top `registerTabKind(...)` calls.
 *
 * Shell 在自己模块顶层 `import './plugins'`,确保 RightSidebarShell 渲染前 registry
 * 已经填好。新增 plugin 只在这里加一行 import,Shell / TabBar / 持久层全不动。
 *
 * Phase 3:file-browser 已就位。
 * Phase 5:web-browser 已就位。
 */

import './file-browser';
import './web-browser';
import './terminal';
import './review';
import './orca-workers';
import './background-tasks';
import './resource-usage';
