import { describe, expect, it } from 'vitest';
import { extractCommandOutputPathCandidates } from '../commandOutputPaths';

/**
 * #5503: a real Bot history held exec commands of ~1M characters with thousands of
 * path candidates. Inference ran per candidate over the whole prefix / segment, so
 * one outline page blocked the main process for ~31s. These samples reproduce the
 * cost shape (long text + many path tokens, with and without separators) instead
 * of a long run of repeated characters, which never exercised the per-candidate scans.
 */
type LongCommandKind = 'oneline' | 'multiline' | 'powershell' | 'powershell-nested-reads' | 'powershell-per-line-writes';

function longCommand(kind: LongCommandKind, count: number): string {
  const paths = Array.from({ length: count }, (_, index) =>
    `'/Users/demo/project/data/dir${index % 97}/segment-${index}/file-${index}.json'`);
  const pad = 'x'.repeat(120);
  if (kind === 'oneline') {
    return `node scripts/collect.js --pad ${pad} --inputs ${paths.map((p) => `${p} --pad ${pad}`).join(' ')} && echo ok > /work/final-report.txt`;
  }
  if (kind === 'multiline') {
    return `cat <<'EOF' | node scripts/collect.js\n${paths.map((p) => `${p} ${pad}`).join('\n')}\nEOF\necho ok > /work/final-report.txt`;
  }
  if (kind === 'powershell-nested-reads') {
    // The writer comes first; every nested read carries its own `-Path` switch, so each
    // candidate ends in a path switch and must be rejected as nested (not top level).
    return `Set-Content -Value @(${paths.map((p) => `(Get-Content -Path ${p} ${pad})`).join(', ')}) -Path C:\\work\\final-report.txt`;
  }
  if (kind === 'powershell-per-line-writes') {
    return paths.map((p, index) => `Out-File -FilePath 'C:\\work\\out-${index}.txt' ${pad} ${p}`).join('\n');
  }
  return `Get-ChildItem ${pad} ${paths.map((p) => `${p} ${pad}`).join(' ')} | Out-File -FilePath C:\\work\\final-report.txt`;
}

function expectedOutputs(kind: LongCommandKind, count: number): string[] {
  if (kind === 'powershell-per-line-writes') {
    return Array.from({ length: count }, (_, index) => `C:\\work\\out-${index}.txt`);
  }
  return [kind.startsWith('powershell') ? 'C:\\work\\final-report.txt' : '/work/final-report.txt'];
}

describe('command output path scan cost (#5503)', () => {
  it.each([
    'oneline', 'multiline', 'powershell', 'powershell-nested-reads', 'powershell-per-line-writes',
  ] as const)('stays linear on long %s commands with thousands of candidates', (kind) => {
    const command = longCommand(kind, 7000);
    expect(command.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    const paths = extractCommandOutputPathCandidates(command);
    const elapsed = performance.now() - started;
    expect(paths).toEqual(expectedOutputs(kind, 7000));
    // The pre-fix implementation took 13–18s here; the bound is generous for slow CI.
    expect(elapsed).toBeLessThan(2000);
  });

  it('keeps paths inside outer quotes quoted when an inner quote closes first', () => {
    // Nested quoting: the path sits in a script comment inside the outer double quotes.
    expect(extractCommandOutputPathCandidates(`python -c "print('ok') # > /work/fake.txt"`)).toEqual([]);
    expect(extractCommandOutputPathCandidates(`python -c "print('ok') # > C:\\work\\fake.txt"`)).toEqual([]);
    expect(extractCommandOutputPathCandidates(`node -e "const s = 'a'; fs.writeFileSync('/work/nested.txt', s)"`)).toEqual(['/work/nested.txt']);
    // Once the outer quote closes, a real redirect still counts.
    expect(extractCommandOutputPathCandidates(`python -c "print('ok')" > /work/real.txt`)).toEqual(['/work/real.txt']);
  });

  it('keeps explicit-output decisions that end in long whitespace runs', () => {
    const gap = ' '.repeat(300);
    expect(extractCommandOutputPathCandidates(`Out-File${gap}C:\\out\\a.txt`)).toEqual(['C:\\out\\a.txt']);
    expect(extractCommandOutputPathCandidates(`Out-File -FilePath${gap}'C:\\out\\b.txt'`)).toEqual(['C:\\out\\b.txt']);
    expect(extractCommandOutputPathCandidates(`Copy-Item C:\\in\\c.txt -Destination${gap}C:\\out\\c2.txt`)).toEqual(['C:\\out\\c2.txt']);
    expect(extractCommandOutputPathCandidates(`cp -t${gap}/out/ /in/d.txt`)).toEqual(['/out/d.txt']);
    expect(extractCommandOutputPathCandidates(`cp --target-directory=/out/ /in/e.txt`)).toEqual(['/out/e.txt']);
    // Non-whitespace between the writer and the path still disqualifies the position.
    expect(extractCommandOutputPathCandidates(`Out-File -Encoding utf8${gap}C:\\out\\f.txt`)).toEqual([]);
  });

  it('does not let a nested read switch claim the writer position', () => {
    expect(extractCommandOutputPathCandidates(
      "Set-Content -Value (Get-Content -Path C:\\in\\x.txt) -Path C:\\out\\y.txt",
    )).toEqual(['C:\\out\\y.txt']);
    expect(extractCommandOutputPathCandidates(
      "Set-Content -Value (Get-Content -Path C:\\in\\x.txt) C:\\out\\z.txt",
    )).toEqual([]);
  });
});
