-- 0090: sessions 增加 Codex 原生计划状态。
-- SQLite 的 ALTER TABLE ADD COLUMN 无 IF NOT EXISTS 语义，无法安全重放；
-- 实际加列在配套脚本 scripts/0090_slow_big_bertha.ts 里用 PRAGMA table_info 守卫完成。
SELECT 1;
