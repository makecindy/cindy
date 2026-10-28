/** HUD contract. Transparency is 0 (opaque) … 100 (invisible), never parent opacity. */
export const HUD_TRANSPARENCY_KEYS = [
  'backgroundTransparency',
  'composerTransparency',
  'messageTransparency',
  'inputTransparency',
  'imageTransparency',
  'controlsTransparency',
] as const;
export type HudTransparencyKey = (typeof HUD_TRANSPARENCY_KEYS)[number];
export const HUD_PASS_THROUGH_KEYS = [
  'passThroughBackground',
  'passThroughUserMessages',
  'passThroughAssistantMessages',
  'passThroughComposer',
] as const;
export type HudPassThroughKey = (typeof HUD_PASS_THROUGH_KEYS)[number];
export const HUD_POINTER_REGIONS = [
  'background',
  'userMessages',
  'assistantMessages',
  'composer',
  'controls',
] as const;
export type HudPointerRegion = (typeof HUD_POINTER_REGIONS)[number];
export interface HudSettings
  extends Record<HudTransparencyKey, number>, Record<HudPassThroughKey, boolean> {
  inputPosition: 'top' | 'bottom';
  allowScreen: boolean;
}
export const DEFAULT_HUD_SETTINGS: HudSettings = {
  backgroundTransparency: 20,
  composerTransparency: 5,
  messageTransparency: 0,
  inputTransparency: 0,
  imageTransparency: 0,
  controlsTransparency: 0,
  inputPosition: 'top',
  allowScreen: false,
  passThroughBackground: true,
  passThroughUserMessages: true,
  passThroughAssistantMessages: true,
  passThroughComposer: false,
};
export function parseHudPatch(raw: unknown): Partial<HudSettings> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if ((HUD_TRANSPARENCY_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)
        return null;
    } else if (key === 'inputPosition') {
      if (value !== 'top' && value !== 'bottom') return null;
    } else if (
      key === 'allowScreen' ||
      (HUD_PASS_THROUGH_KEYS as readonly string[]).includes(key)
    ) {
      if (typeof value !== 'boolean') return null;
    } else return null;
    patch[key] = value;
  }
  return patch as Partial<HudSettings>;
}
export function normalizeHudSettings(raw: unknown): HudSettings {
  const result = { ...DEFAULT_HUD_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const valid = parseHudPatch({ [key]: value });
      if (valid) Object.assign(result, valid);
    }
  }
  return result;
}
/** Only standalone, direct screen requests imply a capture. The per-send checkbox
 * covers other wording in every locale. Shared by renderer and main IPC so their
 * consent decisions cannot drift; quoted/technical/compound messages do not match.
 */
const HUD_SCREEN_REQUESTS: readonly RegExp[] = [
  // Simplified and Traditional Chinese.
  /^(?:请|請)?(?:帮我|幫我)?(?:看看?|解释|解釋|分析|描述|读一下|讀一下|识别|識別)(?:一下)?(?:我(?:的)?|这(?:个)?|這(?:個)?|当前|當前|现在|現在|目前|的|\s)*(?:屏幕|螢幕|界面|介面|画面|畫面|页面|頁面)(?:内容|內容)?(?:吧|好吗|好嗎)?$/,
  /^(?:这个|這個|当前|當前|现在的|現在的)(?:屏幕|螢幕|界面|介面|画面|畫面|页面|頁面)(?:说的|說的|显示的|顯示的)?(?:是什么|是什麼|有什么|有什麼)(?:意思|内容|內容)?$/,
  // English.
  /^(?:please\s+)?(?:look at|explain|describe|read|analy[sz]e)\s+(?:(?:this|the|my|current)\s+)*(?:screen|interface)(?:\s+content)?(?:,?\s+please)?$/i,
  /^what(?:['’]s| is)\s+(?:on\s+)?(?:my|this|the)\s+screen$/i,
  // Japanese and Korean: direct requests or questions about the current screen.
  /^(?:この|今の|現在の)?画面(?:の内容)?(?:を|について)(?:見て|説明して|解説して)(?:ください|くれる|もらえますか)?$/,
  /^(?:この|今の|現在の)画面には何が表示されていますか$/,
  /^(?:(?:이|현재|지금)\s*)?화면(?:의\s*내용)?(?:을|에\s*대해)?\s*(?:봐|설명해)\s*(?:줘|주세요|줄래|주실\s*수\s*있나요)$/,
  /^(?:(?:이|현재|지금)\s*)?화면에\s*(?:무엇이|뭐가)\s*(?:보이나요|나와\s*있나요)$/,
];
export function isHudScreenQuestion(text: string): boolean {
  const s = text.trim();
  if (!s || s.length > 500 || /[\r\n“”「」『』"`]/.test(s)) return false;
  const question = s.replace(/[?!？！。.]+$/, '').trim();
  return HUD_SCREEN_REQUESTS.some((pattern) => pattern.test(question));
}
/** Transient presentation only; do not persist the movement adjustment. */
export function getHudTransparency(saved: number, moving: boolean): number {
  return Math.min(100, saved + (moving ? saved * 0.1 : 0));
}
/** Native macOS stacking bands: normal, floating, modal-panel. */
export type HudLayer = 0 | 1 | 2;
export interface HudState {
  passThrough: boolean;
  moving: boolean;
  layer: HudLayer;
  active: boolean;
  capturing: boolean;
  settings: HudSettings;
}
export interface HudApi {
  get(): Promise<HudState>;
  setActive(active: boolean): Promise<HudState>;
  shiftLayer(step: -1 | 1): Promise<HudState>;
  setPassThrough(enabled: boolean): Promise<HudState>;
  setPointerRegion(region: HudPointerRegion): Promise<void>;
  setSettings(patch: Partial<HudSettings>): Promise<HudState>;
  resetSettings(): Promise<HudState>;
  capture(input: { text: string; explicit: boolean }): Promise<Uint8Array>;
  openScreenPermission(): Promise<void>;
  onChanged(callback: (state: HudState) => void): () => void;
}
