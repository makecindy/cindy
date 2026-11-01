import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ExpertEntry } from '@cindy/maker-core/experts';

import { HermesExpertLabelView } from '@/features/cc-agent/HermesExpertLabel';
import { HermesExpertPickerView, buildExpertOptions } from '@/features/cc-agent/HermesExpertPicker';

const expert = (slug: string, extra: Partial<NonNullable<ExpertEntry['expert']>> = {}): ExpertEntry => ({
  slug,
  dir: `/home/o/.cindy-harness/experts/${slug}`,
  expert: {
    slug,
    dir: `/home/o/.cindy-harness/experts/${slug}`,
    name: slug,
    description: '',
    agent: 'hermes',
    tools: [],
    skills: [],
    memory: false,
    tags: [],
    prompt: 'p',
    skillFiles: [],
    ...extra,
  },
});

describe('Hermes expert picker (ROADMAP 3.2a)', () => {
  it('offers Hermes experts and lists broken or non-Hermes ones as unpickable', () => {
    const options = buildExpertOptions([
      expert('code-reviewer', { name: 'Code Reviewer', model: 'local-backup', description: 'Reviews diffs' }),
      expert('codex-one', { name: 'Codex One', agent: 'codex' }),
      { slug: 'broken', dir: '/x/broken', error: 'frontmatter "name" is required' },
    ]);
    expect(options).toEqual([
      {
        slug: 'code-reviewer',
        label: 'Code Reviewer',
        disabled: false,
        title: 'Reviews diffs\nModel route: local-backup\n/home/o/.cindy-harness/experts/code-reviewer',
      },
      { slug: 'codex-one', label: 'Codex One (codex, not supported yet)', disabled: true, title: 'Only Hermes experts can be started yet.' },
      { slug: 'broken', label: 'broken (broken)', disabled: true, title: 'frontmatter "name" is required' },
    ]);

    const html = renderToStaticMarkup(
      <HermesExpertPickerView options={options} value="code-reviewer" onChange={() => undefined} />,
    );
    expect(html).toContain('data-testid="hermes-expert-picker"');
    expect(html).toContain('<option value="">No expert</option>');
    expect(html).toMatch(/<option value="codex-one" disabled=""/);
    expect(html).toMatch(/<option value="code-reviewer"[^>]*selected=""/);
  });

  it('renders nothing when there are no experts, so the toolbar is unchanged', () => {
    expect(renderToStaticMarkup(<HermesExpertPickerView options={[]} value={null} onChange={() => undefined} />)).toBe('');
  });

  it('header chip names the expert and shows its folder; a broken expert stays visible', () => {
    const html = renderToStaticMarkup(
      <HermesExpertLabelView binding={{ sessionId: 's1', slug: 'code-reviewer', dir: '/e/code-reviewer', name: 'Code Reviewer', model: 'local-backup' }} />,
    );
    expect(html).toContain('data-testid="hermes-session-expert"');
    expect(html).toContain('>Code Reviewer</span>');
    expect(html).toContain('Model route: local-backup');
    expect(html).toContain('/e/code-reviewer');

    const broken = renderToStaticMarkup(
      <HermesExpertLabelView binding={{ sessionId: 's1', slug: 'code-reviewer', dir: '/e/code-reviewer', error: 'expert.md is missing' }} />,
    );
    expect(broken).toContain('code-reviewer (broken)');
    expect(broken).toContain('expert.md is missing');
    expect(renderToStaticMarkup(<HermesExpertLabelView binding={null} />)).toBe('');
  });
});
