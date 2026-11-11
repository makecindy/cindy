export function makeGhostManual64KiBFixture(): {
  content: string;
  wire: string;
} {
  const sentinel = "GHOST_MANUAL_TOOL_RESULT_ONLY_20260809";
  const unit = '中文 "quote" \\ slash\n';
  let content = `${sentinel}\n`;
  while (
    Buffer.byteLength(`${content}${unit}END_${sentinel}`, "utf8") <=
    64 * 1024
  ) {
    content += unit;
  }
  content += `END_${sentinel}`;
  return { content, wire: JSON.stringify({ ok: true, manual: [], content }) };
}
