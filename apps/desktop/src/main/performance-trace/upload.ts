import { createHash, randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { throwIpcError } from '../utils/ipcValidate';
import type { GateVerdict } from '../log-upload/consentGate';
import { sendLogs } from '../log-upload/logSink';
import { redact } from '../log-upload/redact';
import type { LogUploadMeta, LogUploadTarget, UploadRecord } from '../log-upload/types';
import type { TraceReport } from './report';
import {
  MAX_TRACE_FILE_BYTES,
  MAX_TRACE_TOTAL_BYTES,
  TRACE_ARTIFACT_NAMES,
  redactTraceArtifact,
  type TraceArtifact,
} from './artifacts';

const compress = promisify(gzip);
const CHUNK_BYTES = 12 * 1024;
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;

export async function submitPerformanceReport(
  deps: {
    owner(): string;
    gate(): GateVerdict;
    target(): LogUploadTarget | null;
    meta(reportId: string): LogUploadMeta;
    fetch(input: string, init?: RequestInit): Promise<Response>;
    artifacts(): Promise<TraceArtifact[]>;
  },
  report: TraceReport,
  note: string,
): Promise<void> {
  const owner = deps.owner();
  const check = () => {
    if (owner !== deps.owner()) throwIpcError('PRECONDITION_FAILED', 'App session changed');
    const gate = deps.gate();
    if (gate.kind !== 'allowed') {
      if (gate.kind === 'denied' && gate.reason === 'not-configured')
        throwIpcError('LOG_UPLOAD_UNAVAILABLE', 'Upload is not configured');
      throwIpcError('PRIVACY_CONSENT_REQUIRED', 'Privacy consent is required');
    }
  };
  check();
  const target = deps.target();
  if (!target) throwIpcError('LOG_UPLOAD_UNAVAILABLE', 'Upload is not configured');
  const artifacts = await deps.artifacts();
  check();
  const names = new Set(artifacts.map((file) => file.name));
  const missing = TRACE_ARTIFACT_NAMES.filter((name) => !names.has(name));
  if (
    names.size !== artifacts.length ||
    !names.has('report.json') ||
    artifacts.some((file) => !TRACE_ARTIFACT_NAMES.includes(file.name)) ||
    (!report.partial && missing.length)
  )
    throwIpcError('LOG_UPLOAD_FAILED', 'Recording files are missing or invalid');
  let total = 0;
  let preparedTotal = 0;
  let compressedTotal = 0;
  const prepared = [];
  for (const file of artifacts) {
    total += file.bytes.length;
    if (file.bytes.length > MAX_TRACE_FILE_BYTES || total > MAX_TRACE_TOTAL_BYTES)
      throwIpcError(
        'LOG_UPLOAD_FAILED',
        'Recording exceeds upload limit; local files are preserved',
      );
    const bytes = await redactTraceArtifact(file.bytes);
    preparedTotal += bytes.length;
    check();
    if (bytes.length > MAX_TRACE_FILE_BYTES || preparedTotal > MAX_TRACE_TOTAL_BYTES)
      throwIpcError('LOG_UPLOAD_FAILED', 'Prepared recording exceeds upload limit');
    const compressed = await compress(bytes);
    compressedTotal += compressed.length;
    if (compressedTotal > MAX_COMPRESSED_BYTES)
      throwIpcError('LOG_UPLOAD_FAILED', 'Compressed recording exceeds upload limit');
    prepared.push({
      compressed,
      descriptor: {
        name: file.name,
        bytes: bytes.length,
        compressedBytes: compressed.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        chunks: Math.ceil(compressed.length / CHUNK_BYTES),
      },
    });
  }
  // Retries have separate attempts; never combine chunks from different uploads.
  const attemptId = randomUUID();
  const records: UploadRecord[] = [];
  const push = (data: unknown) =>
    records.push({
      ts: new Date(report.startedAt).toISOString(),
      level: 'info',
      src: 'main',
      scope: 'performance-trace-files',
      msg: JSON.stringify({
        protocol: 'cindy-performance-files',
        version: 1,
        reportId: report.reportId,
        attemptId,
        sequence: records.length,
        data,
      }),
    });
  push({
    kind: 'manifest',
    encoding: 'gzip+base64',
    redaction: 'log-upload-v1',
    files: prepared.map((file) => file.descriptor),
    missing,
    partial: report.partial,
    durationMs: report.durationMs,
    note: redact(note.slice(0, 1000)),
  });
  for (const file of prepared) {
    for (let index = 0; index < file.descriptor.chunks; index++) {
      push({
        kind: 'chunk',
        name: file.descriptor.name,
        index,
        content: file.compressed
          .subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)
          .toString('base64'),
      });
    }
  }
  const send = async (batch: UploadRecord[]) => {
    check();
    const result = await sendLogs(
      {
        fetchImpl: (url, init) => {
          check();
          return deps.fetch(url, init);
        },
      },
      target,
      deps.meta(report.reportId),
      batch,
    );
    if (!result.ok) throwIpcError('LOG_UPLOAD_FAILED', 'Performance file upload did not finish');
    check();
  };
  await send(records);
  const count = records.length;
  push({ kind: 'complete', records: count + 1, files: prepared.length });
  await send([records[count]]);
}
