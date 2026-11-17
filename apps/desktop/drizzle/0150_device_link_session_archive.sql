CREATE TABLE `session_archive_receipts` (
	`controller_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`session_instance` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`revision` integer NOT NULL,
	`archived` integer NOT NULL,
	PRIMARY KEY(`controller_id`, `operation_id`)
);
--> statement-breakpoint
CREATE INDEX `session_archive_receipts_session_idx` ON `session_archive_receipts` (`session_id`,`session_instance`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `archive_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `archive_instance` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `remote_restored_at` integer;
--> statement-breakpoint
CREATE TRIGGER `sessions_archive_instance`
AFTER INSERT ON `sessions`
BEGIN
  UPDATE `sessions` SET `archive_instance` = lower(hex(randomblob(16))) WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `sessions_archive_revision`
AFTER UPDATE OF `status` ON `sessions`
WHEN OLD.`status` IS NOT NEW.`status`
BEGIN
  UPDATE `sessions` SET `archive_revision` = OLD.`archive_revision` + 1 WHERE `id` = NEW.`id`;
END;
