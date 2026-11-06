# Debian A1 交接文档（host 为唯一 runtime）

## 背景

目标：Electron 不再持有 Runtime，只作为客户端。网页端与桌面端读写同一份数据库/设置，
消息、设置、模型配置全部同步，实时一致。

当前 Debian 机器上已安装 Cindy 0.1.109（/usr/lib/cindy），而 dev checkout
~/development/cindy 处于 feat/cindy-host 分支（commit d4f8d6ea70），
migration 已到 seq 129，安装版只到 128。直接让 dev host 打开安装版的 profile
会把数据库 schema 推到 129，安装版客户端会拒绝启动（MIGRATE_FAILED）。
所以 A1 的前提是：两边用同一套二进制/同一套 schema。

## 当前状态（2026-11-06）

- cindy-host.service：disabled，已停。
- cindy-desktop.service：enabled，正常跑安装版客户端，持有 DB。
- Dev host 代码已提交并推送到 origin feat/cindy-host（commit d4f8d6ea70）。
- 迁移前备份：~/.config/CindyGlobal/cindy-cmv9i0xz401c8yg013q3zkqb0.db.bak.2026-11-06T09-21-16-798Z
  和 cindy-cmv9i0xz401c8yg013q3zkqb0.db.hostmigrated-*。

## A1 要做的事（按顺序）

1. 构建桌面端二进制：
   cd ~/development/cindy
   pnpm --filter desktop run typecheck
   pnpm --filter desktop run build
   已知风险：Electron Forge 打包在本机上曾出现 V8 堆 OOM 和 better-sqlite3
   ABI 不匹配。建议先用 pnpm --filter desktop dev 试跑，确认主进程能以 client
   模式启动（日志出现 client mode: delegating to ...）。

2. 让 host 重新接管 profile：
   systemctl --user start cindy-host.service
   host 会自动 discover owner cmv9i0xz401c8yg013q3zkqb0。

3. 让桌面端以 client 模式启动：CINDY_HOST_API=http://127.0.0.1:3456 或 rely on
   host-endpoint.json auto-discovery。

4. 验证：网页与桌面显示同一账号、同一会话列表；桌面发消息网页实时可见；
   设置页改动两边同步。

## 现有改动清单（commit d4f8d6ea70）

- apps/host/src/profile-settings.mjs（新增）：按桌面路径读写所有设置。
- apps/host/src/main.ts：bootValues 从 profile 文件读取；/api/profile；
  /api/settings/{appearance,layout,sidebar,shortcuts}；accountUser 从 adopted session
  解析；/api/project-aliases/list。
- apps/host/src/server.mjs：新增 profile/settings/project-aliases 路由。
- apps/web/shim.js：appearance/layout/analytics/sidebar/shortcuts/voiceInput 从 host
  读取；WindowControls 在浏览器里隐藏。
- apps/desktop/src/renderer/components/title-bar/WindowControls.tsx：
  __CINDY_HOST_WEB__ 为真时返回 null。

## 未完成项（A1 完成后继续）

- 侧栏会话列表仍依赖 25+ 个未代理通道。
- 输入框 Model Details Unavailable / Disconnected：模型目录和连接态未接。
- 版本号 0.0.0-host：应从桌面版本号读取。
- 实时双向同步：双方都连同一个 host 事件流后自动成立。

## 回滚方式

如果 A1 构建失败或数据异常：
1. 停止 host 与桌面端。
2. 恢复数据库：
   cd ~/.config/CindyGlobal
   cp cindy-cmv9i0xz401c8yg013q3zkqb0.db.bak.2026-11-06T09-21-16-798Z cindy-cmv9i0xz401c8yg013q3zkqb0.db
   rm -f cindy-cmv9i0xz401c8yg013q3zkqb0.db-wal cindy-cmv9i0xz401c8yg013q3zkqb0.db-shm
3. 恢复 cindy-desktop.service 为原内容（备份见
   cindy-desktop.service.bak-20261106-163441）。
4. systemctl --user daemon-reload && systemctl --user start cindy-desktop.service。
