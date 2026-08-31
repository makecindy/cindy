const PLATFORM_SKIP_PATTERN = /\.\s*skipIf\s*\(/g;
const TEST_CALL_PATTERN = /\b(?:it|test)\s*\(/g;
const SYMLINK_CALL_PATTERN = /\b(?:symlink|symlinkSync)\s*\(/;
const PLATFORM_EARLY_RETURN_PATTERN =
	/\bif\s*\(\s*process\s*\.\s*platform\s*={2,3}\s+\)\s*(?:\{\s*)?return\b/g;
const EXCEPTION_PATTERN = /^\s*\/\/\s*symlink-platform-skip:\s*(.{20,})\s*$/i;

function maskNonCode(source) {
	const chars = [...source];
	let index = 0;
	while (index < chars.length) {
		const current = chars[index];
		const next = chars[index + 1];
		if (current === "/" && next === "/") {
			chars[index] = " ";
			chars[index + 1] = " ";
			index += 2;
			while (index < chars.length && chars[index] !== "\n") {
				chars[index] = " ";
				index += 1;
			}
			continue;
		}
		if (current === "/" && next === "*") {
			chars[index] = " ";
			chars[index + 1] = " ";
			index += 2;
			while (index < chars.length) {
				if (chars[index] === "*" && chars[index + 1] === "/") {
					chars[index] = " ";
					chars[index + 1] = " ";
					index += 2;
					break;
				}
				if (chars[index] !== "\n") chars[index] = " ";
				index += 1;
			}
			continue;
		}
		if (current === '"' || current === "'" || current === "`") {
			const quote = current;
			chars[index] = " ";
			index += 1;
			while (index < chars.length) {
				if (chars[index] === "\\") {
					chars[index] = " ";
					if (chars[index + 1] !== "\n") chars[index + 1] = " ";
					index += 2;
					continue;
				}
				if (chars[index] === quote) {
					chars[index] = " ";
					index += 1;
					break;
				}
				if (chars[index] !== "\n") chars[index] = " ";
				index += 1;
			}
			continue;
		}
		index += 1;
	}
	return chars.join("");
}

function matchingParen(source, openIndex) {
	let depth = 0;
	for (let index = openIndex; index < source.length; index += 1) {
		if (source[index] === "(") depth += 1;
		else if (source[index] === ")") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function previousLine(source, index) {
	const lineStart = source.lastIndexOf("\n", index - 1) + 1;
	const previousEnd = lineStart > 0 ? lineStart - 1 : 0;
	const previousStart = source.lastIndexOf("\n", previousEnd - 1) + 1;
	return source.slice(previousStart, previousEnd).replace(/\r$/, "");
}

/**
 * Finds test/suite calls that skip on win32 while exercising a real symlink.
 * A genuinely POSIX-only contract may use an immediately preceding
 * `symlink-platform-skip:` comment with a concrete rationale.
 */
export function findSymlinkPlatformSkips(source) {
	const masked = maskNonCode(source);
	const violations = [];
	for (const match of masked.matchAll(PLATFORM_SKIP_PATTERN)) {
		const conditionOpen = masked.indexOf("(", match.index);
		const conditionClose = matchingParen(masked, conditionOpen);
		if (conditionClose < 0) continue;
		const condition = source.slice(conditionOpen + 1, conditionClose);
		if (!/process\s*\.\s*platform/.test(condition) || !/["']win32["']/.test(condition)) {
			continue;
		}

		let testOpen = conditionClose + 1;
		while (/\s/.test(masked[testOpen] ?? "")) testOpen += 1;
		if (masked[testOpen] !== "(") continue;
		const testClose = matchingParen(masked, testOpen);
		if (testClose < 0) continue;
		if (!SYMLINK_CALL_PATTERN.test(masked.slice(testOpen + 1, testClose))) continue;
		if (EXCEPTION_PATTERN.test(previousLine(source, match.index))) continue;

		violations.push({
			line: source.slice(0, match.index).split("\n").length,
		});
	}
	for (const match of masked.matchAll(TEST_CALL_PATTERN)) {
		const testOpen = masked.indexOf("(", match.index);
		const testClose = matchingParen(masked, testOpen);
		if (testClose < 0) continue;
		const testBody = masked.slice(testOpen + 1, testClose);
		if (!SYMLINK_CALL_PATTERN.test(testBody)) continue;
		const earlyReturn = PLATFORM_EARLY_RETURN_PATTERN.exec(testBody);
		PLATFORM_EARLY_RETURN_PATTERN.lastIndex = 0;
		if (!earlyReturn) continue;
		const earlyReturnStart = testOpen + 1 + earlyReturn.index;
		const earlyReturnSource = source.slice(
			earlyReturnStart,
			earlyReturnStart + earlyReturn[0].length,
		);
		if (!/["']win32["']/.test(earlyReturnSource)) continue;
		if (EXCEPTION_PATTERN.test(previousLine(source, match.index))) continue;

		violations.push({
			line: source.slice(0, earlyReturnStart).split("\n").length,
		});
	}
	return violations;
}
