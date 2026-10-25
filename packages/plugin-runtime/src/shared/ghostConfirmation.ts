/** Host-owned confirmation identity and sanitized presentation. */
export interface GhostConfirmShowParams {
  ghostId: string;
  /** 插件展示名(主机拼标题用)。 */
  ghostName: string;
  /** 插件图标 data URL(身份头;未声明图标时缺省)。 */
  iconDataUrl?: string;
  /** 净化后的问句正文。 */
  body: string;
  /** 净化后的主按钮文案;null = 用主机缺省文案。 */
  confirmText: string | null;
  /** 净化后的次按钮文案;null = 用主机缺省文案。 */
  cancelText: string | null;
  danger: boolean;
  mobilePageId?: string;
}
