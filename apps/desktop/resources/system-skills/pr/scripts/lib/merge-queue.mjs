// Queue failures belong to the merge-group commit, not the PR head checks.
// This classifier detects work; it never authorizes approval or re-enqueuing.
export function classifyMergeQueue({ entry = null, event = null, containsHead = null, checks = {}, terminal = false }) {
  const none = { status: 'NONE', blockers: [] };
  if (terminal || (!entry && !event)) return none;
  const removed = event?.__typename === 'RemovedFromMergeQueueEvent';
  if (!entry && removed && containsHead === false) {
    return { status: 'SUPERSEDED', blockers: [] };
  }
  const out = {
    status: entry ? 'ENQUEUED' : 'REMOVED',
    entryId: entry?.id ?? null,
    state: entry?.state ?? null,
    eventId: entry ? null : event?.id ?? null,
    reason: entry ? null : event?.reason ?? null,
    groupCommitOid: (entry ? entry.headCommit : event?.beforeCommit)?.oid ?? null,
    checksSummary: checks,
    blockers: [],
  };
  if ((!entry && (!removed || containsHead !== true)) || checks.unavailable || checks.truncated) {
    out.status = 'UNAVAILABLE';
    out.blockers.push('merge_queue_unavailable');
    return out;
  }
  if (!entry) {
    // Jobs often cancel AFTER removal. The event, not those abandoned jobs,
    // tells us whether checks caused the dequeue; keep job evidence for triage.
    out.blockers.push('merge_queue_removed');
    if (event?.reason === 'failed_checks') out.blockers.push('merge_queue_ci_failing');
    return out;
  }
  if (checks.failed > 0) {
    out.blockers.push('merge_queue_ci_failing');
  } else if (checks.actionRequired > 0) {
    out.blockers.push('check_action_required');
  } else if (entry?.state === 'UNMERGEABLE') {
    out.blockers.push('merge_queue_unmergeable');
  } else {
    out.blockers.push('merge_queue_pending');
  }
  return out;
}

export function mergeQueueFingerprint(queue) {
  if (!queue || ['NONE', 'SUPERSEDED'].includes(queue.status)) return null;
  const checks = queue.checksSummary ?? {};
  const runs = (key) => (checks[key] ?? [])
    .map(r => `${r.name ?? ''}:${r.status ?? ''}:${r.conclusion ?? ''}`).sort();
  return {
    status: queue.status,
    entryId: queue.entryId ?? null,
    state: queue.state ?? null,
    eventId: queue.eventId ?? null,
    reason: queue.reason ?? null,
    groupCommitOid: queue.groupCommitOid ?? null,
    checks: {
      pending: checks.pending ?? 0,
      failed: checks.failed ?? 0,
      actionRequired: checks.actionRequired ?? 0,
      unavailable: Boolean(checks.unavailable),
      truncated: Boolean(checks.truncated),
      pendingRuns: runs('pendingRuns'),
      failingRuns: runs('failingRuns'),
      actionRequiredRuns: runs('actionRequiredRuns'),
    },
  };
}
