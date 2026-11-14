export class EvaluationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
