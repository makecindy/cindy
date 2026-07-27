-- 0082: schedules 增加 automatic claim 的独立 firedAt 标记。
-- SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，无法安全重放；
-- 实际加列在配套脚本 scripts/0082_breezy_captain_america.ts 中用 PRAGMA table_info 守卫完成。
SELECT 1;
