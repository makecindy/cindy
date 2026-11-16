/**
 * Split test files across CI shards by measured cost instead of path hash.
 *
 * Every shard job computes the full assignment from the same file list and the
 * same committed timings, then keeps its own bin, so the union of all shards is
 * exactly the full tier. The result depends only on the (key, weight) pairs,
 * never on input order: longest file first, each into the currently lightest
 * bin, ties broken by key and then by the lowest bin index. Items are returned
 * as given, so callers keep their own objects (for example Vitest specs).
 */

/** Median of the measured weights; new files without a measurement use it. */
export function medianWeight(weights) {
	const values = [...weights].filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
	if (values.length === 0) return 1;
	const middle = Math.floor(values.length / 2);
	return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

const byWeightThenKey = (left, right) =>
	right.weight - left.weight || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);

/**
 * @template {{ key: string, weight: number }} T
 * @param {readonly T[]} items
 * @param {number} count number of shards (>= 1)
 * @returns {T[][]} items per shard, index 0 is shard 1
 */
export function assignByDuration(items, count) {
	if (!Number.isSafeInteger(count) || count < 1) throw new Error(`shard count must be a positive integer, got ${count}`);
	const bins = Array.from({ length: count }, () => ({ load: 0, items: [] }));
	for (const item of [...items].sort(byWeightThenKey)) {
		let target = bins[0];
		for (const bin of bins) if (bin.load < target.load) target = bin;
		target.load += item.weight;
		target.items.push(item);
	}
	return bins.map((bin) => bin.items);
}
