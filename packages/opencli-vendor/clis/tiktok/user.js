// Read the profile bootstrap and the page's own signed network responses.
import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { log } from '@jackwener/opencli/logger';
import { BROWSER_HELPERS, VIDEO_ITEM_NORMALIZER, normalizeUsername, requireLimit, throwTikTokPageContextError } from './utils.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 120;

function buildUserScript(username, items = []) {
    return `(async () => {
      ${BROWSER_HELPERS}
      ${VIDEO_ITEM_NORMALIZER}
      const username = ${JSON.stringify(username.toLowerCase())};
      const supplied = ${JSON.stringify(items)};
      const universal = findUniversalData();
      const detail = universal?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo;
      const user = detail?.user;
      const profileMatches = String(user?.uniqueId || '').toLowerCase() === username;
      const secUid = profileMatches ? String(user.secUid || '') : '';
      const rows = [];
      const add = (item, source) => {
        const author = item?.author || item?.authorInfo || {};
        const name = String(author.uniqueId || author.unique_id || '').toLowerCase();
        const authorSecUid = String(author.secUid || author.sec_uid || '');
        if ((name && name !== username) || (secUid && authorSecUid && authorSecUid !== secUid)) return;
        if (name !== username && !(secUid && authorSecUid === secUid)) return;
        const row = normalizeVideoItem(item, rows.length + 1);
        if (row) rows.push({ ...row, source });
      };
      walkObjects(universal, node => {
        if (node && typeof node === 'object' && !Array.isArray(node)) add(node.itemStruct || node.item || node, 'bootstrap');
        return false;
      });
      for (const item of supplied) add(item, 'profile-network');
      const loginWall = location.pathname === '/login' || location.pathname.startsWith('/login/')
        || Boolean(document.querySelector('#captcha_container, [id*="captcha-verify"]'));
      return { rows, secUid, videoCount: profileMatches ? detail?.stats?.videoCount : null, loginWall };
    })()`;
}

export function parseProfileCapture(entry, secUid) {
    let url;
    try { url = new URL(entry?.url); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'www.tiktok.com' || url.pathname !== '/api/post/item_list/'
        || !secUid || url.searchParams.get('secUid') !== secUid) return null;
    if (entry.captureComplete === false || (entry.captureComplete !== true && entry.responsePreview === undefined)) return null;
    const status = Number(entry.responseStatus);
    if ([401, 403].includes(status)) throw new AuthRequiredError('tiktok.com', 'TikTok profile request requires login or challenge clearance');
    if (status < 200 || status >= 300 || !Number.isFinite(status)) throw new CommandExecutionError('TikTok profile request failed: HTTP ' + status);
    if (entry.responseBodyTruncated) throw new CommandExecutionError('TikTok profile response exceeded the network capture size limit');
    let text = entry.responsePreview;
    if (typeof text !== 'string' || !text.trim()) throw new CommandExecutionError('TikTok profile API returned an empty or unavailable response');
    if (text.startsWith('base64:')) text = Buffer.from(text.slice(7), 'base64').toString('utf8');
    let data;
    try { data = JSON.parse(text); } catch { throw new CommandExecutionError('TikTok profile API returned invalid JSON'); }
    const code = data?.statusCode ?? data?.status_code;
    if (code !== undefined && Number(code) !== 0) {
        if (Number(code) === 8 || /login|auth|captcha|permission/i.test(String(data.statusMsg || data.status_msg || ''))) {
            throw new AuthRequiredError('tiktok.com', 'TikTok profile API requires login or challenge clearance');
        }
        throw new CommandExecutionError('TikTok profile API failed with status ' + String(code));
    }
    if (!Array.isArray(data?.itemList)) throw new CommandExecutionError('TikTok profile response is missing itemList');
    if (data.hasMore !== true && data.hasMore !== false && data.hasMore !== 0 && data.hasMore !== 1) {
        throw new CommandExecutionError('TikTok profile response is missing a valid hasMore flag');
    }
    return { items: data.itemList, hasMore: Boolean(data.hasMore) };
}

async function listUserVideos(page, args) {
    const username = normalizeUsername(args.username);
    const limit = requireLimit(args.limit, { fallback: DEFAULT_LIMIT, max: MAX_LIMIT });
    const capture = typeof page.startNetworkCapture === 'function' && typeof page.readNetworkCapture === 'function'
        && await page.startNetworkCapture('/api/post/item_list/') !== false;
    const startedAt = Date.now();
    await page.goto(`https://www.tiktok.com/@${encodeURIComponent(username)}`, { waitUntil: 'load', settleMs: 6000 });
    const dedup = new Map();
    let complete = false;
    let knownEmpty = false;
    let pending = [];
    let supplied = [];
    async function readSnapshot(items) {
        let snapshot;
        try { snapshot = await page.evaluate(buildUserScript(username, items)); }
        catch (error) {
            throwTikTokPageContextError(error, { authMessage: 'TikTok requires browser access to load user videos', emptyPattern: /^$/, emptyTarget: 'tiktok user', failureMessage: 'Failed to read TikTok profile' });
        }
        if (!snapshot || !Array.isArray(snapshot.rows)) throw new CommandExecutionError('Malformed TikTok profile snapshot');
        if (snapshot.loginWall) throw new AuthRequiredError('tiktok.com', 'TikTok profile requires login or challenge clearance');
        return snapshot;
    }
    for (let attempt = 0; attempt < 10; attempt++) {
        const snapshot = await readSnapshot(supplied);
        for (const row of snapshot.rows) if (!dedup.has(row.id)) dedup.set(row.id, row);
        knownEmpty = snapshot.videoCount === 0;
        if (dedup.size >= limit || complete) break;
        if (!capture) {
            if (dedup.size || knownEmpty) break;
            throw new CommandExecutionError('TikTok user requires network capture; update the Browser Bridge extension');
        }
        pending.push(...(await page.readNetworkCapture({ retainIncomplete: true })).filter(entry => !entry.timestamp || entry.timestamp >= startedAt));
        supplied = [];
        const waiting = [];
        for (const entry of pending) {
            if (!snapshot.secUid) { waiting.push(entry); continue; }
            const result = parseProfileCapture(entry, snapshot.secUid);
            if (!result) continue;
            supplied.push(...result.items);
            complete = !result.hasMore;
        }
        pending = waiting;
        // Process newly captured items before considering pagination complete.
        if (supplied.length || complete) {
            const normalized = await readSnapshot(supplied);
            if (supplied.length && !normalized.rows.some(row => row.source === 'profile-network')) throw new CommandExecutionError('TikTok profile response contained no videos belonging to the requested account');
            for (const row of normalized.rows) if (!dedup.has(row.id)) dedup.set(row.id, row);
            if (dedup.size >= limit || complete) break;
        }
        if (attempt < 9) {
            if (attempt % 2 === 1) await page.autoScroll({ times: 1, delayMs: 800 });
            await page.wait(1);
        }
    }
    if (!dedup.size) {
        if (complete || knownEmpty) throw new EmptyResultError('tiktok user', `No videos found for @${username}`);
        throw new CommandExecutionError('TikTok profile did not expose a completed video response; the page may be blocked or still loading');
    }
    if (dedup.size < limit && !complete) log.warn('TikTok profile loading stopped before reaching the requested limit; returning captured videos.');
    return [...dedup.values()].sort((a, b) => (Number(b.createTime) || 0) - (Number(a.createTime) || 0))
        .slice(0, limit).map((row, index) => ({ ...row, index: index + 1 }));
}

export const userCommand = cli({
    site: 'tiktok',
    name: 'user',
    access: 'read',
    description: 'Get recent videos from a TikTok user from page-rendered responses',
    domain: 'www.tiktok.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        {
            name: 'username',
            required: true,
            positional: true,
            help: 'TikTok username (without @)',
        },
        { name: 'limit', type: 'int', default: DEFAULT_LIMIT, help: `Number of videos to return (max ${MAX_LIMIT})` },
    ],
    columns: ['index', 'id', 'source', 'author', 'url', 'cover', 'title', 'desc', 'plays', 'likes', 'comments', 'shares', 'createTime'],
    func: listUserVideos,
});

export const __test__ = {
    buildUserScript,
    DEFAULT_LIMIT,
    MAX_LIMIT,
};
