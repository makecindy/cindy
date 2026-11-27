import { statRecipeFileSync, recipeOutputPath } from '@jackwener/opencli/cindy/host';
import { resolveRecipePath } from '@jackwener/opencli/cindy/host';
import { readRecipeFileSync } from '@jackwener/opencli/cindy/host';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { unwrapBrowserResult } from './shared.js';
import { isRecoverableFileInputError } from './utils.js';

const MAX_IMAGES = 4;
const UPLOAD_POLL_MS = 500;
const UPLOAD_TIMEOUT_MS = 30_000;
const COMPOSER_POLL_MS = 250;
const COMPOSER_TIMEOUT_MS = 10_000;
const SUBMIT_POLL_MS = 500;
const SUBMIT_TIMEOUT_MS = 15_000;
const COMPOSE_URL = 'https://x.com/compose/post';
const FILE_INPUT_SELECTOR = 'input[type="file"][data-testid="fileInput"]';
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov']);
// Keep the existing Cindy host upload limit; account-specific duration/codec
// checks remain with X. Do not impose the free-account limits on subscribers.
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const VIDEO_UPLOAD_TIMEOUT_MS = 180_000;

function validateVideoPath(raw) {
    const absPath = resolveRecipePath(raw.trim());
    if (!VIDEO_EXTENSIONS.has(path.extname(absPath).toLowerCase())) {
        throw new CommandExecutionError('Unsupported video format. Use MP4 or MOV (H.264 video with AAC audio).');
    }
    const stat = statRecipeFileSync(absPath);
    if (!stat.isFile() || stat.size === 0) {
        throw new CommandExecutionError(`Not a valid video file: ${absPath}`);
    }
    if (stat.size > MAX_VIDEO_BYTES) {
        throw new CommandExecutionError('Video exceeds the Cindy browser upload limit of 100 MiB. Compress the video before uploading.');
    }
    return absPath;
}

function validatePostVideo(kwargs) {
    if (kwargs.video && kwargs.images) {
        throw new CommandExecutionError('Use either video or images for this command, not both.');
    }
    return kwargs.video ? validateVideoPath(String(kwargs.video)) : null;
}

async function waitForVideoUpload(page) {
    // Short probes keep each browser request within the host timeout. A video
    // preview alone is insufficient: X shows it while still uploading/encoding.
    const deadline = Date.now() + VIDEO_UPLOAD_TIMEOUT_MS;
    do {
        const state = requirePostActionResult(await page.evaluate(`(() => {
            const visible = el => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
            const box = Array.from(document.querySelectorAll('[data-testid="tweetTextarea_0"]')).find(visible);
            const root = box?.closest('[role="dialog"]') || document;
            const alerts = Array.from(root.querySelectorAll('[role="alert"], [data-testid="toast"]'));
            const error = alerts.find(el => visible(el) && /failed|error|could not|cannot|unsupported|not supported|too (?:large|long)|exceed|失败|出错|无法|不支持|过大|过长|超出|超过/i.test(el.textContent || ''));
            if (error) return { ok: false, error: (error.textContent || 'Video upload failed.').trim() };
            const attachments = root.querySelector('[data-testid="attachments"]');
            const preview = attachments?.querySelector('video, [data-testid="videoPlayer"], [data-testid="videoComponent"]');
            // The composer also has a character-count progressbar. Only media
            // progress blocks a video, otherwise valid text would never post.
            const progress = Array.from(attachments?.querySelectorAll('[role="progressbar"], progress, [aria-busy="true"]') || []).some(visible);
            const button = Array.from(root.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]')).find(visible);
            return { ok: !!preview && visible(attachments) && !progress && !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' };
        })()`), 'Twitter video upload verification');
        if (state.error) {
            throw new CommandExecutionError(`Video upload failed: ${state.error}`, 'Nothing was posted. Check the video format and your X account limits.');
        }
        if (state.ok) return;
        await new Promise(resolve => setTimeout(resolve, UPLOAD_POLL_MS));
    } while (Date.now() < deadline);
    throw new TimeoutError('twitter video upload', VIDEO_UPLOAD_TIMEOUT_MS / 1000,
        'Nothing was posted. The video is still uploading or processing; check the X composer before trying again.');
}

function validateImagePaths(raw) {
    const paths = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (paths.length > MAX_IMAGES) {
        throw new CommandExecutionError(`Too many images: ${paths.length} (max ${MAX_IMAGES})`);
    }
    return paths.map(p => {
        const absPath = resolveRecipePath(p);
        const ext = path.extname(absPath).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
            throw new CommandExecutionError(`Unsupported image format "${ext}". Supported: jpg, png, gif, webp`);
        }
        const stat = statRecipeFileSync(resolveRecipePath(absPath));
        if (!stat || !stat.isFile()) {
            throw new CommandExecutionError(`Not a valid file: ${absPath}`);
        }
        return absPath;
    });
}

function isUnsupportedInsertTextError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    return lower.includes('unknown action') || lower.includes('not supported') || lower.includes('inserttext returned no inserted flag');
}

function requirePostActionResult(value, context) {
    const result = unwrapBrowserResult(value);
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') {
        throw new CommandExecutionError(`${context} returned a malformed result.`);
    }
    if (Object.prototype.hasOwnProperty.call(result, 'message') && result.message != null && typeof result.message !== 'string') {
        throw new CommandExecutionError(`${context} returned a malformed message.`);
    }
    if (Object.prototype.hasOwnProperty.call(result, 'error') && result.error != null && typeof result.error !== 'string') {
        throw new CommandExecutionError(`${context} returned a malformed error.`);
    }
    return result;
}

function validateSubmitStatusPair(result) {
    if ((result.id && !result.url) || (!result.id && result.url)) {
        throw new CommandExecutionError('Twitter post completion returned only one of id/url.');
    }
    if (!result.id && !result.url) return;
    if (typeof result.id !== 'string' || !/^\d+$/.test(result.id)) {
        throw new CommandExecutionError('Twitter post completion returned a malformed status id.');
    }
    if (typeof result.url !== 'string') {
        throw new CommandExecutionError('Twitter post completion returned a malformed status url.');
    }
    let url;
    try {
        url = new URL(result.url);
    } catch {
        throw new CommandExecutionError('Twitter post completion returned a malformed status url.');
    }
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)\/?$/);
    if (!['x.com', 'twitter.com', 'mobile.twitter.com'].includes(hostname) || !match || match[2] !== result.id) {
        throw new CommandExecutionError('Twitter post completion returned a malformed status url.');
    }
}

async function focusComposer(page) {
    return requirePostActionResult(await page.evaluate(`(() => {
        const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
        const boxes = Array.from(document.querySelectorAll('[data-testid="tweetTextarea_0"]'));
        const box = boxes.find(visible) || boxes[0];
        if (!box) return { ok: false, message: 'Could not find the tweet composer text area. Are you logged in?' };
        box.focus();
        return { ok: true };
    })()`), 'Twitter composer focus');
}

async function verifyComposerText(page, text) {
    const iterations = Math.ceil(COMPOSER_TIMEOUT_MS / COMPOSER_POLL_MS);
    return requirePostActionResult(await page.evaluate(`(async () => {
        const expected = ${JSON.stringify(text)};
        const normalize = s => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        const normalizedExpected = normalize(expected);
        for (let i = 0; i < ${JSON.stringify(iterations)}; i++) {
            const box = document.querySelector('[data-testid="tweetTextarea_0"]');
            const actual = box ? (box.innerText || box.textContent || '') : '';
            if (box && normalize(actual).includes(normalizedExpected)) return { ok: true };
            await new Promise(r => setTimeout(r, ${JSON.stringify(COMPOSER_POLL_MS)}));
        }
        const box = document.querySelector('[data-testid="tweetTextarea_0"]');
        return {
            ok: false,
            message: 'Could not verify tweet text in the composer after typing.',
            actualText: box ? (box.innerText || box.textContent || '') : ''
        };
    })()`), 'Twitter composer text verification');
}

async function insertComposerText(page, text) {
    const focusResult = await focusComposer(page);
    if (!focusResult?.ok) return focusResult;

    const nativeInserters = [
        page.nativeType?.bind(page),
        page.insertText?.bind(page),
    ].filter(Boolean);

    for (const insert of nativeInserters) {
        try {
            // Native CDP Input.insertText updates Twitter/X's Draft.js editor much more
            // reliably than synthetic paste/input events. Prefer the Page CDP helper
            // when available because older Browser Bridge insert-text can report
            // inserted while the editor state does not change after media upload.
            await insert(text);
            const verified = await verifyComposerText(page, text);
            if (verified?.ok) return verified;
        }
        catch (err) {
            if (!isUnsupportedInsertTextError(err)) throw err;
            // Older Browser Bridge versions do not expose this insertion path; try the next one.
        }
    }

    return requirePostActionResult(await page.evaluate(`(async () => {
        try {
            const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
            const boxes = Array.from(document.querySelectorAll('[data-testid="tweetTextarea_0"]'));
            const box = boxes.find(visible) || boxes[0];
            if (!box) return { ok: false, message: 'Could not find the tweet composer text area. Are you logged in?' };
            const textToInsert = ${JSON.stringify(text)};
            const normalize = s => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
            box.focus();
            if (!document.execCommand('insertText', false, textToInsert)) {
                const dt = new DataTransfer();
                dt.setData('text/plain', textToInsert);
                box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            }
            await new Promise(r => setTimeout(r, 500));
            const actual = box.innerText || box.textContent || '';
            if (normalize(actual).includes(normalize(textToInsert))) return { ok: true };
            return { ok: false, message: 'Could not verify tweet text in the composer after typing.', actualText: actual };
        } catch (e) { return { ok: false, message: String(e) }; }
    })()`), 'Twitter composer DOM insertion');
}

async function waitForImageUpload(page, expectedCount) {
    const iterations = Math.ceil(UPLOAD_TIMEOUT_MS / UPLOAD_POLL_MS);
    return requirePostActionResult(await page.evaluate(`(async () => {
        const expected = ${JSON.stringify(expectedCount)};
        const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
        for (let i = 0; i < ${JSON.stringify(iterations)}; i++) {
            await new Promise(r => setTimeout(r, ${JSON.stringify(UPLOAD_POLL_MS)}));
            const attachments = document.querySelector('[data-testid="attachments"]');
            const previewCount = Math.max(
                attachments ? attachments.querySelectorAll('[role="group"], img, video').length : 0,
                document.querySelectorAll('[data-testid="tweetPhoto"], img[src^="blob:"], video[src^="blob:"]').length,
                Array.from(document.querySelectorAll('button,[role="button"]')).filter((el) =>
                    /remove media|remove image|remove/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''))
                ).length
            );
            const button = Array.from(document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]'))
                .find((el) => visible(el));
            const buttonReady = !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
            if (previewCount >= expected && buttonReady) return { ok: true, previewCount };
        }
        return { ok: false, message: 'Image upload timed out (${UPLOAD_TIMEOUT_MS / 1000}s).' };
    })()`), 'Twitter image upload verification');
}

async function attachMediaViaDataTransfer(page, absPaths) {
    const files = absPaths.map((absPath) => {
        const ext = path.extname(absPath).toLowerCase();
        const mime = ext === '.mp4' ? 'video/mp4'
            : ext === '.mov' ? 'video/quicktime'
            : ext === '.png'
            ? 'image/png'
            : ext === '.gif'
                ? 'image/gif'
                : ext === '.webp'
                    ? 'image/webp'
                    : 'image/jpeg';
        return {
            name: path.basename(absPath),
            mime,
            base64: readRecipeFileSync(absPath).toString('base64'),
        };
    });
    const upload = requirePostActionResult(await page.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(FILE_INPUT_SELECTOR)});
        if (!input) return { ok: false, error: 'No file input found' };
        const dt = new DataTransfer();
        for (const file of ${JSON.stringify(files)}) {
            const bin = atob(file.base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            dt.items.add(new File([bytes], file.name, { type: file.mime }));
        }
        let assigned = false;
        try {
            Object.defineProperty(input, 'files', { value: dt.files, writable: false, configurable: true });
            assigned = input.files && input.files.length >= ${JSON.stringify(absPaths.length)};
        } catch(e) {
            try {
                const nativeInputFileSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files');
                if (nativeInputFileSetter && nativeInputFileSetter.set) {
                    nativeInputFileSetter.set.call(input, dt.files);
                    assigned = input.files && input.files.length >= ${JSON.stringify(absPaths.length)};
                }
            } catch(e2) { /* ignore */ }
        }
        if (!assigned) return { ok: false, error: 'Could not assign files to input' };
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true };
    })()`), 'Twitter media upload fallback');
    if (!upload?.ok) {
        throw new CommandExecutionError(`Media upload failed (base64 fallback): ${upload?.error ?? 'unknown error'}`);
    }
}

async function submitTweet(page, text) {
    const clickResult = requirePostActionResult(await page.evaluate(`(async () => {
        try {
            const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
            for (const toast of Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]'))) {
                if (visible(toast)) toast.setAttribute('data-opencli-before-submit-toast', 'true');
            }
            const buttons = Array.from(document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]'));
            const btn = buttons.find((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
            if (!btn) return { ok: false, message: 'Tweet button is disabled or not found.' };
            btn.click();
            return { ok: true };
        } catch (e) { return { ok: false, message: String(e) }; }
    })()`), 'Twitter post click');
    if (!clickResult?.ok) return clickResult;

    const iterations = Math.ceil(SUBMIT_TIMEOUT_MS / SUBMIT_POLL_MS);
    const result = requirePostActionResult(await page.evaluate(`(async () => {
        const expected = ${JSON.stringify(text)};
        const normalize = s => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        const expectedText = normalize(expected);
        const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
        const statusUrl = (root) => {
            if (!root || typeof root.querySelectorAll !== 'function') return {};
            const links = Array.from(root.querySelectorAll('a[href*="/status/"]'));
            for (const link of links) {
                const href = link.href || link.getAttribute('href') || '';
                if (!href) continue;
                try {
                    const url = new URL(href, window.location.origin);
                    const hostname = url.hostname.toLowerCase().replace(/^www\\./, '');
                    if (!['x.com', 'twitter.com', 'mobile.twitter.com'].includes(hostname)) continue;
                    const match = url.pathname.match(/^\\/([^/]+)\\/status\\/(\\d+)\\/?$/);
                    if (match) return { url: url.href, id: match[2] };
                } catch {}
            }
            return {};
        };
        for (let i = 0; i < ${JSON.stringify(iterations)}; i++) {
            await new Promise(r => setTimeout(r, ${JSON.stringify(SUBMIT_POLL_MS)}));
            const toasts = Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]'))
                .filter((el) => visible(el) && !el.hasAttribute('data-opencli-before-submit-toast'));
            // A failure such as "Your post was not sent" must never match success.
            const alert = toasts.find((el) => /failed|error|try again|not sent|not posted|could not|发送失败|发布失败|无法发送|无法发布|请重试|出错/i.test(el.textContent || ''));
            if (alert) return { ok: false, message: (alert.textContent || 'Tweet failed to post.').trim() };
            // X localizes this transient toast according to the account language.
            const successToast = toasts.find((el) => /your post was sent|your tweet was sent|post sent|tweet sent|posted successfully|已发送|已发布|已发出|发布成功|发送成功/i.test(el.textContent || ''));
            if (successToast) return { ok: true, message: 'Tweet posted successfully.', ...statusUrl(successToast) };

            // Composer disappearance or text clearing alone is not a reliable
            // postcondition: X may close/rewrite the modal after failed submits.
            // Require a fresh success toast so the evidence is tied to this click.
        }
        return { ok: false, unconfirmed: true, message: 'Tweet submission did not complete before timeout.' };
    })()`), 'Twitter post completion');
    validateSubmitStatusPair(result);
    return result;
}

cli({
    site: 'twitter',
    name: 'post',
    access: 'write',
    description: 'Post to X with text and up to 4 images, or one MP4/MOV video (100 MiB max in Cindy)',
    domain: 'x.com',
    strategy: Strategy.UI,
    browser: true,
    args: [
        { name: 'text', type: 'string', required: true, positional: true, help: 'The text content of the tweet' },
        { name: 'images', type: 'string', required: false, help: 'Image paths, comma-separated, max 4 (jpg/png/gif/webp)' },
        { name: 'video', type: 'string', required: false, help: 'One local MP4/MOV video path, max 100 MiB in Cindy. Prefer H.264/AAC. X free accounts: 140 seconds; subscription limits vary. Cannot combine with images.' },
    ],
    columns: ['status', 'message', 'text', 'id', 'url'],
    // Input failures must not count as executed writes or pause the recipe.
    validateArgs: kwargs => { validatePostVideo(kwargs); },
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('Browser session required for twitter post');

        // Validate attachments before any browser interaction.
        const videoPath = validatePostVideo(kwargs);
        const absPaths = videoPath ? [videoPath] : kwargs.images ? validateImagePaths(String(kwargs.images)) : [];
        const text = String(kwargs.text ?? '');

        // The current X standalone composer is /compose/post. It keeps a single,
        // visible composer and is the same route used by the reply command.
        await page.goto(COMPOSE_URL, { waitUntil: 'load', settleMs: 2500 });
        await page.wait({ selector: '[data-testid="tweetTextarea_0"]', timeout: 15 });

        // Attach media before inserting text. Uploading media after Draft.js has
        // text can re-render/reset the editor, causing image-only posts.
        if (absPaths.length > 0) {
            await page.wait({ selector: FILE_INPUT_SELECTOR, timeout: 20 });
            if (page.setFileInput) {
                try {
                    await page.setFileInput(absPaths, FILE_INPUT_SELECTOR);
                } catch (err) {
                    if (!isRecoverableFileInputError(err)) {
                        throw err;
                    }
                    await attachMediaViaDataTransfer(page, absPaths);
                }
            } else {
                await attachMediaViaDataTransfer(page, absPaths);
            }
            if (!videoPath) {
                const uploadState = await waitForImageUpload(page, absPaths.length);
                if (!uploadState?.ok) {
                    throw new TimeoutError('twitter image upload', UPLOAD_TIMEOUT_MS / 1000, 'Nothing was posted. Retry, or attach a smaller image.');
                }
            }
        }

        // Insert and verify the text after media upload so text + images are in
        // the final Draft.js composer state immediately before clicking Post.
        const typeResult = await insertComposerText(page, text);
        if (!typeResult?.ok) {
            throw new CommandExecutionError(typeResult?.message ?? 'Could not type tweet text.', 'Open the composer in the browser and check whether X is asking you to log in.');
        }

        if (videoPath) {
            await waitForVideoUpload(page);
            const verified = await verifyComposerText(page, text);
            if (!verified.ok) throw new CommandExecutionError(verified.message, 'Nothing was posted. Check the X composer text.');
        }
        await page.wait(1);
        const result = await submitTweet(page, text);
        if (result?.unconfirmed) {
            // The poll expiring does not mean the tweet stayed in the composer,
            // so this must not read as a definite failure: the agent workflow
            // retries CommandExecutionError and would post twice (#2255).
            throw new TimeoutError('twitter post', SUBMIT_TIMEOUT_MS / 1000, `${result.message} Check \`opencli twitter tweets --limit 1\` before retrying; the post may already be live.`);
        }
        if (!result?.ok) {
            throw new CommandExecutionError(result?.message ?? 'Tweet failed to post.', 'Nothing was posted. Open the composer in the browser and retry.');
        }
        return [{
            status: 'success',
            message: result.message,
            text,
            ...(result.id ? { id: result.id } : {}),
            ...(result.url ? { url: result.url } : {}),
        }];
    }
});
