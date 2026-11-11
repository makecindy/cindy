ALTER TABLE `hook_group_messages` ADD `image_refs` text;--> statement-breakpoint
DROP TRIGGER `hook_group_message_stats_insert`;--> statement-breakpoint
DROP TRIGGER `hook_group_message_stats_delete`;--> statement-breakpoint
DROP TRIGGER `hook_group_message_stats_update`;--> statement-breakpoint
CREATE TRIGGER `hook_group_message_stats_insert`
AFTER INSERT ON `hook_group_messages`
BEGIN
	INSERT INTO `hook_group_message_stats` (`provider`, `row_count`, `text_bytes`)
	VALUES (new.`provider`, 1, length(CAST(new.`text` AS BLOB)) + coalesce(length(CAST(new.`image_refs` AS BLOB)), 0))
	ON CONFLICT(`provider`) DO UPDATE SET
		`row_count` = `row_count` + 1,
		`text_bytes` = `text_bytes` + excluded.`text_bytes`;
END;--> statement-breakpoint
CREATE TRIGGER `hook_group_message_stats_delete`
AFTER DELETE ON `hook_group_messages`
BEGIN
	UPDATE `hook_group_message_stats`
	SET `row_count` = `row_count` - 1,
		`text_bytes` = max(0, `text_bytes` - length(CAST(old.`text` AS BLOB)) - coalesce(length(CAST(old.`image_refs` AS BLOB)), 0))
	WHERE `provider` = old.`provider`;
	DELETE FROM `hook_group_message_stats`
	WHERE `provider` = old.`provider` AND `row_count` <= 0;
END;--> statement-breakpoint
CREATE TRIGGER `hook_group_message_stats_update`
AFTER UPDATE ON `hook_group_messages`
BEGIN
	UPDATE `hook_group_message_stats`
	SET `row_count` = `row_count` - 1,
		`text_bytes` = max(0, `text_bytes` - length(CAST(old.`text` AS BLOB)) - coalesce(length(CAST(old.`image_refs` AS BLOB)), 0))
	WHERE `provider` = old.`provider`;
	DELETE FROM `hook_group_message_stats`
	WHERE `provider` = old.`provider` AND `row_count` <= 0;
	INSERT INTO `hook_group_message_stats` (`provider`, `row_count`, `text_bytes`)
	VALUES (new.`provider`, 1, length(CAST(new.`text` AS BLOB)) + coalesce(length(CAST(new.`image_refs` AS BLOB)), 0))
	ON CONFLICT(`provider`) DO UPDATE SET
		`row_count` = `row_count` + 1,
		`text_bytes` = `text_bytes` + excluded.`text_bytes`;
END;
