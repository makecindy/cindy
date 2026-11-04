/**
 * DBLP row normalization and record parsing. The browser transport validates
 * XML and expands character entities before these conservative record helpers
 * project metadata into the existing CLI schema.
 */
import { ArgumentError } from '@jackwener/opencli/errors';

export const DBLP_ORIGIN = 'https://dblp.org';

/**
 * dblp record keys look like `<type>/<venue>/<short>` (e.g.
 * `conf/nips/VaswaniSPUJGKP17`, `journals/corr/abs-2509-05821`,
 * `phd/Smith20`). Allow lowercase letter prefixes plus 1+ slash-segments
 * containing letters / digits / `_` / `.` / `-`.
 */
const KEY_PATTERN = /^[a-z]+(?:\/[A-Za-z0-9_.-]+)+$/;

export function coerceInt(value) {
    if (value === undefined || value === null || value === '') return NaN;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && Number.isInteger(n) ? n : NaN;
}

export function requireBoundedInt(value, defaultValue, maxValue, label = 'limit') {
    const raw = value ?? defaultValue;
    const n = coerceInt(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new ArgumentError(`dblp ${label} must be a positive integer`);
    }
    if (n > maxValue) {
        throw new ArgumentError(`dblp ${label} must be <= ${maxValue}`);
    }
    return n;
}

export function requireQuery(value, label = 'query') {
    const q = String(value ?? '').trim();
    if (!q) {
        throw new ArgumentError(`dblp ${label} cannot be empty`);
    }
    return q;
}

export function requireRecordKey(value) {
    const key = String(value ?? '').trim();
    if (!key) {
        throw new ArgumentError('dblp paper key is required');
    }
    if (!KEY_PATTERN.test(key)) {
        throw new ArgumentError(`dblp paper key "${value}" is not a valid record key`, 'Expected something like "conf/nips/VaswaniSPUJGKP17" — copy the `key` column from `dblp search`.');
    }
    return key;
}

/** Decode the small set of XML entities dblp emits in record bodies. */
export function decodeXmlEntities(text) {
    if (!text) return '';
    return String(text)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

/** Strip dblp's per-author homonym suffixes (`Smith 0001`) → `Smith`. */
function trimAuthorHomonym(name) {
    return String(name || '').replace(/\s+\d{4,}$/, '').trim();
}

/**
 * Normalize the `info.authors.author` field from a dblp search hit. dblp
 * collapses single authors into one object instead of a 1-element array.
 */
export function normalizeAuthors(authorsField) {
    if (!authorsField) return [];
    const raw = authorsField?.author;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((a) => {
        if (a && typeof a === 'object') return trimAuthorHomonym(a.text || a['#text'] || '');
        return trimAuthorHomonym(String(a));
    }).filter(Boolean);
}

/**
 * Project a dblp publication search hit into one row. Drops only the most
 * volatile fields (e.g. abstract, which dblp does not expose) and keeps
 * the canonical key as the round-trip handle.
 */
export function searchHitToRow(hit, rank) {
    const info = hit?.info ?? {};
    const authors = normalizeAuthors(info.authors);
    const key = String(info.key ?? '').trim();
    return {
        rank,
        key,
        title: stripTrailingDot(decodeXmlEntities(info.title ?? '')).trim(),
        authors: authors.join(', '),
        venue: decodeXmlEntities(info.venue ?? ''),
        year: String(info.year ?? '').trim(),
        type: simplifyHitType(info.type),
        doi: String(info.doi ?? '').trim(),
        url: String(info.ee ?? info.url ?? '').trim(),
    };
}

/** Title strings from dblp end with a period — strip it for cleaner display. */
function stripTrailingDot(s) {
    return String(s || '').replace(/\.\s*$/, '');
}

/** Compress dblp's verbose `type` strings into single-token tags. */
function simplifyHitType(type) {
    if (!type) return '';
    const t = String(type);
    if (/Conference and Workshop/i.test(t)) return 'conf';
    if (/Journal Articles/i.test(t)) return 'journal';
    if (/Books and Theses/i.test(t)) return 'book';
    if (/Editorship/i.test(t)) return 'editorship';
    if (/Reference Works/i.test(t)) return 'reference';
    if (/Informal/i.test(t)) return 'preprint';
    return t.toLowerCase().split(/\s+/)[0];
}

/**
 * Extract a single tag from a dblp record XML blob (regex-based, same
 * approach as arxiv/utils.js — keeps the dependency surface flat).
 */
export function extractFirst(xml, tag) {
    const m = String(xml || '').match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1] : '';
}

export function extractAll(xml, tag) {
    const out = [];
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
    let m;
    while ((m = re.exec(String(xml || ''))) !== null) out.push(m[1]);
    return out;
}

/**
 * Pick the first `<ee type="oa">` (open-access link) if present, otherwise
 * fall back to the first `<ee>`.
 */
export function extractOpenAccessLink(xml) {
    const oa = String(xml || '').match(/<ee\b[^>]*type=["']oa["'][^>]*>([\s\S]*?)<\/ee>/);
    if (oa) return oa[1].trim();
    const any = String(xml || '').match(/<ee\b[^>]*>([\s\S]*?)<\/ee>/);
    return any ? any[1].trim() : '';
}

/** Pull the `key` attribute off the wrapper element regardless of record type. */
export function extractRecordKey(xml) {
    const m = String(xml || '').match(/<(?:article|inproceedings|incollection|proceedings|book|phdthesis|mastersthesis)\b[^>]*\bkey="([^"]+)"/);
    return m ? m[1] : '';
}

/**
 * Identify the record type from the wrapper element name. Maps to the
 * same simplified tag set the search rows use.
 */
export function extractRecordType(xml) {
    const m = String(xml || '').match(/<(article|inproceedings|incollection|proceedings|book|phdthesis|mastersthesis)\b/);
    if (!m) return '';
    switch (m[1]) {
        case 'inproceedings': return 'conf';
        case 'article': return 'journal';
        case 'incollection': return 'incollection';
        case 'proceedings': return 'editorship';
        case 'book': return 'book';
        case 'phdthesis': return 'phdthesis';
        case 'mastersthesis': return 'mastersthesis';
        default: return m[1];
    }
}

/**
 * Parse a single dblp record XML into the row shape used by `dblp paper`.
 * Treats every field as optional; throws upstream when the record body
 * is missing entirely (404 already handled at fetch level).
 */
export function recordXmlToRow(xml) {
    const key = extractRecordKey(xml);
    const type = extractRecordType(xml);
    const title = stripTrailingDot(decodeXmlEntities(extractFirst(xml, 'title')));
    const authors = extractAll(xml, 'author').map((a) => trimAuthorHomonym(decodeXmlEntities(a)));
    const year = decodeXmlEntities(extractFirst(xml, 'year'));
    const pages = decodeXmlEntities(extractFirst(xml, 'pages'));
    const venueRaw = type === 'conf'
        ? decodeXmlEntities(extractFirst(xml, 'booktitle'))
        : decodeXmlEntities(extractFirst(xml, 'journal'));
    const doi = (() => {
        const m = String(xml || '').match(/<ee\b[^>]*>([^<]*?(?:doi\.org\/|10\.[^"<]+))<\/ee>/i);
        if (!m) return '';
        const v = m[1].replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
        return v.startsWith('10.') ? v : '';
    })();
    return {
        key,
        type,
        title,
        authors: authors.join(', '),
        venue: venueRaw,
        year,
        pages,
        doi,
        open_access_url: extractOpenAccessLink(xml),
        dblp_url: key ? `${DBLP_ORIGIN}/rec/${key}.html` : '',
    };
}

export const SEARCH_COLUMNS = [
    'rank', 'key', 'title', 'authors', 'venue', 'year', 'type', 'doi', 'url',
];

export const PAPER_COLUMNS = [
    'key', 'type', 'title', 'authors', 'venue', 'year', 'pages', 'doi', 'open_access_url', 'dblp_url',
];
