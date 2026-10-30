import { CliError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { DBLP_ORIGIN } from './utils.js';

function pageState() {
    return {
        origin: location.origin,
        challenge: /making sure.*not a bot|anubis|access denied|security verification/i.test(document.title)
            || Boolean(document.querySelector('#anubis_challenge, #anubis-challenge')),
    };
}

async function ensureDblpReady(page) {
    let state = await page.evaluate(`(${pageState.toString()})()`);
    if (state?.origin !== DBLP_ORIGIN) {
        await page.goto(DBLP_ORIGIN);
        state = await page.evaluate(`(${pageState.toString()})()`);
    }
    // Allow the site's own startup to settle; never solve or retry a challenge request.
    for (let attempt = 0; state?.challenge && attempt < 15; attempt++) {
        await page.wait(1);
        state = await page.evaluate(`(${pageState.toString()})()`);
    }
    if (state?.challenge) throw new CliError('SECURITY_BLOCK', 'dblp browser verification has not cleared.', 'Open dblp.org in your browser and resolve its verification before retrying.');
    if (state?.origin !== DBLP_ORIGIN) throw new CommandExecutionError('The browser did not reach dblp.org.');
}

function parseDblpXml(text) {
    // DBLP uses named character entities from its external DTD. Resolve only
    // HTML character entities locally; DOMParser never fetches the DTD.
    const expanded = text.replace(/&([A-Za-z][A-Za-z0-9]+);/g, (entity, name) => {
        if (['amp', 'lt', 'gt', 'apos', 'quot'].includes(name)) return entity;
        const node = document.createElement('textarea');
        node.innerHTML = entity;
        return node.value === entity ? entity : Array.from(node.value, char => '&#' + char.codePointAt(0) + ';').join('');
    });
    const doc = new DOMParser().parseFromString(expanded, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    return doc;
}

function xmlValue(node) {
    const result = Object.create(null);
    for (const attr of node.attributes) result['@' + attr.name] = attr.value;
    const children = Array.from(node.children);
    if (!children.length || !['result', 'hits', 'hit', 'info', 'authors'].includes(node.tagName)) {
        if (!node.attributes.length) return node.textContent || '';
        result.text = node.textContent || '';
        return result;
    }
    for (const child of children) {
        const value = xmlValue(child);
        if (Object.hasOwn(result, child.tagName)) {
            if (!Array.isArray(result[child.tagName])) result[child.tagName] = [result[child.tagName]];
            result[child.tagName].push(value);
        } else result[child.tagName] = value;
    }
    return result;
}

async function requestDblp(page, path, label, search) {
    const url = new URL(path, DBLP_ORIGIN);
    if (url.origin !== DBLP_ORIGIN) throw new CommandExecutionError('Invalid dblp request origin.');
    if (search) url.searchParams.set('format', 'xml');
    await ensureDblpReady(page);
    const result = await page.evaluateOnce(`(async () => {
        try {
            const response = await fetch(${JSON.stringify(url.href)}, { credentials: 'include', headers: { accept: 'application/xml' } });
            const text = await response.text();
            const html = /^\\s*(?:<!doctype html|<html)/i.test(text) || /text\\/html/i.test(response.headers.get('content-type') || '');
            const challenge = html && /anubis|making sure.*not a bot|\\.within\\.website|security verification/i.test(text);
            if (challenge) return { kind: 'challenge' };
            if (!response.ok) return { kind: 'http', status: response.status };
            if (new URL(response.url || ${JSON.stringify(url.href)}).origin !== ${JSON.stringify(DBLP_ORIGIN)}) return { kind: 'redirect' };
            if (html) return { kind: 'html' };
            const parseDblpXml = ${parseDblpXml.toString()};
            const doc = parseDblpXml(text);
            if (!doc) return { kind: 'xml' };
            const root = doc.documentElement;
            if (${search}) {
                if (root.tagName !== 'result') return { kind: 'envelope' };
                const xmlValue = ${xmlValue.toString()};
                return { kind: 'ok', data: { result: xmlValue(root) } };
            }
            const expectedRoot = ${JSON.stringify(url.pathname.startsWith('/pid/') ? 'dblpperson' : 'dblp')};
            if (root.tagName !== expectedRoot) return { kind: 'envelope' };
            return { kind: 'ok', data: new XMLSerializer().serializeToString(doc) };
        } catch (error) {
            return { kind: 'network', message: String(error?.message || error).slice(0, 200) };
        }
    })()`);
    if (result?.kind === 'ok') return result.data;
    if (result?.kind === 'challenge') throw new CliError('SECURITY_BLOCK', `${label} returned a browser challenge.`, 'Resolve the verification in your browser before retrying; no request was retried.');
    if (result?.kind === 'http' && result.status === 404) throw new EmptyResultError(label, 'dblp returned HTTP 404.');
    if (result?.kind === 'http' && result.status === 429) throw new CliError('RATE_LIMITED', `${label} returned HTTP 429.`, 'Wait before making another request.');
    throw new CommandExecutionError(`${label} failed: ${result?.kind === 'http' ? 'HTTP ' + result.status : result?.kind || 'invalid browser response'}.`, 'Inspect the dblp page in your browser; the response was not treated as an empty result.');
}

// Preserve the existing search-result shape while requesting the supported XML format.
export async function dblpFetchSearch(page, path, label) {
    const data = await requestDblp(page, path, label, true);
    const status = String(data?.result?.status?.['@code'] || '');
    if (status !== '200') throw new CommandExecutionError(`${label} returned API status ${status || 'missing'}.`);
    const hits = data.result.hits;
    if (!hits || typeof hits !== 'object') throw new CommandExecutionError(`${label} returned no hits envelope.`);
    if (hits.hit !== undefined && !Array.isArray(hits.hit)) hits.hit = [hits.hit];
    return data;
}

export async function dblpFetchXml(page, path, label) {
    return requestDblp(page, path, label, false);
}
