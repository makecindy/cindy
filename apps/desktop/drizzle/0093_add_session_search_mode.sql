-- 搜索模式一级开关。SQLite ALTER TABLE ADD COLUMN 不能安全重放,
-- 真正的加列放在 scripts/0093_add_session_search_mode.ts 里做 PRAGMA 守卫。
SELECT 1;
