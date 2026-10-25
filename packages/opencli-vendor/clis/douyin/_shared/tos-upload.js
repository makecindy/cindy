import { closeRecipeFileSync, openRecipeFileSync } from '@jackwener/opencli/cindy/host';
/**
 * TOS multipart upload. Progress and upload IDs live only in this invocation;
 * no cross-call resume files are read or persisted by Cindy.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { CommandExecutionError } from '@jackwener/opencli/errors';
const PART_SIZE = 5 * 1024 * 1024; // 5 MB minimum per TOS/S3 spec
// ── AWS Signature V4 ─────────────────────────────────────────────────────────
function hmacSha256(key, data) {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}
function sha256Hex(data) {
    const hash = crypto.createHash('sha256');
    if (typeof data === 'string') {
        hash.update(data, 'utf8');
    }
    else {
        hash.update(data);
    }
    return hash.digest('hex');
}
const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    return value >>> 0;
});
function crc32Hex(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
function gatewayBaseUrl(tosUrl) {
    const parsedUrl = new URL(tosUrl);
    return `https://${parsedUrl.host}/upload/v1${parsedUrl.pathname}`;
}
function gatewayHeaders(auth, uploadHeader, userId = '') {
    return {
        Authorization: auth,
        'X-Storage-U': encodeURIComponent(userId),
        ...(uploadHeader ?? {}),
    };
}
function extractRegionFromHost(host) {
    // e.g. "tos-cn-i-alisg.volces.com" → "cn-i-alisg"
    // e.g. "tos-cn-beijing.ivolces.com" → "cn-beijing"
    const match = host.match(/^tos-([^.]+)\./);
    if (match)
        return match[1];
    return 'cn-north-1'; // fallback
}
/**
 * Compute AWS Signature V4 headers for a TOS request.
 * Returns a Record of all headers to include (including Authorization, x-amz-date, etc.)
 */
function computeAws4Headers(opts) {
    const { method, url, credentials, service, region, datetime } = opts;
    const date = datetime.slice(0, 8); // YYYYMMDD
    const parsedUrl = new URL(url);
    const canonicalUri = parsedUrl.pathname || '/';
    // Canonical query string: sort by name, encode
    const queryParams = [...parsedUrl.searchParams.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    const bodyHash = sha256Hex(opts.body);
    // Merge in required headers and compute canonical headers
    const allHeaders = {
        ...opts.headers,
        host: parsedUrl.host,
        'x-amz-content-sha256': bodyHash,
        'x-amz-date': datetime,
        'x-amz-security-token': credentials.session_token,
    };
    const sortedHeaderKeys = Object.keys(allHeaders).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const canonicalHeaders = sortedHeaderKeys
        .map(k => `${k.toLowerCase()}:${allHeaders[k].trim()}`)
        .join('\n') + '\n';
    const signedHeadersList = sortedHeaderKeys.map(k => k.toLowerCase()).join(';');
    const canonicalRequest = [
        method.toUpperCase(),
        canonicalUri,
        queryParams,
        canonicalHeaders,
        signedHeadersList,
        bodyHash,
    ].join('\n');
    const credentialScope = `${date}/${region}/${service}/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        datetime,
        credentialScope,
        sha256Hex(canonicalRequest),
    ].join('\n');
    // Signing key chain
    const kDate = hmacSha256(`AWS4${credentials.secret_access_key}`, date);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, service);
    const kSigning = hmacSha256(kService, 'aws4_request');
    const signature = hmacSha256(kSigning, stringToSign).toString('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.access_key_id}/${credentialScope}, SignedHeaders=${signedHeadersList}, Signature=${signature}`;
    return {
        ...allHeaders,
        Authorization: authorization,
    };
}
// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function tosRequest(opts) {
    const { method, url, headers, body } = opts;
    const fetchBody = body == null ? null
        : typeof body === 'string' ? body
            : body;
    const res = await fetch(url, {
        method,
        headers,
        body: fetchBody,
        signal: AbortSignal.timeout(60000),
    });
    const responseBody = await res.text();
    const responseHeaders = {};
    res.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
    });
    return { status: res.status, headers: responseHeaders, body: responseBody };
}
function nowDatetime() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
function extractUploadId(body) {
    const xmlMatch = body.match(/<UploadId>([^<]+)<\/UploadId>/i);
    if (xmlMatch) return xmlMatch[1];
    try {
        const json = JSON.parse(body);
        return json?.payload?.uploadID
            || json?.payload?.uploadId
            || json?.payload?.UploadID
            || json?.payload?.UploadId
            || json?.data?.uploadid
            || json?.data?.uploadID
            || json?.data?.uploadId
            || json?.data?.UploadID
            || json?.data?.UploadId
            || json?.UploadID
            || json?.UploadId
            || json?.uploadID
            || json?.uploadId
            || null;
    }
    catch {
        return null;
    }
}
// ── Phase 1: Init multipart upload ───────────────────────────────────────────
async function initMultipartUpload(tosUrl, auth, uploadHeader, userId) {
    const initUrl = `${gatewayBaseUrl(tosUrl)}?uploadmode=part&phase=init`;
    const res = await tosRequest({
        method: 'POST',
        url: initUrl,
        headers: gatewayHeaders(auth, uploadHeader, userId),
    });
    if (res.status !== 200) {
        throw new CommandExecutionError(`TOS init multipart upload failed with status ${res.status}: ${res.body}`, 'Check that TOS upload authorization is valid and not expired.');
    }
    const uploadId = extractUploadId(res.body);
    if (!uploadId) {
        throw new CommandExecutionError(`TOS init response missing UploadId: ${res.body}`);
    }
    return uploadId;
}
// ── Phase 2: Upload a single part ────────────────────────────────────────────
async function uploadPart(tosUrl, partNumber, uploadId, data, auth, uploadHeader, userId) {
    const crc32 = crc32Hex(data);
    const url = `${gatewayBaseUrl(tosUrl)}?uploadid=${encodeURIComponent(uploadId)}&part_number=${partNumber}&phase=transfer`;
    const headers = {
        ...gatewayHeaders(auth, uploadHeader, userId),
        'Content-CRC32': crc32,
        'Content-Type': 'application/octet-stream',
        'X-Use-Init-Upload-Optimize': '1',
        'X-Use-Large-Local-Cache': '1',
    };
    const res = await tosRequest({ method: 'POST', url, headers, body: data });
    let parsed;
    try {
        parsed = JSON.parse(res.body);
    }
    catch {
        parsed = null;
    }
    if (res.status !== 200 || parsed?.code !== 2000) {
        throw new CommandExecutionError(`TOS upload part ${partNumber} failed with status ${res.status}: ${res.body}`, 'Check that TOS upload authorization is valid and not expired.');
    }
    return parsed?.data?.crc32 || crc32;
}
// ── Phase 3: Complete multipart upload ───────────────────────────────────────
async function completeMultipartUpload(tosUrl, uploadId, parts, auth, uploadHeader, userId) {
    const url = `${gatewayBaseUrl(tosUrl)}?uploadmode=part&phase=finish&uploadid=${encodeURIComponent(uploadId)}`;
    const body = parts
        .sort((a, b) => a.partNumber - b.partNumber)
        .map(p => `${p.partNumber}:${p.crc32}`)
        .join(',');
    const res = await tosRequest({
        method: 'POST',
        url,
        headers: gatewayHeaders(auth, uploadHeader, userId),
        body,
    });
    let parsed;
    try {
        parsed = JSON.parse(res.body);
    }
    catch {
        parsed = null;
    }
    if (res.status !== 200 || parsed?.code !== 2000) {
        throw new CommandExecutionError(`TOS complete multipart upload failed with status ${res.status}: ${res.body}`, 'Check that all parts were uploaded successfully.');
    }
    return parsed?.data?.key || null;
}
let _readSyncOverride = null;
/** @internal — for testing only */
export function setReadSyncOverride(fn) {
    _readSyncOverride = fn;
}
// ── Public API ───────────────────────────────────────────────────────────────
export async function tosUpload(options) {
    const { filePath, uploadInfo, onProgress } = options;
    // Approve and open the source before creating any remote multipart upload.
    const fd = openRecipeFileSync(filePath);
    try {
        const { size: fileSize } = fs.fstatSync(fd);
        if (fileSize === 0) {
            throw new CommandExecutionError(`Video file is empty: ${filePath}`);
        }
        const { tos_upload_url: tosUrl, auth, upload_header: uploadHeader, user_id: userId } = uploadInfo;
        const uploadId = await initMultipartUpload(tosUrl, auth, uploadHeader, userId);
        const completedParts = [];
        const totalParts = Math.ceil(fileSize / PART_SIZE);
        if (onProgress) onProgress(0, fileSize);
        for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
            const offset = (partNumber - 1) * PART_SIZE;
            const chunkSize = Math.min(PART_SIZE, fileSize - offset);
            const buffer = Buffer.allocUnsafe(chunkSize);
            const readFn = _readSyncOverride ?? fs.readSync;
            const bytesRead = readFn(fd, buffer, 0, chunkSize, offset);
            if (bytesRead !== chunkSize) {
                throw new CommandExecutionError(`Short read on part ${partNumber}: expected ${chunkSize} bytes, got ${bytesRead}`);
            }
            const crc32 = await uploadPart(tosUrl, partNumber, uploadId, buffer, auth, uploadHeader, userId);
            completedParts.push({ partNumber, crc32 });
            if (onProgress) onProgress(Math.min(offset + chunkSize, fileSize), fileSize);
        }
        return await completeMultipartUpload(tosUrl, uploadId, completedParts, auth, uploadHeader, userId);
    }
    finally {
        closeRecipeFileSync(fd);
    }
}
// ── Internal exports for testing ─────────────────────────────────────────────
export { PART_SIZE, extractRegionFromHost, computeAws4Headers, extractUploadId, crc32Hex, gatewayBaseUrl, gatewayHeaders, };
