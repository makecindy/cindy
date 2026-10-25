const COLD_START_CC_MODEL_ID = 'claude-opus-5';
const COLD_START_CODEX_MODEL_ID = 'gpt-5.6-sol';
const COLD_START_PI_MODEL_ID = 'claude-sonnet-5';

/** 冷启动占位 id 的只读导出（newMakerDraft 的种子默认复用，避免另一处写死）。 */
export function coldStartModelIdForVendor(vendorKey: 'cc' | 'codex' | 'pi'): string {
  return vendorKey === 'codex'
    ? COLD_START_CODEX_MODEL_ID
    : vendorKey === 'pi'
      ? COLD_START_PI_MODEL_ID
      : COLD_START_CC_MODEL_ID;
}

/** 冷启动占位的展示名(与占位 id 同源,仅首帧短暂可见)。 */
export function coldStartLabelForVendor(vendorKey: 'cc' | 'codex' | 'pi'): string {
  return vendorKey === 'codex' ? 'GPT-5.6-Sol' : vendorKey === 'pi' ? 'Sonnet 5' : 'Opus 5';
}
