// Desktop CI shards are cut by measured cost (apps/desktop/src/test/vitest/timingSequencer.ts).
// engineering-conventions.md §3 requires the union of all shards to equal the full unit tier;
// each shard job computes the split on its own, so the result must not depend on input order.
import assert from 'node:assert/strict';
import test from 'node:test';
import { assignByDuration, medianWeight } from '../shared/duration-shards.mjs';

const files = Array.from({ length: 41 }, (_, index) => ({
	key: `standard:src/file-${String(index).padStart(2, '0')}.test.ts`,
	// Repeated weights exercise the key tie-break.
	weight: [7, 3, 3, 120, 1, 45, 3][index % 7],
}));

test('every file lands in exactly one shard whatever the input order', () => {
	for (const count of [1, 3, 8]) {
		const shards = assignByDuration(files, count);
		assert.equal(shards.length, count);
		assert.deepEqual(shards.flat().map((file) => file.key).sort(), files.map((file) => file.key).sort());
		assert.deepEqual(assignByDuration([...files].reverse(), count), shards);
	}
});

test('balances measured cost rather than file count', () => {
	const skewed = [
		{ key: 'slow', weight: 100 },
		...Array.from({ length: 99 }, (_, index) => ({ key: `fast-${index}`, weight: 1 })),
	];
	const loads = assignByDuration(skewed, 2)
		.map((bin) => bin.reduce((sum, file) => sum + file.weight, 0))
		.sort((left, right) => left - right);
	// A count split would pair the slow file with 49 fast ones (149 vs 50).
	assert.deepEqual(loads, [99, 100]);
	// Files without a measurement take the median; no data at all still yields a weight.
	assert.equal(medianWeight([5, 1, 3]), 3);
	assert.equal(medianWeight([]), 1);
});
