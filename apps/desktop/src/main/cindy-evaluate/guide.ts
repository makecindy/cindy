// Returned by list_models so field meanings arrive only when the Agent is about to call.
// State facts only: whether and how to use a result stays the Agent's decision.
export const EVALUATION_GUIDE: Record<'decisions' | 'rerank', readonly string[]> = {
  decisions: [
    'answers 以问题 ID 为键，一次调用的多道问题共用同一份 state。noul：noul 是「成立」的概率（0–1）。choice：choice 是概率最高的选项 ID，probabilities 是各选项的概率。',
    'score：score 是等级序号（从 0 开始，对应 criteria 数组位置）按概率加权的平均值，三个等级时在 0–2 之间；它不是百分制，通常也不是整数。各等级的概率见 probabilities，序号含义见 legend。',
    'box：box 的 left、top、right、bottom 是相对图片宽和高的 0–1 比例，不是像素。',
  ],
  rerank: [
    'results 不含原文：index 是文本在 documents 中的下标（从 0 开始），relevance_score 越高越相关。',
    '分数只在同一次请求内可比，不同查询或不同模型之间不能直接比较；单段过长可能被模型截断。',
  ],
};
