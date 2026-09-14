interface ScanGateLike {
  name: string;
}

function normalizeCode(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export function isPublicationProcessingFailure(gates: ScanGateLike[] | undefined): boolean {
  return gates?.some((gate) => normalizeCode(gate.name) === 'internal-error') ?? false;
}
