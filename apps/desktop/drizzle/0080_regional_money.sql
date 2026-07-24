-- 0080: 新增区域金额投影；旧 USD 列保留且不回填。
-- ALTER TABLE 由 companion TS 按表/列存在性幂等执行，以兼容 partial lineage replay。
SELECT 1;
