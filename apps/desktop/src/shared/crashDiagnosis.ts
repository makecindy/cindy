/** Local desktop recovery only; never exposed through device-link. */
export interface CrashDiagnosisSummary {
  count: number;
  details: string;
}
export interface CrashDiagnosisEvidence extends CrashDiagnosisSummary {
  logs: string;
  logsUnavailable: boolean;
}
