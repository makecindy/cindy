import { createContext } from 'react';

/**
 * 原生分组(ComposerNativeSection)的标题是否按设置页同一档画(13/18 600 textTertiary)。
 * 系统默认分组标题在新版 iOS 是大号粗体;「+」面板(ContextSheet)给整块内容开启。
 */
export const ComposerSectionSettingsHeader = createContext(false);
