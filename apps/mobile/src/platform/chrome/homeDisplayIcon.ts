/**
 * 首页「⋯」显示设置按钮的工具栏图像:与 homeMenuIcon 同为 26pt 透明画布、glyph 居中不动。
 * 在看已归档任务时换成带 6pt 提醒点的版本;点是 statusAccent 色,不随模板着色,所以按
 * 深浅色各出一张原色图(glyph 取 textPrimary)。不用空 Stack.Toolbar.Badge,原因见
 * assets/navigation/README.md。
 */
export const homeDisplayIcon = require('../../../assets/navigation/ellipsis.png');
export const homeDisplayAttentionIcon = {
  light: require('../../../assets/navigation/ellipsis-attention-light.png'),
  dark: require('../../../assets/navigation/ellipsis-attention-dark.png'),
};
