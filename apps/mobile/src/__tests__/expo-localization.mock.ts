// vitest 全局兜底 mock:expo-localization 真模块会拖 react-native 依赖链
// (Flow 语法,node 环境解析失败)。需要控制语言的测试仍用 vi.mock 按用例覆盖,
// vi.mock 优先于本 alias。默认给 en-US,与「未设置 override 兜底 en」语义一致。
export function getLocales(): Array<{ languageTag: string; languageCode: string }> {
  return [{ languageTag: 'en-US', languageCode: 'en' }];
}
