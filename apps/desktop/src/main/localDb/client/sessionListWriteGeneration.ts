/**
 * sessions:list 写代次：任何会改列表投影的 DB 写，以及当前 DbClient 替换，
 * 都必须推进代次，让随后的 list 不要并入写前 / 旧客户端的 in-flight。
 *
 * 不在 IPC / 广播点逐个补 bump。入口只有 DbClient.exec / tx、drizzle 写路径、
 * setCurrentDbClient / clearCurrentDbClient。
 */

let writeGeneration = 0;

const LIST_TX_NAME = /session|message|import|fork|rewind/i;

export function bumpSessionListWriteGeneration(): void {
  writeGeneration += 1;
}

export function readSessionListWriteGeneration(): number {
  return writeGeneration;
}

export function noteSessionListDbWrite(input: { sql?: string; txName?: string }): void {
  if (input.txName && LIST_TX_NAME.test(input.txName)) {
    bumpSessionListWriteGeneration();
    return;
  }
  if (input.sql && sqlAffectsSessionListProjection(input.sql)) {
    bumpSessionListWriteGeneration();
  }
}

export function sqlAffectsSessionListProjection(sql: string): boolean {
  const head = sql.trimStart();
  if (!/^(insert|update|delete|replace)\b/i.test(head)) return false;
  return /\b(?:into|update|from)\s+["'`]?(sessions|messages)["'`]?(?:\s|\(|$)/i.test(head);
}

/** 测试用：与 flight 表一起清掉。 */
export function resetSessionListWriteGenerationForTests(): void {
  writeGeneration = 0;
}
