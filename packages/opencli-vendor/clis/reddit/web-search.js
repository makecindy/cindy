// Runs in the page context; fetchJsonOrLoginWall is injected by the caller.
export async function fetchRankedRedditSearch(query, subreddit, sort, time, limit, legacyPath) {
    const origin = 'https://www.reddit.com';
    const params = new URLSearchParams({ q: query, type: 'posts', sort, t: time });
    if (subreddit) params.set('restrict_sr', '1');
    let next = `${subreddit ? '/r/' + encodeURIComponent(subreddit) : ''}/search/?${params}`;
    const seenPages = new Set();
    const ids = [];
    const seenIds = new Set();
    const wall = (response, text, url) => ({ kind: 'login-wall', sentinel: {
        __loginWall: true, status: response.status, url: response.url || url,
        contentType: response.headers.get('content-type') || '', bodyPreview: text.slice(0, 100),
    } });
    async function listing(url) {
        const payload = await fetchJsonOrLoginWall(url, { credentials: 'include' });
        if (payload?.__loginWall && payload.status === 429) return { kind: 'http', status: 429 };
        if (payload?.__loginWall) return { kind: 'login-wall', sentinel: payload };
        if (payload?.error) return { kind: 'http', status: payload.error };
        if (!Array.isArray(payload?.data?.children)) return { kind: 'malformed', detail: 'payload is missing data.children' };
        return { kind: 'ok', rows: payload.data.children };
    }
    for (let page = 0; next && ids.length < limit && page < 10; page++) {
        if (seenPages.has(next)) return { kind: 'malformed', detail: 'web search repeated its pagination cursor' };
        seenPages.add(next);
        const response = await fetch(next, { credentials: 'include' });
        const text = await response.text();
        if (response.status === 429) return { kind: 'http', status: 429 };
        if (!response.ok) {
            if ([401, 403].includes(response.status) && /text\/html/i.test(response.headers.get('content-type') || '')) return wall(response, text, next);
            return { kind: 'http', status: response.status };
        }
        const landed = new URL(response.url || next, origin);
        if (landed.origin !== origin || /\/login\/?$|\/account\/login|\/challenge\/?$/.test(landed.pathname)) return wall(response, text, next);
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const units = Array.from(doc.querySelectorAll('[data-testid="search-post-unit"]'));
        if ((!units.length && /^(?:log in|login|access denied|blocked|security verification|just a moment)/i.test(doc.title))
            || (!units.length && /blocked by network security|whoa there, pardner|you.ve been blocked/i.test(doc.body?.textContent || ''))
            || (!units.length && doc.querySelector('form[action*="/login"], #loginForm, #challenge-form, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]'))) return wall(response, text, next);
        for (const unit of units) {
            const unitIds = new Set();
            for (const tracker of unit.querySelectorAll('search-telemetry-tracker[data-faceplate-tracking-context]')) {
                try {
                    const id = JSON.parse(tracker.getAttribute('data-faceplate-tracking-context'))?.post?.id;
                    if (typeof id === 'string' && /^t3_[a-z0-9]+$/.test(id)) unitIds.add(id);
                } catch { /* Ignore non-post telemetry, never execute page scripts. */ }
            }
            if (unitIds.size !== 1) return { kind: 'malformed', detail: 'web search result has missing or ambiguous post identity' };
            const id = [...unitIds][0];
            if (!seenIds.has(id)) { seenIds.add(id); ids.push(id); }
            if (ids.length === limit) break;
        }
        if (ids.length >= limit) { next = ''; break; }
        // Only markup incompatibility on the first page can use the legacy API.
        // Auth, rate limits, transport failures and partial-page failures are terminal.
        if (!units.length && page === 0) {
            if (/no (?:results|posts) found|couldn.t find any results/i.test(doc.body?.textContent || '')) return { kind: 'ok', rows: [] };
            const legacy = await listing(legacyPath);
            return legacy.kind === 'ok' ? { ...legacy, fallback: true } : legacy;
        }
        const cursors = new Set();
        for (const partial of doc.querySelectorAll('faceplate-partial[src]')) {
            const raw = partial.getAttribute('src');
            let url;
            try { url = new URL(raw, origin); } catch { continue; }
            if (!/^\/svc\/shreddit\/search(?:\/|$)/.test(url.pathname)) continue;
            if (url.origin !== origin || url.username || url.password) return { kind: 'malformed', detail: 'web search returned an unsafe pagination URL' };
            if (!url.searchParams.get('cursor')) continue;
            if (url.searchParams.has('q') && url.searchParams.get('q') !== query) return { kind: 'malformed', detail: 'web search pagination changed the query' };
            cursors.add(url.pathname + url.search);
        }
        if (cursors.size > 1) return { kind: 'malformed', detail: 'web search has ambiguous pagination cursors' };
        next = [...cursors][0] || '';
    }
    const byName = new Map();
    for (let offset = 0; offset < ids.length; offset += 100) {
        const result = await listing('/by_id/' + ids.slice(offset, offset + 100).join(',') + '.json?raw_json=1');
        if (result.kind !== 'ok') return result;
        for (const row of result.rows) {
            const name = row?.data?.name || (row?.data?.id ? 't3_' + row.data.id : '');
            if ((row.kind === undefined || row.kind === 't3') && seenIds.has(name) && !byName.has(name)) {
                if (!/^[a-z0-9]+$/.test(row?.data?.id || '') || name !== 't3_' + row.data.id) return { kind: 'malformed', detail: 'hydrated post identity does not match its fullname' };
                byName.set(name, row);
            }
        }
    }
    const rows = ids.map(id => byName.get(id)).filter(Boolean);
    if (ids.length && !rows.length) return { kind: 'malformed', detail: 'no ranked posts could be hydrated' };
    return { kind: 'ok', rows, missing: ids.length - rows.length, capped: Boolean(next && ids.length < limit) };
}
