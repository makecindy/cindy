interface DefaultModelCandidate {
  id: string;
  mode?: string;
  defaultEnabled?: boolean;
  availability?: string;
  costDiscount?: number;
  newSessionDefault?: readonly string[];
  modalities?: { input: readonly string[]; output: readonly string[] };
}

/** Small default selection over the current account's provider catalog, never an availability filter.
 * Older/duplicate models stay in settings; renderer visibility overrides still win afterwards.
 */
export function selectDefaultModels(
  models: readonly DefaultModelCandidate[],
  providerId?: string,
): ReadonlySet<string> {
  const groups = new Map<string, DefaultModelCandidate[]>();
  const selected = new Set<string>();
  for (const model of models) {
    if (model.defaultEnabled === false || model.availability === 'requires_payment') continue;
    if (model.mode && model.mode !== 'chat' && model.mode !== 'responses') continue;
    // Alternate-context routes remain opt-in. Reviewed Gateway previews need live route
    // capabilities; shared Registry metadata must not enable a direct-provider experiment.
    if (/\[1m\]|:auto$/i.test(model.id)) continue;
    if (
      /(?:^|[-/:])(?:exp|experimental|preview)(?:$|[-/:])/i.test(model.id) &&
      !isReviewedGatewayPreview(model, providerId)
    )
      continue;
    const vendor = vendorOf(model.id);
    // Unrecognized bare IDs retain their upstream policy. Do not guess their manufacturer.
    if (!vendor) {
      selected.add(model.id);
      continue;
    }
    const group = groups.get(vendor) ?? [];
    group.push(model);
    groups.set(vendor, group);
  }
  for (const [vendor, candidates] of groups) {
    const sorted = [...candidates].sort((a, b) => compareCandidates(a, b, providerId));
    if (vendor === 'anthropic' || vendor === 'openai') {
      // Keep each approved family, so a new flagship never removes the everyday families.
      const roles = vendor === 'anthropic'
        ? ['fable', 'opus', 'sonnet', 'haiku']
        : ['flagship', 'sol', 'terra', 'luna'];
      for (const role of roles) {
        const winner = sorted.find((model) => roleOf(vendor, model.id) === role);
        if (winner) selected.add(winner.id);
      }
    } else {
      const winner = sorted.find((model) => model.newSessionDefault?.length) ?? sorted[0];
      if (winner) selected.add(winner.id);
    }
  }
  return selected;
}

function slug(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1).toLowerCase();
}

function vendorOf(id: string): string | null {
  const [namespace] = id.toLowerCase().split('/');
  if (id.includes('/')) {
    const aliases: Record<string, string> = {
      'anthropic-claude': 'anthropic',
      codex: 'openai',
      chatgpt: 'openai',
      'x-ai-grok': 'xai',
      'x-ai': 'xai',
      moonshotai: 'moonshot',
    };
    return Object.hasOwn(aliases, namespace!) ? aliases[namespace!]! : namespace!;
  }
  const families: Array<[string, RegExp]> = [
    ['anthropic', /^claude-/],
    ['openai', /^gpt-/],
    ['google', /^gemini-/],
    ['deepseek', /^deepseek-/],
    ['qwen', /^qwen/],
    ['z-ai', /^glm-/],
    ['moonshot', /^kimi-/],
    ['xai', /^grok-/],
    ['tencent', /^hy\d/],
  ];
  return families.find(([, pattern]) => pattern.test(id.toLowerCase()))?.[0] ?? null;
}

function roleOf(vendor: string, id: string): string | null {
  const name = slug(id);
  if (vendor === 'anthropic') {
    return /^claude-(fable|opus|sonnet|haiku)-/.exec(name)?.[1] ?? null;
  }
  const family = /(?:^|-)(sol|terra|luna)(?:-|$)/.exec(name)?.[1];
  if (family) return family;
  // Spark and small legacy variants remain opt-in. Bare numbered GPTs provide the
  // flagship fallback on accounts that do not yet have Astra.
  return /^gpt-\d+(?:[.-]\d+)*(?:-astra)?$/.test(name) ? 'flagship' : null;
}

function version(id: string): number[] {
  // Date suffixes identify snapshots, not model generations; 4-5 and 4.5 compare equally.
  return (
    slug(id)
      .replace(/\d+b(?:-|$)/g, '')
      .match(/\d+/g) ?? []
  )
    .filter((part) => part.length < 6)
    .slice(0, 3)
    .map(Number);
}

function variantRank(id: string): number {
  const name = slug(id);
  if (/(?:^|-)(fable|sonnet|sol|max|pro)(?:-|$)/.test(name)) return 0;
  if (/(?:^|-)(opus|terra)(?:-|$)/.test(name)) return 1;
  if (/(?:^|-)(haiku|luna|flash)(?:-|$)/.test(name)) return 2;
  return 1;
}

function discount(model: DefaultModelCandidate): number {
  const value = model.costDiscount;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : 0;
}

function hasImageInput(model: DefaultModelCandidate): boolean {
  return (
    model.modalities?.input.includes('image') === true && model.modalities.output.includes('text')
  );
}

/** Product-reviewed exceptions, scoped to live XD routes, never inferred from a model name. */
function isReviewedGatewayPreview(model: DefaultModelCandidate, providerId?: string): boolean {
  if (
    providerId !== 'xd' ||
    model.mode !== 'chat' ||
    !model.modalities?.input.includes('text') ||
    !model.modalities.output.includes('text')
  )
    return false;
  if (model.id === 'deepseek/deepseek-v4-flash-vision-exp') return hasImageInput(model);
  return model.id === 'tencent/hy4-preview';
}

function compareCandidates(
  a: DefaultModelCandidate,
  b: DefaultModelCandidate,
  providerId?: string,
): number {
  const av = version(a.id),
    bv = version(b.id);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const difference = (bv[i] ?? 0) - (av[i] ?? 0);
    if (difference) return difference;
  }
  return (
    (providerId === 'xd' ? Number(hasImageInput(b)) - Number(hasImageInput(a)) : 0) ||
    variantRank(a.id) - variantRank(b.id) ||
    discount(b) - discount(a) ||
    a.id.localeCompare(b.id, 'en')
  );
}
