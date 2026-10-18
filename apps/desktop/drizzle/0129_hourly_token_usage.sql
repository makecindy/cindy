CREATE TABLE `hourly_token_usage` (
	`day` text NOT NULL,
	`hour` integer NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `hour`)
);
--> statement-breakpoint
CREATE TRIGGER `hourly_token_usage_insert`
AFTER INSERT ON `daily_model_usage`
WHEN NEW.input_tokens + NEW.output_tokens + NEW.cache_read_tokens + NEW.cache_create_tokens > 0
BEGIN
  INSERT INTO `hourly_token_usage` (`day`, `hour`, `tokens`)
  VALUES (
    NEW.day,
    CAST(strftime('%H', NEW.updated_at / 1000.0, 'unixepoch', 'localtime') AS INTEGER),
    NEW.input_tokens + NEW.output_tokens + NEW.cache_read_tokens + NEW.cache_create_tokens
  )
  ON CONFLICT (`day`, `hour`) DO UPDATE SET `tokens` = `tokens` + excluded.tokens;
END;
--> statement-breakpoint
CREATE TRIGGER `hourly_token_usage_update`
AFTER UPDATE OF `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_create_tokens` ON `daily_model_usage`
WHEN NEW.input_tokens + NEW.output_tokens + NEW.cache_read_tokens + NEW.cache_create_tokens
  > OLD.input_tokens + OLD.output_tokens + OLD.cache_read_tokens + OLD.cache_create_tokens
BEGIN
  INSERT INTO `hourly_token_usage` (`day`, `hour`, `tokens`)
  VALUES (
    NEW.day,
    CAST(strftime('%H', NEW.updated_at / 1000.0, 'unixepoch', 'localtime') AS INTEGER),
    NEW.input_tokens + NEW.output_tokens + NEW.cache_read_tokens + NEW.cache_create_tokens
      - OLD.input_tokens - OLD.output_tokens - OLD.cache_read_tokens - OLD.cache_create_tokens
  )
  ON CONFLICT (`day`, `hour`) DO UPDATE SET `tokens` = `tokens` + excluded.tokens;
END;
