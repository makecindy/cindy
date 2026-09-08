// No credentials, model calls or private examples belong in this module.
export const key = (value) => String(value).trim().replace(/\s+/g, ' ').toLowerCase();

export function validateCorpus(corpus) {
  if (corpus.version !== 1 || !corpus.id || !Array.isArray(corpus.cases) || !corpus.cases.length) {
    throw new Error('Expected a nonempty version 1 corpus');
  }
  const ids = new Set();
  for (const sample of corpus.cases) {
    if (!/^[a-z0-9_-]+$/i.test(sample.id) || ids.has(sample.id))
      throw new Error('Invalid or duplicate case id');
    ids.add(sample.id);
    if (
      !sample.category ||
      !sample.split ||
      !sample.rationale ||
      typeof sample.input?.beforeText !== 'string' ||
      typeof sample.input?.afterText !== 'string' ||
      !Array.isArray(sample.terms) ||
      !Array.isArray(sample.aliases)
    )
      throw new Error(`Invalid case ${sample.id}`);
    const seen = new Set();
    for (const group of sample.terms) {
      if (
        !Array.isArray(group.accept) ||
        !group.accept.length ||
        typeof group.required !== 'boolean'
      ) {
        throw new Error(`Invalid term label ${sample.id}`);
      }
      for (const term of group.accept) {
        if (
          typeof term !== 'string' ||
          !key(term) ||
          seen.has(key(term)) ||
          !key(sample.input.afterText).includes(key(term))
        )
          throw new Error(`Invalid/overlapping term ${sample.id}`);
        seen.add(key(term));
      }
    }
    const pairs = new Set();
    for (const pair of sample.aliases) {
      const id = `${key(pair.term)}\0${key(pair.alias)}`;
      if (
        !seen.has(key(pair.term)) ||
        typeof pair.alias !== 'string' ||
        !key(pair.alias) ||
        !key([sample.input.beforeText, sample.input.rawTranscriptText ?? ''].join('\n')).includes(
          key(pair.alias),
        ) ||
        typeof pair.required !== 'boolean' ||
        pairs.has(id)
      )
        throw new Error(`Invalid alias label ${sample.id}`);
      pairs.add(id);
    }
  }
  return corpus;
}

export function validResponse(response) {
  return (
    response !== null &&
    typeof response === 'object' &&
    Array.isArray(response.actions) &&
    response.actions.length <= 3 &&
    response.actions.every(
      (action) =>
        action &&
        ['add_entry', 'add_candidate', 'update_entry'].includes(action.action) &&
        typeof action.term === 'string' &&
        action.term.trim() &&
        Array.isArray(action.aliases) &&
        action.aliases.every((alias) => typeof alias === 'string') &&
        ['high', 'medium'].includes(action.confidence) &&
        [
          'product_name',
          'project_name',
          'technical_term',
          'person_name',
          'team_name',
          'code_name',
          'phrase',
          'other',
        ].includes(action.type),
    )
  );
}

// A correct term with a wrong alias contributes a term TP and an alias FP.
// Accepted alternatives are a single semantic target, not multiple recall targets.
export function scoreActions(sample, actions = []) {
  const terms = new Map();
  const pairs = new Set();
  for (const action of Array.isArray(actions) ? actions : []) {
    if (typeof action?.term !== 'string') continue;
    const term = key(action.term);
    if (!['add_entry', 'update_entry'].includes(terms.get(term))) terms.set(term, action.action);
    for (const alias of Array.isArray(action.aliases) ? action.aliases : []) {
      if (typeof alias === 'string') pairs.add(`${term}\0${key(alias)}`);
    }
  }
  const matched = (group) => group.accept.some((term) => terms.has(key(term)));
  const allowedTerms = new Set(sample.terms.flatMap((group) => group.accept.map(key)));
  const allowedPairs = new Set(
    sample.aliases.map((pair) => `${key(pair.term)}\0${key(pair.alias)}`),
  );
  return {
    termHit: sample.terms.filter((group) => group.required && matched(group)).length,
    termMiss: sample.terms.filter((group) => group.required && !matched(group)).length,
    termAllowed: sample.terms.filter(matched).length,
    termWrong: [...terms.keys()].filter((term) => !allowedTerms.has(term)).length,
    entryHit: sample.terms.filter(
      (group) =>
        group.required &&
        group.accept.some((term) => ['add_entry', 'update_entry'].includes(terms.get(key(term)))),
    ).length,
    aliasHit: sample.aliases.filter(
      (pair) => pair.required && pairs.has(`${key(pair.term)}\0${key(pair.alias)}`),
    ).length,
    aliasMiss: sample.aliases.filter(
      (pair) => pair.required && !pairs.has(`${key(pair.term)}\0${key(pair.alias)}`),
    ).length,
    aliasAllowed: [...pairs].filter((pair) => allowedPairs.has(pair)).length,
    aliasWrong: [...pairs].filter((pair) => !allowedPairs.has(pair)).length,
  };
}

export function aggregate(rows) {
  const sum = (stage) =>
    rows.reduce((total, row) => {
      for (const [name, count] of Object.entries(row[stage]))
        total[name] = (total[name] ?? 0) + count;
      return total;
    }, {});
  const accepted = sum('acceptedScore');
  return {
    runs: rows.length,
    cases: new Set(rows.map((row) => row.caseId)).size,
    errors: rows.filter((row) => row.error).length,
    schemaFailures: rows.filter((row) => row.validSchema === false).length,
    skipped: rows.filter((row) => row.skipReason).length,
    raw: sum('rawScore'),
    accepted,
    termRecall: accepted.termHit / (accepted.termHit + accepted.termMiss) || 0,
    termPrecision: accepted.termAllowed / (accepted.termAllowed + accepted.termWrong) || 0,
    aliasPrecision:
      accepted.aliasAllowed + accepted.aliasWrong === 0
        ? null
        : accepted.aliasAllowed / (accepted.aliasAllowed + accepted.aliasWrong),
    allRepeatsCleanCases: [...new Set(rows.map((row) => row.caseId))].filter((id) =>
      rows
        .filter((row) => row.caseId === id)
        .every(
          (row) =>
            !row.error &&
            row.validSchema !== false &&
            !row.acceptedScore.termMiss &&
            !row.acceptedScore.termWrong &&
            !row.acceptedScore.aliasWrong &&
            !row.acceptedScore.aliasMiss,
        ),
    ).length,
  };
}
