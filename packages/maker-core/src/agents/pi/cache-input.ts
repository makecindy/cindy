/** Observe Pi's accepted, expanded queue, never infer delivery from input text.
 * This self-contained function also runs in the generated subagent supervisor. */
export function createPiCacheInputTracker(digest: (text: string) => string) {
  let steering: string[] = [];
  let followUp: string[] = [];
  let removed: { kind: 'steer' | 'followUp'; text: string } | undefined;
  const ambiguous = new Set<string>();
  let overflow = false;
  let last: { key: string; followUp: boolean } | undefined;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  function deletion(before: string[], after: string[]) {
    if (before.length !== after.length + 1) return undefined;
    let i = 0;
    while (i < after.length && before[i] === after[i]) i++;
    return before.slice(i + 1).every((v, j) => v === after[i + j]) ? before[i] : undefined;
  }
  return {
    observe(event: { type: string; [key: string]: unknown }) {
      if (event.type === 'queue_update') {
        removed = undefined;
        if (!Array.isArray(event.steering) || !Array.isArray(event.followUp)
          || event.steering.length + event.followUp.length > 1024
          || [...event.steering, ...event.followUp].some(v => typeof v !== 'string')) {
          overflow = true; steering = []; followUp = []; return;
        }
        const nextSteering = event.steering as string[];
        const nextFollowUp = event.followUp as string[];
        // Pi's public queue bookkeeping matches text, steering first. Identical
        // text in both queues is ambiguous even if it is later cleared.
        for (const text of [...steering, ...nextSteering]) {
          if (followUp.includes(text) || nextFollowUp.includes(text)) {
            if (ambiguous.size >= 1024) overflow = true;
            else ambiguous.add(digest(text));
          }
        }
        const steerText = same(followUp, nextFollowUp) ? deletion(steering, nextSteering) : undefined;
        const followText = same(steering, nextSteering) ? deletion(followUp, nextFollowUp) : undefined;
        if (steerText !== undefined) removed = { kind: 'steer', text: steerText };
        else if (followText !== undefined) removed = { kind: 'followUp', text: followText };
        steering = [...nextSteering]; followUp = [...nextFollowUp];
      } else if (event.type === 'message_start') {
        const message = event.message as { role?: string; content?: unknown } | undefined;
        if (message?.role !== 'user') return;
        const text = typeof message.content === 'string' ? message.content
          : Array.isArray(message.content) ? message.content.filter(v => v?.type === 'text').map(v => v.text).join('') : '';
        last = { key: digest(JSON.stringify(message)), followUp: !overflow && removed?.kind === 'followUp'
          && removed.text === text && !ambiguous.has(digest(text)) };
        removed = undefined;
        return last;
      } else if (['agent_start', 'agent_settled', 'session_switch', 'session_shutdown'].includes(event.type)) {
        removed = undefined;
        if (event.type !== 'agent_start') {
          steering = []; followUp = [];
          ambiguous.clear(); overflow = false; last = undefined;
        }
      }
    },
    read(key: unknown) { return typeof key === 'string' && last?.key === key ? last : undefined; },
  };
}
