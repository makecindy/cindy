CREATE TABLE IF NOT EXISTS `hook_group_message_stats` (
	`provider` text PRIMARY KEY NOT NULL,
	`row_count` integer NOT NULL,
	`text_bytes` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `hook_group_message_stats` (`provider`, `row_count`, `text_bytes`)
SELECT `provider`, count(*), coalesce(sum(length(CAST(`text` AS BLOB))), 0)
FROM `hook_group_messages`
GROUP BY `provider`
ON CONFLICT(`provider`) DO UPDATE SET
	`row_count` = excluded.`row_count`,
	`text_bytes` = excluded.`text_bytes`;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `hook_group_message_stats_insert`
AFTER INSERT ON `hook_group_messages`
BEGIN
	INSERT INTO `hook_group_message_stats` (`provider`, `row_count`, `text_bytes`)
	VALUES (new.`provider`, 1, length(CAST(new.`text` AS BLOB)))
	ON CONFLICT(`provider`) DO UPDATE SET
		`row_count` = `row_count` + 1,
		`text_bytes` = `text_bytes` + excluded.`text_bytes`;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `hook_group_message_stats_delete`
AFTER DELETE ON `hook_group_messages`
BEGIN
	UPDATE `hook_group_message_stats`
	SET `row_count` = `row_count` - 1,
		`text_bytes` = max(0, `text_bytes` - length(CAST(old.`text` AS BLOB)))
	WHERE `provider` = old.`provider`;
	DELETE FROM `hook_group_message_stats`
	WHERE `provider` = old.`provider` AND `row_count` <= 0;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `hook_group_message_stats_update`
AFTER UPDATE ON `hook_group_messages`
BEGIN
	UPDATE `hook_group_message_stats`
	SET `row_count` = `row_count` - 1,
		`text_bytes` = max(0, `text_bytes` - length(CAST(old.`text` AS BLOB)))
	WHERE `provider` = old.`provider`;
	DELETE FROM `hook_group_message_stats`
	WHERE `provider` = old.`provider` AND `row_count` <= 0;
	INSERT INTO `hook_group_message_stats` (`provider`, `row_count`, `text_bytes`)
	VALUES (new.`provider`, 1, length(CAST(new.`text` AS BLOB)))
	ON CONFLICT(`provider`) DO UPDATE SET
		`row_count` = `row_count` + 1,
		`text_bytes` = `text_bytes` + excluded.`text_bytes`;
END;
