import type Database from 'better-sqlite3';
import { TASK_TAG_PRESETS } from '@cindy/maker-shared';

/** Called only when this owner first receives the task-tag schema. */
export function initializeTaskTagPresets(db: Database.Database): void {
  db.transaction(() => {
    const rows = db
      .prepare('SELECT id,name,color,revision,favorite_order,sort_order FROM task_tags')
      .all() as Array<{
      id: string;
      name: string;
      color: string;
      revision: number;
      favorite_order: number | null;
      sort_order: number | null;
    }>;
    const originalColors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
    // Only adjust the exact untouched seed from migration 0110. Never replace
    // a user directory, even when it happens to contain seven labels.
    if (
      rows.length !== originalColors.length ||
      originalColors.some(
        (color, index) =>
          !rows.some(
            (row) =>
              row.id === `default:${color}` &&
              row.color === color &&
              row.name === color[0].toUpperCase() + color.slice(1) &&
              row.revision === 1 &&
              row.favorite_order === index &&
              row.sort_order === index,
          ),
      )
    )
      return;
    if (db.prepare('SELECT 1 FROM session_task_tags LIMIT 1').get()) return;
    // Keep the first six color labels, then append the six semantic labels.
    // Gray remains available as a color and is used by the Reference preset.
    db.prepare("DELETE FROM task_tags WHERE id='default:gray'").run();
    const insert = db.prepare(
      'INSERT INTO task_tags(id,name,color,favorite_order,sort_order) VALUES(?,?,?,?,?)',
    );
    TASK_TAG_PRESETS.forEach((tag, index) =>
      insert.run(tag.id, tag.name, tag.color, index + 6, index + 6),
    );
  })();
}
