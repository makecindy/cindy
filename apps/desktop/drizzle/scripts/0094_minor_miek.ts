import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const rightSidebarTabs = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'right_sidebar_tabs'")
    .get();
  if (!rightSidebarTabs) return;
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS right_sidebar_tabs_bot_artifacts_singleton_idx
      ON right_sidebar_tabs (session_id)
      WHERE kind = 'bot-artifacts'
  `);
}

module.exports = { run };
