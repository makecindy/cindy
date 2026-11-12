import { describe, expect, it } from 'vitest';

import {
  CODEX_PRODUCT_PROMPT_REVISION,
  initializeCodexHistoryPromptState,
} from '../localDb/codexHistoryPromptInit';

function createFakeDb() {
  const meta = new Map<string, string | null>();
  const sessions = new Map<string, boolean | null>();
  return {
    meta,
    sessions,
    db: {
      prepare(sql: string) {
        if (sql.includes('PRAGMA table_info(sessions)')) {
          return {
            all() {
              return [{ name: 'id' }, { name: 'codex_history_has_product_prompt' }];
            },
          };
        }
        if (sql.includes('SELECT value FROM migration_meta')) {
          return {
            get(key: string) {
              return meta.has(key) ? { value: meta.get(key) ?? null } : undefined;
            },
          };
        }
        if (sql.includes('UPDATE sessions')) {
          return {
            run() {
              let changes = 0;
              if (sql.includes('SET codex_history_has_product_prompt = 1')) {
                for (const [id, value] of sessions) {
                  if (value === null) {
                    sessions.set(id, true);
                    changes += 1;
                  }
                }
              } else if (sql.includes('SET codex_history_has_product_prompt = 0')) {
                for (const [id, value] of sessions) {
                  if (value === true) {
                    sessions.set(id, false);
                    changes += 1;
                  }
                }
              }
              return { changes };
            },
          };
        }
        if (sql.includes('INSERT INTO migration_meta')) {
          return {
            run(key: string, value: string) {
              meta.set(key, value);
            },
          };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
      transaction<T>(fn: () => T) {
        return () => fn();
      },
    },
  };
}

describe('initializeCodexHistoryPromptState', () => {
  it('marks legacy rows for one-time prompt restoration after the cindy_memory rename', () => {
    const fake = createFakeDb();
    fake.sessions.set('old', null);
    fake.sessions.set('history-prompt', true);
    fake.sessions.set('proxy', false);

    initializeCodexHistoryPromptState(fake.db as never);

    expect(fake.sessions.get('old')).toBe(false);
    expect(fake.sessions.get('history-prompt')).toBe(false);
    expect(fake.sessions.get('proxy')).toBe(false);
    expect(fake.meta.get('codex_history_has_product_prompt_initialized_v1')).toBe('done');
    expect(fake.meta.get('codex_history_cindy_memory_prompt_reset_v2')).toBe('done');
    expect(fake.meta.get('codex_history_product_prompt_revision')).toBe(
      CODEX_PRODUCT_PROMPT_REVISION,
    );
  });

  it('does not touch later rows after both one-time guards are set', () => {
    const fake = createFakeDb();
    initializeCodexHistoryPromptState(fake.db as never);
    fake.sessions.set('later', null);
    fake.sessions.set('current-prompt', true);

    initializeCodexHistoryPromptState(fake.db as never);

    expect(fake.sessions.get('later')).toBeNull();
    expect(fake.sessions.get('current-prompt')).toBe(true);
  });

  it('resets existing v1 history state when upgrading to the cindy_memory prompt', () => {
    const fake = createFakeDb();
    fake.meta.set('codex_history_has_product_prompt_initialized_v1', 'done');
    fake.sessions.set('legacy-prompt', true);

    initializeCodexHistoryPromptState(fake.db as never);

    expect(fake.sessions.get('legacy-prompt')).toBe(false);
    expect(fake.meta.get('codex_history_cindy_memory_prompt_reset_v2')).toBe('done');
  });

  it('re-arms delivered histories once when the product prompt revision changes', () => {
    const fake = createFakeDb();
    fake.meta.set('codex_history_has_product_prompt_initialized_v1', 'done');
    fake.meta.set('codex_history_cindy_memory_prompt_reset_v2', 'done');
    fake.meta.set('codex_history_product_prompt_revision', '2');
    fake.sessions.set('delivered', true);
    fake.sessions.set('pending', false);

    initializeCodexHistoryPromptState(fake.db as never);

    expect(fake.sessions.get('delivered')).toBe(false);
    expect(fake.sessions.get('pending')).toBe(false);
    expect(fake.meta.get('codex_history_product_prompt_revision')).toBe(
      CODEX_PRODUCT_PROMPT_REVISION,
    );

    // Simulate a successful one-shot delivery. The same revision must not re-arm it.
    fake.sessions.set('delivered', true);
    initializeCodexHistoryPromptState(fake.db as never);
    expect(fake.sessions.get('delivered')).toBe(true);
  });

  it('skips initialization when the codex history column is missing', () => {
    const fake = createFakeDb();
    fake.sessions.set('old', null);
    const db = {
      ...fake.db,
      prepare(sql: string) {
        if (sql.includes('PRAGMA table_info(sessions)')) {
          return { all: () => [{ name: 'id' }] };
        }
        return fake.db.prepare(sql);
      },
    };

    initializeCodexHistoryPromptState(db as never);

    expect(fake.sessions.get('old')).toBeNull();
    expect(fake.meta.get('codex_history_has_product_prompt_initialized_v1')).toBeUndefined();
    expect(fake.meta.get('codex_history_cindy_memory_prompt_reset_v2')).toBeUndefined();
    expect(fake.meta.get('codex_history_product_prompt_revision')).toBeUndefined();
  });
});
