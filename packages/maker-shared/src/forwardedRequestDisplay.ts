// Persisted envelope dialects, not UI translations. Keep old spellings readable
// regardless of the viewing device's locale. This parser never grants authorship
// or permission; the host's receipt validator still consumes the original bytes.
const DIALECTS = [
  ['[Source] ', 'User’s original words:', 'Agent supplement:', '[Task source] ', 'Task ID:'],
  ['[来源] ', '用户原话：', 'Agent补充：', '[任务来源] ', '任务 ID：'],
  ['[来源] ', '用户原话：', 'agent补充：', '[任务来源] ', '任务 ID：'],
  ['[來源] ', '使用者原話：', 'Agent補充：', '[任務來源] ', '任務 ID：'],
  ['[出典] ', 'ユーザーの原文：', 'Agent の補足：', '[タスクの出典] ', 'タスク ID：'],
  ['[출처] ', '사용자 원문:', 'Agent 보충:', '[작업 출처] ', '작업 ID:'],
  ['[Fuente] ', 'Palabras originales del usuario:', 'Suplemento del Agent:', '[Origen de la tarea] ', 'ID de la tarea:'],
  ['[Source] ', "Mots d'origine de l'utilisateur :", "Complément de l'Agent :", '[Source de la tâche] ', 'ID de la tâche :'],
  ['[Quelle] ', 'Ursprünglicher Wortlaut des Nutzers:', 'Agent-Ergänzung:', '[Aufgabenquelle] ', 'Aufgaben-ID:'],
  ['[Origem] ', 'Palavras originais do utilizador:', 'Suplemento do Agent:', '[Origem da tarefa] ', 'ID da tarefa:'],
  ['[Origem] ', 'Palavras originais do usuário:', 'Complemento do Agent:', '[Origem da tarefa] ', 'ID da tarefa:'],
] as const;

/** Display only, for attributed machine messages. Decode one complete envelope,
 * never arbitrary backslashes, nested payloads, code fences or truncated previews.
 * The wire body, history, replay and source receipts must remain untouched. */
export function forwardedRequestDisplayText(body: string): string {
  if (!body.startsWith('[')) return body;
  const lines = body.split('\n');
  for (const [sourcePrefix, userPrefix, agentPrefix, taskPrefix, taskIdPrefix] of DIALECTS) {
    // Background tasks prepend two host lines separated by blank lines.
    const offset = lines.length === 7 && lines[0].startsWith(taskPrefix)
      && lines[1] === '' && lines[2].startsWith(`${taskIdPrefix} `) && lines[3] === '' ? 4 : 0;
    if (lines.length !== offset + 3 || !lines[offset].startsWith(sourcePrefix)
      || !lines[offset + 1].startsWith(userPrefix) || !lines[offset + 2].startsWith(agentPrefix)) continue;
    const quotedUser = lines[offset + 1].slice(userPrefix.length);
    const quotedAgent = lines[offset + 2].slice(agentPrefix.length);
    try {
      const user: unknown = JSON.parse(quotedUser);
      const agent: unknown = JSON.parse(quotedAgent);
      if (typeof user !== 'string' || typeof agent !== 'string'
        || JSON.stringify(user) !== quotedUser || JSON.stringify(agent) !== quotedAgent) continue;
      return [...lines.slice(0, offset), lines[offset], '', userPrefix, '', user, '', agentPrefix, '', agent].join('\n');
    } catch { /* Malformed or incomplete history stays verbatim. */ }
  }
  return body;
}
