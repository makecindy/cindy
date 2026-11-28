import type Database from 'better-sqlite3';

function columnNames(db: Database.Database, tableName: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info('${tableName}')`)
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
}

function run(db: Database.Database): void {
  const attributionCols = columnNames(db, 'daily_token_attribution');
  if (attributionCols.size > 0 && !attributionCols.has('harness')) {
    db.exec(`
      CREATE TABLE __new_daily_token_attribution (
        day text NOT NULL,
        provider text NOT NULL,
        billing_source text NOT NULL,
        model text NOT NULL,
        harness text DEFAULT 'unknown' NOT NULL,
        input_tokens integer NOT NULL,
        output_tokens integer NOT NULL,
        cache_read_tokens integer NOT NULL,
        cache_create_tokens integer NOT NULL,
        PRIMARY KEY(day, provider, billing_source, model, harness)
      );
      INSERT INTO __new_daily_token_attribution
        (day, provider, billing_source, model, harness, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens)
        SELECT day, provider, billing_source, model, 'unknown', input_tokens, output_tokens, cache_read_tokens, cache_create_tokens
        FROM daily_token_attribution;
      DROP TABLE daily_token_attribution;
      ALTER TABLE __new_daily_token_attribution RENAME TO daily_token_attribution;
    `);
  }
  const firstDayCols = columnNames(db, 'token_reporting_first_day');
  if (firstDayCols.size > 0 && !firstDayCols.has('harness')) {
    db.exec(`
      CREATE TABLE __new_token_reporting_first_day (
        provider text NOT NULL,
        billing text NOT NULL,
        model text NOT NULL,
        harness text DEFAULT 'unknown' NOT NULL,
        generation text NOT NULL,
        input integer NOT NULL,
        output integer NOT NULL,
        cache_read integer NOT NULL,
        cache_write integer NOT NULL,
        PRIMARY KEY(provider, billing, model, harness)
      );
      INSERT INTO __new_token_reporting_first_day
        (provider, billing, model, harness, generation, input, output, cache_read, cache_write)
        SELECT provider, billing, model, 'unknown', generation, input, output, cache_read, cache_write
        FROM token_reporting_first_day;
      DROP TABLE token_reporting_first_day;
      ALTER TABLE __new_token_reporting_first_day RENAME TO token_reporting_first_day;
    `);
  }
  const auxCols = columnNames(db, 'auxiliary_usage_receipts');
  if (auxCols.size > 0 && !auxCols.has('harness')) {
    db.exec("ALTER TABLE auxiliary_usage_receipts ADD harness text DEFAULT 'unknown' NOT NULL");
  }
}

module.exports = { run };
