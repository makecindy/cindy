import type { IOSSimulatorRuntimeErrorCode } from "./types.js";

/** Typed parse/runtime failure used internally before normalization into a report. */
export class IOSSimulatorRuntimeError extends Error {
  readonly code: IOSSimulatorRuntimeErrorCode;

  constructor(code: IOSSimulatorRuntimeErrorCode, message: string) {
    super(message);
    this.name = "IOSSimulatorRuntimeError";
    this.code = code;
  }
}
