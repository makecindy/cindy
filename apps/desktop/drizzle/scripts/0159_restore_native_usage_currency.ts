import type Database from 'better-sqlite3';

type Money = {
  amount: number;
  currency: string;
  kind: string;
  approximate: boolean;
  estimateReasons?: string[];
};

type Metadata = {
  turnCost?: Money;
  userTurnCost?: Money;
  turnUsageDetails?: {
    providerId?: string;
    billingSource?: string;
    perModelCost?: { model: string; money: Money; billingSource?: string; providerId?: string }[];
  };
};

function isYuanEstimate(m?: Money): m is Money {
  return (
    m?.currency === 'CNY' &&
    m.kind === 'value-estimate' &&
    m.approximate === true &&
    Number.isFinite(m.amount) &&
    m.amount > 0
  );
}

function dollars(m: Money): void {
  m.amount /= 6.7;
  m.currency = 'USD';
  if (Array.isArray(m.estimateReasons) && m.estimateReasons.includes('fixed-fx')) {
    m.estimateReasons = m.estimateReasons.filter((reason) => reason !== 'fixed-fx');
  }
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, 1e-10 * Math.max(a, b));
}

type Confirmation = {
  id: string;
  createdAt: number;
  amount: number;
  provider: string;
  models: string[];
};

function confirmations(db: Database.Database): Map<string, Confirmation> {
  const result = new Map<string, Confirmation>();
  if (!db.name || db.name === ':memory:') return result;
  const fs = require('node:fs') as typeof import('node:fs');
  const file = db.name + '.native-usd-estimates.json';
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return result;
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (input?.version !== 1 || !Array.isArray(input.records)) return result;
    for (const item of input.records) {
      if (
        typeof item?.id === 'string' &&
        Number.isSafeInteger(item.createdAt) &&
        Number.isFinite(item.amount) &&
        typeof item.provider === 'string' &&
        Array.isArray(item.models) &&
        item.models.every((m: unknown) => typeof m === 'string')
      ) {
        result.set(item.id, item);
      }
    }
  } catch {
    return new Map();
  }
  return result;
}

function run(db: Database.Database): void {
  const confirmed = confirmations(db);
  const columns = (table: string) =>
    db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table);
  const fields = columns('messages');
  if (
    !['id', 'agent_meta', 'agent_kind', 'created_at', 'role', 'rewind_at', 'session_id'].every(
      (key) => fields.includes(key),
    )
  )
    return;
  const modelBuckets = new Map<string, number>();
  const patch = db.prepare('UPDATE messages SET agent_meta = ? WHERE id = ?');
  const restored = new Map<string, number>();
  const rounds: { id: string; session: string; created: number; seq: number }[] = [];
  const allYuanByDay = new Map<string, number>();
  const earlyDays = new Map<string, { amount: number; updated: number }>();
  const earliestCatalog = Date.parse('2026-08-01T10:11:54Z');
  let cursor = 0;
  for (;;) {
    const rows = db
      .prepare(
        `SELECT id, session_id, rowid AS seq, agent_meta, agent_kind, created_at, rewind_at,
      date(created_at / 1000, 'unixepoch', 'localtime') AS day FROM messages
      WHERE rowid > ? AND role = 'assistant' AND agent_meta LIKE '%"CNY"%'
      ORDER BY rowid LIMIT 128`,
      )
      .all(cursor) as {
      id: string;
      session_id: string;
      seq: number;
      agent_meta: string;
      agent_kind: string;
      created_at: number;
      rewind_at: number | null;
      day: string;
    }[];
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.seq;
      let meta: Metadata;
      try {
        meta = JSON.parse(row.agent_meta);
      } catch {
        continue;
      }
      const cost = meta?.turnCost;
      if (
        cost?.currency === 'CNY' &&
        Number.isFinite(cost.amount) &&
        cost.amount > 0 &&
        row.rewind_at === null
      ) {
        allYuanByDay.set(row.day, (allYuanByDay.get(row.day) ?? 0) + cost.amount);
      }
      if (!isYuanEstimate(cost) || !Array.isArray(cost.estimateReasons)) continue;
      const details = meta.turnUsageDetails;
      const parts = details?.perModelCost;
      if (parts !== undefined && !Array.isArray(parts)) continue;
      const signature =
        cost.estimateReasons.length === 2 &&
        cost.estimateReasons.includes('subscription-value') &&
        cost.estimateReasons.includes('reference-price');
      const earlyUsdCatalog =
        row.created_at > 0 &&
        row.created_at < earliestCatalog &&
        signature &&
        !parts?.length &&
        !details?.providerId &&
        (row.agent_kind === 'cc' || row.agent_kind === 'codex');
      const consent = confirmed.get(row.id);
      const models = parts?.map((part) => part?.model) ?? [];
      const matches =
        consent &&
        consent.createdAt === row.created_at &&
        consent.amount === cost.amount &&
        consent.provider === (details?.providerId ?? '') &&
        cost.estimateReasons.includes('reference-price') &&
        (parts ?? []).every((part) => !part?.providerId || part.providerId === consent.provider) &&
        JSON.stringify(consent.models) === JSON.stringify(models) &&
        (details?.billingSource === 'subscription' ||
          (signature && !parts?.length && !details?.providerId));
      const qualified = matches || earlyUsdCatalog || cost.estimateReasons.includes('fixed-fx');
      if (!qualified || (details?.billingSource && details.billingSource !== 'subscription'))
        continue;
      if (
        parts?.length &&
        (!parts.every(
          (part) =>
            typeof part?.model === 'string' &&
            isYuanEstimate(part.money) &&
            (!part.billingSource || part.billingSource === 'subscription') &&
            (earlyUsdCatalog ||
              matches ||
              (Array.isArray(part.money.estimateReasons) &&
                part.money.estimateReasons.includes('fixed-fx'))),
        ) ||
          !near(
            parts.reduce((sum, part) => sum + part.money.amount, 0),
            cost.amount,
          ))
      )
        continue;
      if (isYuanEstimate(meta.userTurnCost) && near(meta.userTurnCost.amount, cost.amount))
        dollars(meta.userTurnCost);
      else if (
        isYuanEstimate(meta.userTurnCost) &&
        meta.userTurnCost.amount > cost.amount &&
        row.rewind_at === null
      ) {
        rounds.push({ id: row.id, session: row.session_id, created: row.created_at, seq: row.seq });
      }
      restored.set(row.id, cost.amount);
      if (signature && row.rewind_at === null && !parts?.length) {
        const day = earlyDays.get(row.day) ?? { amount: 0, updated: 0 };
        day.amount += cost.amount;
        day.updated = Math.max(day.updated, row.created_at);
        earlyDays.set(row.day, day);
      }
      for (const part of parts ?? []) {
        if (row.rewind_at === null && row.day && details?.billingSource === 'subscription') {
          const key = JSON.stringify([
            row.day,
            row.agent_kind === 'cc' ? 'claude-code' : row.agent_kind,
            part.model + '#billing=subscription',
          ]);
          modelBuckets.set(key, (modelBuckets.get(key) ?? 0) + part.money.amount);
        }
        dollars(part.money);
      }
      dollars(cost);
      patch.run(JSON.stringify(meta), row.id);
    }
  }
  const history =
    db.prepare(`SELECT id,role,agent_meta FROM messages WHERE session_id=? AND rewind_at IS NULL
    AND (created_at,rowid) <= (?,?) ORDER BY created_at DESC,rowid DESC`);
  for (const round of rounds) {
    let total = 0;
    let target: Metadata | undefined;
    let corrected = false;
    for (const row of history.iterate(round.session, round.created, round.seq) as Iterable<{
      id: string;
      role: string;
      agent_meta: string | null;
    }>) {
      let meta;
      try {
        meta = JSON.parse(row.agent_meta ?? '{}') ?? {};
      } catch {
        break;
      }
      if (row.id === round.id) target = meta;
      if (row.role === 'user' && meta.autoResume !== true) {
        if (
          !meta.mediaCosts?.length &&
          isYuanEstimate(target?.userTurnCost) &&
          near(total, target.userTurnCost.amount)
        ) {
          dollars(target.userTurnCost);
          corrected = true;
        }
        break;
      }
      if (row.role !== 'assistant') continue;
      if (meta.turnUsageDetails?.additionalCosts?.length) break;
      const original = restored.get(row.id);
      if (original !== undefined) total += original;
      else if (meta.turnCost?.amount || meta.turnCostUsd) break;
    }
    if (corrected) patch.run(JSON.stringify(target), round.id);
  }
  if (
    earlyDays.size &&
    columns('migration_history').includes('applied_at') &&
    columns('daily_spend').includes('cost_currency')
  ) {
    const applied = db
      .prepare('SELECT applied_at FROM migration_history WHERE seq=85')
      .pluck()
      .get() as number | undefined;
    for (const [day, { amount, updated }] of earlyDays) {
      if (!applied || updated > applied || !near(allYuanByDay.get(day) ?? 0, amount)) continue;
      const row = db
        .prepare(
          "SELECT cost_amount FROM daily_spend WHERE day=? AND cost_currency='CNY' AND cost_usd=0 AND cost_is_approximate=1 AND updated_at=?",
        )
        .pluck()
        .get(day, updated) as number | undefined;
      if (row !== undefined && near(row, amount)) {
        db.prepare(
          "DELETE FROM daily_spend WHERE day=? AND cost_currency='CNY' AND cost_amount=? AND updated_at=?",
        ).run(day, row, updated);
      }
    }
  }
  if (!modelBuckets.size || !columns('daily_model_usage').includes('cost_currency')) return;
  for (const [key, sum] of modelBuckets) {
    const [day, agent, model] = JSON.parse(key);
    const source = db
      .prepare(
        `SELECT cost_amount, cost_usd FROM daily_model_usage
      WHERE day=? AND agent_kind=? AND model=? AND cost_currency='CNY' AND cost_is_approximate=1`,
      )
      .get(day, agent, model) as { cost_amount: number; cost_usd: number } | undefined;
    if (!source || source.cost_usd || !near(source.cost_amount, sum)) continue;
    db.prepare(
      `INSERT INTO daily_model_usage
      (day,agent_kind,model,cost_currency,cost_amount,cost_is_approximate,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens,updated_at)
      SELECT day,agent_kind,model,'USD',cost_amount/6.7,1,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens,updated_at
      FROM daily_model_usage WHERE day=? AND agent_kind=? AND model=? AND cost_currency='CNY'
      ON CONFLICT(day,agent_kind,model,cost_currency) DO UPDATE SET cost_amount=cost_amount+excluded.cost_amount,
        cost_is_approximate=1,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,
        cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,cache_create_tokens=cache_create_tokens+excluded.cache_create_tokens,
        updated_at=MAX(updated_at,excluded.updated_at)`,
    ).run(day, agent, model);
    db.prepare(
      "DELETE FROM daily_model_usage WHERE day=? AND agent_kind=? AND model=? AND cost_currency='CNY'",
    ).run(day, agent, model);
  }
}

module.exports = { run };
