import type Database from 'better-sqlite3';

import { createLogger } from '../logger';

const log = createLogger('localDb/codex-history-prompt-init');
const LEGACY_INIT_META_KEY = 'codex_history_has_product_prompt_initialized_v1';
const CINDY_MEMORY_PROMPT_RESET_META_KEY = 'codex_history_cindy_memory_prompt_reset_v2';
const PRODUCT_PROMPT_REVISION_META_KEY = 'codex_history_product_prompt_revision';

/**
 * Bump whenever the Cindy-owned Codex developer-instruction snapshot changes.
 * The startup initializer will re-arm each delivered direct-resume thread once;
 * a successful native delivery flips that session's existing boolean back to true.
 */
export const CODEX_PRODUCT_PROMPT_REVISION = '3';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === column);
}

/**
 * One-time data init after the nullable column is added:
 * legacy rows predate codex-proxy, so their Codex thread history already has
 * the product developer prompt. New NULLs after this guard are intentionally
 * left unknown so resume can fail toward restore.
 */
export function initializeCodexHistoryPromptState(db: Database.Database): void {
  if (!hasColumn(db, 'sessions', 'codex_history_has_product_prompt')) {
    log.warn('codex history prompt state init skipped: column missing');
    return;
  }

  const readMeta = (key: string): string | null | undefined => {
    const row = db
      .prepare(`SELECT value FROM migration_meta WHERE key=?`)
      .get(key) as { value: string | null } | undefined;
    return row?.value;
  };
  const writeMeta = (key: string, value = 'done'): void => {
    db
      .prepare(
        `INSERT INTO migration_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(key, value);
  };

  if (readMeta(LEGACY_INIT_META_KEY) !== 'done') {
    const updated = db.transaction(() => {
      const result = db
        .prepare(`
          UPDATE sessions
          SET codex_history_has_product_prompt = 1
          WHERE codex_history_has_product_prompt IS NULL
        `)
        .run();
      writeMeta(LEGACY_INIT_META_KEY);
      return result.changes;
    })();
    log.info('codex history prompt state initialized', { updated });
  }

  // cindy_memory rename: threads whose history contains the old product prompt still
  // instruct the model to use lizi_memory. Mark them as needing the existing one-shot
  // non-proxy restore path; successful delivery writes the state back to true.
  if (readMeta(CINDY_MEMORY_PROMPT_RESET_META_KEY) !== 'done') {
    const updated = db.transaction(() => {
      const result = db
        .prepare(`
          UPDATE sessions
          SET codex_history_has_product_prompt = 0
          WHERE codex_history_has_product_prompt = 1
        `)
        .run();
      writeMeta(CINDY_MEMORY_PROMPT_RESET_META_KEY);
      return result.changes;
    })();
    log.info('codex history prompt state reset for cindy_memory rename', { updated });
  }

  // The per-session delivery flag deliberately remains boolean: migration_meta owns
  // the product revision globally. A revision mismatch re-arms only sessions that
  // previously completed native delivery; false/unknown rows keep their fail-safe state.
  if (readMeta(PRODUCT_PROMPT_REVISION_META_KEY) !== CODEX_PRODUCT_PROMPT_REVISION) {
    const updated = db.transaction(() => {
      const result = db
        .prepare(`
          UPDATE sessions
          SET codex_history_has_product_prompt = 0
          WHERE codex_history_has_product_prompt = 1
        `)
        .run();
      writeMeta(PRODUCT_PROMPT_REVISION_META_KEY, CODEX_PRODUCT_PROMPT_REVISION);
      return result.changes;
    })();
    log.info('codex history prompt state reset for product prompt revision', {
      revision: CODEX_PRODUCT_PROMPT_REVISION,
      updated,
    });
  }
}
