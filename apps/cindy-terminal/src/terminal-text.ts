export function terminalText(value: string): string {
  // Strip OSC/DCS/CSI before C0; removing only ESC would expose their payload.
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P_X^][\s\S]*?\x1b\\/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
