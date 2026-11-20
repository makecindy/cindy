ALTER TABLE `schedules` ADD `primary_host_key` text;
--> statement-breakpoint
-- Older Contacts drafts had no origin column. Bind its generated prompts and
-- recognizable localized tidy jobs without changing their enabled/paused state.
UPDATE schedules SET primary_host_key = 'public/cindy-contacts'
WHERE coalesce(execution_mode, 'agent') = 'agent'
  AND instr(prompt, 'cindy-contacts') > 0 AND instr(prompt, 'maintenance') > 0
  AND instr(prompt, 'begin') > 0 AND instr(prompt, 'run_id') > 0
  AND (name IN ('整理通讯录', 'Tidy up contacts', '連絡先を整理', '연락처 정리') OR prompt LIKE '整理我的通讯录（cindy-contacts 插件）。%')
  AND instr(prompt, 'namespace 传「') = 0;
