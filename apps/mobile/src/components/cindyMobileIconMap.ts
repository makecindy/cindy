/**
 * CINDY mobile icon slot map for M1/M2 UI alignment.
 *
 * This is pure metadata: M1 wires vendor glyphs; model marks follow the unified
 * gateway-driven rule (CatalogModel.icon from AI Gateway, provider mark fallback,
 * see MobileModelIconMark). Page-level replacement for folder/FAB/action-sheet
 * slots stays in the M2 layout pass.
 * (2026-07-19 撤销 D4-1:sessionLeadingGlyph 目标从 BrandArrow 回到厂商 glyph。)
 */
export type CindyMobileIconSlot =
  | 'sessionLeadingGlyph'
  | 'modelBrandMark'
  | 'projectFolder'
  | 'newChatFab'
  | 'sheetRename'
  | 'sheetPinTop'
  | 'sheetCopyLink'
  | 'sheetArchive'
  | 'sheetInfo'
  | 'sheetDelete';

export interface CindyMobileIconSpec {
  slot: CindyMobileIconSlot;
  currentAsset: string;
  targetAsset: string;
  status: 'wired' | 'mapped';
  colorToken: string;
  figmaNode?: string;
}

export const cindyMobileIconSpecs: readonly CindyMobileIconSpec[] = [
  {
    slot: 'sessionLeadingGlyph',
    currentAsset: 'MobileVendorIcon Claude/Codex glyph',
    targetAsset: 'MobileVendorIcon Claude/Codex glyph',
    status: 'wired',
    colorToken: 'textTertiary / statusAccent',
    figmaNode: '301:854 / 301:881 / 301:1077 / 301:1096',
  },
  {
    // 2026-07-20 定案:模型徽标以 AI Gateway 下发的 CatalogModel.icon 为准,缺省回落
    // 来源供应商标(MobileModelIconMark,桌面 ModelIconMark 同一套规则);客户端不再
    // 按 model id 猜厂牌——那会让订阅直连与 Cindy AI 网关同貌,用户无法自查计费来源。
    slot: 'modelBrandMark',
    currentAsset: 'MobileModelIconMark(gateway icon → provider mark fallback)',
    targetAsset: 'MobileModelIconMark',
    status: 'wired',
    colorToken: 'textSecondary / textPrimary',
  },
  {
    slot: 'projectFolder',
    currentAsset: 'lucide Folder / FolderOpen',
    targetAsset: 'material folder outline or custom active folder SVG',
    status: 'mapped',
    colorToken: 'textSecondary / activeGlyph',
    figmaNode: '301:898 / 301:905 / 301:912 / 301:1121 / 301:1128 / 301:1135',
  },
  {
    slot: 'newChatFab',
    currentAsset: 'lucide SquarePen',
    targetAsset: 'message compose glyph',
    status: 'mapped',
    colorToken: 'ctaText',
    figmaNode: '301:918 / 301:1141',
  },
  {
    slot: 'sheetRename',
    currentAsset: 'lucide Pencil',
    targetAsset: 'pencil action glyph',
    status: 'mapped',
    colorToken: 'textPrimary',
    figmaNode: '301:1016 / 301:1262',
  },
  {
    slot: 'sheetPinTop',
    currentAsset: 'lucide Pin / PinOff',
    targetAsset: 'top-filled action glyph',
    status: 'mapped',
    colorToken: 'textPrimary',
    figmaNode: '301:1019 / 301:1265',
  },
  {
    slot: 'sheetCopyLink',
    currentAsset: 'lucide Copy',
    targetAsset: 'copy link action glyph',
    status: 'mapped',
    colorToken: 'textPrimary',
    figmaNode: '301:1024 / 301:1270',
  },
  {
    slot: 'sheetArchive',
    currentAsset: 'lucide Archive',
    targetAsset: 'archive action glyph',
    status: 'mapped',
    colorToken: 'textPrimary',
    figmaNode: '301:1029 / 301:1275',
  },
  {
    slot: 'sheetInfo',
    currentAsset: 'lucide Info',
    targetAsset: 'info action glyph',
    status: 'mapped',
    colorToken: 'textPrimary',
    figmaNode: '301:1034 / 301:1280',
  },
  {
    slot: 'sheetDelete',
    currentAsset: 'lucide Trash2',
    targetAsset: 'delete action glyph',
    status: 'mapped',
    colorToken: 'destructive',
    figmaNode: '301:1038 / 301:1284',
  },
] as const;
