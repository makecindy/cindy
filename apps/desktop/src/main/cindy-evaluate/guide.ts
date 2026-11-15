// Returned by list_models so the Agent reads interpretation rules only when it is about
// to call; the tool description stays short because every task loads it.
export const EVALUATION_GUIDE: Record<'decisions' | 'rerank', readonly string[]> = {
  decisions: [
    'answers 以问题 ID 为键。noul：noul 是「成立」的概率（0–1）。choice：choice 是概率最高的选项 ID，probabilities 是各选项的概率。',
    'score：score 是等级序号（从 0 开始，对应 criteria 数组位置）按概率加权的平均值，三个等级时在 0–2 之间；它不是百分制，通常也不是整数。最可能的等级看 probabilities，序号含义看 legend。',
    'box：box 的 left、top、right、bottom 是相对图片宽和高的 0–1 比例，不是像素。',
    '共用同一份材料、互不依赖的问题放进同一次调用；后一题要用到前一题的答案时分开调用。',
    '答案是概率，不是确定结论。需要明确的是/否或分档时按业务定阈值；结果会影响重要决定时，先用几条已知答案的样例试出阈值，换模型或改题目后重新确认。',
  ],
  rerank: [
    'results 不含原文：index 是文本在 documents 中的下标（从 0 开始），relevance_score 越高越相关，按分数从高到低就是相关度顺序。',
    '分数只适合比较同一次请求里的文本，不同查询或不同模型之间不要直接比较；要过滤不相关文本时，先用几条已知样例确定阈值。',
    '单段过长可能被模型截断，长文档先按段落切开再排。',
  ],
};
