/**
 * VecTableRegistry — vec_table_meta 元信息读写 + 进程内缓存。
 *
 * Phase 1.1 范围:
 *   - registerVecTable 写元信息表 (INSERT OR IGNORE), 内存 cache 同步
 *   - getVecTableMeta(name) 查询 (走内存 cache, miss 时 fallback 查 DB)
 *   - list() 列举所有已注册
 *
 * 不做:
 *   - 不验证 vec0 虚表本身是否存在 (consumer 自己 CREATE VIRTUAL TABLE)
 *   - 不创建 vec 表 (Phase 1.2 consumer 接入时自决)
 *   - 不 reconcile / drop / 版本迁移 (将来如有 schema 演进再说)
 */

import type { DbLogger } from '../logging.js';
import type { DbClient } from '../client/DbClient.js';

export interface VecTableSpec {
  vecTable: string;
  source: string;
  modelId: string;
  /** 必须严格等于 model.dim, 否则后续 INSERT 会被 vec0 拒绝。 */
  dim: number;
  notes?: string;
}

interface VecTableRow {
  vec_table: string;
  source: string;
  model_id: string;
  dim: number;
  registered_at: number;
  notes: string | null;
}

export class VecTableRegistry {
  private readonly cache = new Map<string, VecTableSpec>();
  private loaded = false;

  constructor(
    private readonly getDbClient: () => DbClient,
    private readonly log: DbLogger,
  ) {}

  /** 启动时一次性 load 全表到内存 (cheap — 量级几十条以内)。 */
  preload(): void {
    if (this.loaded) return;
    this.loaded = true;
    void this.getDbClient()
      .query<VecTableRow>(
        `SELECT vec_table, source, model_id, dim, registered_at, notes
           FROM vec_table_meta`,
      )
      .then((rows) => {
        for (const r of rows) {
          this.cache.set(r.vec_table, rowToSpec(r));
        }
        this.log.info(
          JSON.stringify({
            event: 'embeddingHost.vecTableRegistry.preload',
            count: rows.length,
          }),
        );
      })
      .catch((err) => {
        this.log.warn(
          JSON.stringify({
            event: 'embeddingHost.vecTableRegistry.preload.failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      });
  }

  /**
   * 幂等注册一张 vec 表的元信息。
   * - 同 vec_table 已注册过 → no-op (不报错, 不覆盖, 让 consumer 重启时安心调)
   * - 跨 source/model/dim 冲突的同名注册 → warn 日志后保留旧值 (consumer 应自己改名)
   */
  registerVecTable(spec: VecTableSpec): void {
    if (!this.loaded) this.preload();
    const existing = this.cache.get(spec.vecTable);
    if (existing) {
      if (
        existing.source !== spec.source ||
        existing.modelId !== spec.modelId ||
        existing.dim !== spec.dim
      ) {
        this.log.warn(
          JSON.stringify({
            event: 'embeddingHost.vecTableRegistry.conflict',
            vecTable: spec.vecTable,
            existing,
            incoming: spec,
          }),
        );
      }
      return;
    }
    void this.getDbClient().exec(
        `INSERT OR IGNORE INTO vec_table_meta
           (vec_table, source, model_id, dim, registered_at, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [spec.vecTable, spec.source, spec.modelId, spec.dim, Date.now(), spec.notes ?? null],
    ).catch((err) => {
      this.log.warn(
        JSON.stringify({
          event: 'embeddingHost.vecTableRegistry.register.failed',
          vecTable: spec.vecTable,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
    this.cache.set(spec.vecTable, { ...spec });
    this.log.info(
      JSON.stringify({
        event: 'embeddingHost.vecTableRegistry.registered',
        vecTable: spec.vecTable,
        source: spec.source,
        modelId: spec.modelId,
        dim: spec.dim,
      }),
    );
  }

  getVecTableMeta(vecTable: string): VecTableSpec | undefined {
    if (!this.loaded) this.preload();
    return this.cache.get(vecTable);
  }

  list(): VecTableSpec[] {
    if (!this.loaded) this.preload();
    return Array.from(this.cache.values()).map((s) => ({ ...s }));
  }
}

function rowToSpec(row: VecTableRow): VecTableSpec {
  return {
    vecTable: row.vec_table,
    source: row.source,
    modelId: row.model_id,
    dim: row.dim,
    notes: row.notes ?? undefined,
  };
}
