/**
 * Pixiv download — download all images from an illustration.
 *
 * Pixiv's CDN (i.pximg.net) requires Referer: https://www.pixiv.net/ header.
 * Uses the /ajax/illust/{id}/pages API to get original-quality image URLs.
 */
import { recipeOutputPath } from '@jackwener/opencli/cindy/host';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { formatCookieHeader, httpDownload } from '@jackwener/opencli/download';
import { formatBytes } from '@jackwener/opencli/download/progress';
import { ArgumentError, CommandExecutionError, EmptyResultError, getErrorMessage } from '@jackwener/opencli/errors';
import { pixivFetch } from './utils.js';

function normalizeArtworkId(value) {
    const raw = String(value ?? '').trim();
    if (/^\d+$/.test(raw)) return raw;
    try {
        const url = new URL(raw);
        const match = url.pathname.match(/^\/(?:[a-z]{2}\/)?artworks\/(\d+)\/?$/);
        if (url.protocol === 'https:' && ['pixiv.net', 'www.pixiv.net'].includes(url.hostname)
            && !url.username && !url.password && !url.port && match) return match[1];
    } catch { /* Not an artwork URL. */ }
    throw new ArgumentError('Expected a numeric illustration ID or a pixiv.net artwork URL');
}

cli({
    site: 'pixiv',
    name: 'download',
    access: 'read',
    description: 'Download illustration images from Pixiv',
    domain: 'www.pixiv.net',
    strategy: Strategy.COOKIE,
    args: [
        { name: 'illust-id', positional: true, required: true, help: 'Illustration ID or Pixiv artwork URL' },
        { name: 'output', default: './pixiv-downloads', help: 'Output directory' },
    ],
    columns: ['index', 'type', 'status', 'size'],
    func: async (page, kwargs) => {
        const illustId = normalizeArtworkId(kwargs['illust-id']);
        const output = String(kwargs.output ?? './pixiv-downloads');
        // pixivFetch handles navigate + error checking; returns the response body directly
        const pages = await pixivFetch(page, `/ajax/illust/${illustId}/pages`, {
            notFoundMsg: `Illustration not found: ${illustId}`,
        });
        if (!Array.isArray(pages)) {
            throw new CommandExecutionError('Pixiv pages API returned malformed payload');
        }
        if (pages.length === 0) {
            throw new EmptyResultError('pixiv download', `No images found for illustration ${illustId}.`);
        }
        // Extract cookies for authenticated downloads
        const cookies = formatCookieHeader(await page.getCookies({ domain: 'pixiv.net' }));
        // Create output directory
        const outputDir = path.join(output, illustId);
        fs.mkdirSync(recipeOutputPath(outputDir), { recursive: true });
        const results = [];
        for (let i = 0; i < pages.length; i++) {
            const p = pages[i];
            const url = p.urls?.original || p.urls?.regular || '';
            if (!url) {
                results.push({ index: i + 1, type: 'image', status: 'failed', size: 'No URL' });
                continue;
            }
            try {
                const ext = path.extname(new URL(url).pathname) || '.jpg';
                const filename = `${illustId}_p${i}${ext}`;
                const destPath = path.join(outputDir, filename);
                const result = await httpDownload(url, destPath, {
                    cookies,
                    headers: { Referer: 'https://www.pixiv.net/' },
                    timeout: 60000,
                });
                results.push({
                    index: i + 1,
                    type: 'image',
                    status: result.success ? 'success' : 'failed',
                    size: result.success ? formatBytes(result.size) : (result.error || 'unknown error'),
                });
            }
            catch (err) {
                results.push({
                    index: i + 1,
                    type: 'image',
                    status: 'failed',
                    size: getErrorMessage(err),
                });
            }
        }
        return results;
    },
});
