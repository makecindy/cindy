ALTER TABLE `pi_usage_receipts` ADD `pricing_payload` text;--> statement-breakpoint
CREATE INDEX `pi_usage_receipts_pending_idx` ON `pi_usage_receipts` (`priced`);