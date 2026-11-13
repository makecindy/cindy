-- 0150: orca_workers 增加 latest_report(text, nullable)。
-- SQLite 的 ALTER TABLE ADD COLUMN 无 IF NOT EXISTS 语义，无法安全重放（缺表的
-- 合成/残缺库会直接炸链，违反「迁移链必须能走完」的可重放惯例）；实际加列在
-- 配套脚本 scripts/0150_classy_the_renegades.ts 里用 PRAGMA table_info 守卫完成。
-- 注：本迁移在 0.1.137 本地集成线以裸 ALTER 形态发布过，真实库列已存在，
-- 守卫对其收敛为 no-op。
SELECT 1;