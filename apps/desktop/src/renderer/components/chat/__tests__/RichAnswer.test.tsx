import { VideoSitePreview } from '../VideoSitePreview';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'test-owner' } }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { RichAnswer } from '../RichAnswer';
afterEach(cleanup);
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
);
const line = (seq: number, op: Record<string, unknown>) => JSON.stringify({ seq, ...op }) + '\n';
// Tier 1: the parser's depth/node limits must also bound renderer work. Previously
// each tabs ancestor rendered its descendants twice, making this tiny answer
// invoke the leaf renderer 2^depth times on every streamed update.
it('renders each nested tab descendant once through streaming and finalization', () => {
  let source = '';
  for (let index = 0; index < 10; index++) {
    source += line(index + 1, {
      op: 'create',
      id: `tabs-${index}`,
      kind: 'tabs',
      ...(index > 0 ? { parent: `tabs-${index - 1}` } : {}),
    });
  }
  source += line(11, {
    op: 'create',
    id: 'leaf',
    kind: 'markdown',
    parent: 'tabs-9',
    props: { text: 'Before' },
  });
  const renderMarkdown = vi.fn((text: string) => <span>{text}</span>);
  const props = { stateKey: 'nested-tabs', renderMarkdown };
  const view = render(<RichAnswer {...props} source={source} complete={false} />);
  expect(screen.getByText('Before')).toBeTruthy();
  expect(renderMarkdown).toHaveBeenCalledTimes(1);

  renderMarkdown.mockClear();
  source += line(12, { op: 'append', id: 'leaf', text: ' and after' });
  view.rerender(<RichAnswer {...props} source={source} complete={false} />);
  expect(screen.getByText('Before and after')).toBeTruthy();
  expect(renderMarkdown).toHaveBeenCalledTimes(1);

  renderMarkdown.mockClear();
  view.rerender(<RichAnswer {...props} source={source} complete />);
  expect(screen.getByText('Before and after')).toBeTruthy();
  expect(renderMarkdown).toHaveBeenCalledTimes(1);
});
it('keeps inactive tab controls mounted through selection and streamed patches', () => {
  const source =
    line(1, { op: 'create', id: 'tabs', kind: 'tabs' }) +
    line(2, {
      op: 'create',
      id: 'first',
      kind: 'stack',
      parent: 'tabs',
      props: { label: 'First' },
    }) +
    line(3, {
      op: 'create',
      id: 'second',
      kind: 'stack',
      parent: 'tabs',
      props: { label: 'Second' },
    }) +
    line(4, {
      op: 'create',
      id: 'input',
      kind: 'input',
      parent: 'second',
      props: { label: 'Name', default: 'Original' },
    });
  const props = { stateKey: 'tab-controls', renderMarkdown: (text: string) => <span>{text}</span> };
  const view = render(<RichAnswer {...props} source={source} complete={false} />);
  const input = screen.getByLabelText('Name');
  fireEvent.click(screen.getByRole('tab', { name: 'Second' }));
  fireEvent.change(input, { target: { value: 'Edited' } });
  fireEvent.click(screen.getByRole('tab', { name: 'First' }));
  view.rerender(
    <RichAnswer
      {...props}
      source={
        source +
        line(5, {
          op: 'patch',
          id: 'input',
          props: { default: 'Updated' },
        })
      }
      complete
    />,
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Second' }));
  expect(screen.getByLabelText('Name')).toBe(input);
  expect((input as HTMLInputElement).value).toBe('Edited');
  expect(screen.getByRole('tabpanel').contains(input)).toBe(true);
});
// Tier 1: mount the production renderer; input identity/state must survive
// streamed patches, the final marker, and message-list virtualization.
it('preserves edited controls through patches, finalization and remount', () => {
  const source =
    line(1, {
      op: 'create',
      id: 'name',
      kind: 'input',
      props: { label: 'Name', default: 'Original' },
    }) + line(2, { op: 'create', id: 'note', kind: 'text', props: { text: 'Before' } });
  const props = { stateKey: 'stream-state', renderMarkdown: (text: string) => <span>{text}</span> };
  const view = render(<RichAnswer {...props} source={source} complete={false} />);
  const input = screen.getByLabelText('Name');
  fireEvent.change(input, { target: { value: 'Edited' } });
  const updated =
    source +
    line(3, { op: 'patch', id: 'name', props: { default: 'New default' } }) +
    line(4, { op: 'append', id: 'note', text: ' and after' });
  view.rerender(<RichAnswer {...props} source={updated} complete={true} />);
  expect(screen.getByLabelText('Name')).toBe(input);
  expect((input as HTMLInputElement).value).toBe('Edited');
  // Immediate reload must save the edit before the debounce fires.
  fireEvent(window, new Event('pagehide'));
  const saved = JSON.parse(localStorage.getItem('cindy.richAnswer.viewState.v1')!);
  expect(saved.entries.find(([key]: [string]) => key === 'test-owner:stream-state')[1].name).toBe(
    'Edited',
  );
  expect(screen.getByText('Before and after')).toBeTruthy();
  view.unmount();
  render(<RichAnswer {...props} source={updated} complete />);
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Edited');
});
it('routes image media through the host renderer without evaluating generated markup', () => {
  const source =
    line(1, {
      op: 'create',
      id: 'image',
      kind: 'image',
      props: { src: 'library:assets/a.png', alt: 'Preview' },
    }) +
    line(2, {
      op: 'create',
      id: 'text',
      kind: 'text',
      props: { text: '<script>throw 1</script>' },
    });
  const renderMarkdown = vi.fn((text: string) => <span>{text}</span>);
  const view = render(
    <RichAnswer stateKey="media" source={source} complete renderMarkdown={renderMarkdown} />,
  );
  expect(renderMarkdown).toHaveBeenCalledWith('![Preview](<library:assets/a.png>)', 'image');
  expect(view.container.querySelector('script')).toBeNull();
  expect(screen.getByText('<script>throw 1</script>')).toBeTruthy();
});
// Tier 1: a referenced result may arrive after its consumer in a live answer.
// Pending/error states must not erase readable content or misrepresent a total.
it('renders pending calculated references, resolves them and isolates invalid final values', () => {
  const first =
    line(1, {
      op: 'create',
      id: 'total',
      kind: 'stat',
      props: { label: 'Total', value: { ref: 'price' } },
    }) +
    line(2, { op: 'create', id: 'note', kind: 'text', props: { text: 'Existing explanation' } });
  const props = {
    stateKey: 'forward-reference',
    renderMarkdown: (text: string) => <span>{text}</span>,
  };
  const view = render(<RichAnswer {...props} source={first} complete={false} />);
  expect(screen.getByRole('status').textContent).toBe('…');
  view.rerender(
    <RichAnswer
      {...props}
      source={first + line(3, { op: 'create', id: 'price', kind: 'stat', props: { value: 25 } })}
      complete
    />,
  );
  expect(screen.queryByText('…')).toBeNull();
  expect(screen.getAllByText('25')).toHaveLength(2);
  view.rerender(<RichAnswer {...props} source={first} complete />);
  expect(screen.getByRole('status').textContent).toBe('richAnswer.calculationUnavailable');
  expect(screen.getByText('Existing explanation')).toBeTruthy();
});

// Tier 1: the everyday chart acceptance showed an unlabeled polyline. A streamed
// data patch must update its visible point values, category labels and accessible data.
it('labels chart points in place and updates them when the model revises a value', () => {
  const source = line(1, {
    op: 'create',
    id: 'trend',
    kind: 'chart',
    props: {
      label: '收入（万元）',
      variant: 'line',
      data: [
        { label: '1月', value: 12 },
        { label: '2月', value: 18 },
      ],
    },
  });
  const props = { stateKey: 'chart-labels', renderMarkdown: (text: string) => <span>{text}</span> };
  const view = render(<RichAnswer {...props} source={source} complete={false} />);
  expect(screen.getByRole('img').getAttribute('aria-label')).toContain('1月: 12, 2月: 18');
  expect([...view.container.querySelectorAll('svg text')].map((n) => n.textContent)).toContain(
    '12',
  );
  expect(screen.getByText('2月')).toBeTruthy();
  view.rerender(
    <RichAnswer
      {...props}
      source={
        source +
        line(2, {
          op: 'patch',
          id: 'trend',
          props: {
            data: [
              { label: '1月', value: 12 },
              { label: '2月', value: -6 },
            ],
          },
        })
      }
      complete
    />,
  );
  expect(screen.getByRole('img').getAttribute('aria-label')).toContain('2月: -6');
  expect(view.container.querySelectorAll('circle')).toHaveLength(2);
  expect(view.container.querySelector('polyline')?.getAttribute('points')).not.toMatch(
    /NaN|Infinity/,
  );
});

// Tier 1: native icons must retain their text (including an unknown icon name),
// without interpreting a model-supplied name as a resource or action.
it('renders native icon explanations and keeps unknown icon text readable', () => {
  const source =
    line(1, {
      op: 'create',
      id: 'mail',
      kind: 'icon',
      props: { name: 'mail', label: '邮件', text: '收发工作消息' },
    }) +
    line(2, {
      op: 'create',
      id: 'other',
      kind: 'icon',
      props: { name: 'https://invalid.example/icon.svg', label: '未知入口', text: '保留说明' },
    });
  const view = render(
    <RichAnswer
      stateKey="icons"
      source={source}
      complete
      renderMarkdown={(text) => <span>{text}</span>}
    />,
  );
  expect(screen.getByText('邮件')).toBeTruthy();
  expect(screen.getByText('收发工作消息')).toBeTruthy();
  expect(screen.getByText('保留说明')).toBeTruthy();
  expect(view.container.querySelectorAll('svg')).toHaveLength(2);
  expect(view.container.querySelector('img, button, a')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

// Tier 1: model-selected visuals must survive a streamed patch; invalid SVG
// content must never introduce executable/remote elements into the DOM.
it('renders model styling and vector geometry and applies a local visual patch', () => {
  const source =
    line(1, {
      op: 'create',
      id: 'title',
      kind: 'heading',
      props: { text: '自由排版', style: { color: 'secondary', fontSize: 32 } },
    }) +
    line(2, {
      op: 'create',
      id: 'custom',
      kind: 'svg',
      props: {
        label: '自绘图',
        viewBox: [0, 0, 400, 200],
        shapes: [
          { type: 'path', d: 'M 0 100 L 400 20', stroke: 'success', strokeWidth: 4 },
          { type: 'text', x: 10, y: 20, text: '模型标注' },
          { type: 'script', text: 'alert(1)' },
        ],
      },
    });
  const props = {
    stateKey: 'visual-controls',
    renderMarkdown: (text: string) => <span>{text}</span>,
  };
  const view = render(<RichAnswer {...props} source={source} complete={false} />);
  expect(screen.getByText('自由排版').style.fontSize).toBe('32px');
  expect(screen.getByLabelText('自绘图').querySelector('path')?.style.stroke).toBe(
    'var(--status-success)',
  );
  expect(screen.getByLabelText('自绘图').querySelector('script')).toBeNull();
  const updated =
    source +
    line(3, { op: 'patch', id: 'title', props: { style: { color: 'danger', fontSize: 24 } } });
  view.rerender(<RichAnswer {...props} source={updated} complete />);
  expect(screen.getByText('自由排版').style.fontSize).toBe('24px');
  expect(screen.getByText('自由排版').style.color).toBe('var(--error-fg)');
});

// Tier 1: real model output used a unitless line-height and stock data whose
// dates became a vertical list whenever point values did not fit. Earlier
// renderer tests only covered two points and did not exercise either failure.
it('preserves line-height units and keeps dense chart dates on the plot axis', () => {
  const source =
    line(1, {
      op: 'create',
      id: 'heading',
      kind: 'heading',
      style: { fontSize: 30, lineHeight: 1.25 },
      props: { text: '标题换行' },
    }) +
    line(2, {
      op: 'create',
      id: 'text',
      kind: 'text',
      props: { text: '两行正文', style: { fontSize: 20, lineHeight: 32 } },
    }) +
    line(3, {
      op: 'create',
      id: 'chart',
      kind: 'chart',
      props: {
        label: '价格',
        variant: 'line',
        showValues: false,
        data: Array.from({ length: 11 }, (_, i) => ({
          label: `10/${i + 2}`,
          value: 24000 + i * 30,
        })),
      },
    });
  const view = render(
    <RichAnswer
      source={source}
      complete
      stateKey="regression-layout"
      renderMarkdown={(text) => <span>{text}</span>}
    />,
  );
  expect(screen.getByText('标题换行').style.lineHeight).toBe('1.25');
  expect(screen.getByText('两行正文').style.lineHeight).toBe('32px');
  const svg = screen.getByRole('img');
  expect(svg.textContent).toContain('10/2');
  expect(view.container.querySelector('dl')).toBeNull();
  expect(svg.getAttribute('aria-label')).toContain('10/12: 24300');
  const y = [...svg.querySelectorAll('circle')].map((c) => Number(c.getAttribute('cy')));
  expect(Math.max(...y) - Math.min(...y)).toBeGreaterThan(100);
});

// Unit: the user saw a failed <video> for a YouTube page. Mount the production
// site preview; click-to-load, URL replacement and unmount must own the guest.
it('loads a site player on demand, retains its source link and disposes it on replacement', () => {
  const view = render(<VideoSitePreview src="https://youtube.com/watch?v=glW1pXWebnY" title="Tutorial" />);
  expect(view.container.querySelector('webview')).toBeNull();
  expect(screen.getByRole('link').getAttribute('href')).toBe('https://www.youtube.com/watch?v=glW1pXWebnY');
  fireEvent.click(screen.getByRole('button'));
  const guest = view.container.querySelector('webview')!;
  expect(guest.getAttribute('src')).toContain('youtube.com/embed/glW1pXWebnY');
  expect(view.container.querySelector('video')).toBeNull();
  // Opening a login page must not discard its player/opener when focus changes.
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  fireEvent(document, new Event('visibilitychange'));
  expect(guest.isConnected).toBe(true);
  vi.restoreAllMocks();
  view.rerender(<VideoSitePreview src="https://youtu.be/6b9FKpTeV28" title="Next" />);
  expect(guest.isConnected).toBe(false);
  expect(view.container.querySelector('webview')).toBeNull();
  fireEvent.click(screen.getByRole('button'));
  view.unmount();
  expect(document.querySelector('webview')).toBeNull();
});

// Unit: an answer designed on a desktop is also read on a phone, and colors belong to Cindy:
// wide fixed boxes stay in bounds and model backgrounds or literal colors are not painted.
it('bounds fixed widths and leaves backgrounds and literal colors to the host', () => {
  const source =
    line(1, { op: 'create', id: 'card', kind: 'stack', props: { style: { backgroundColor: '#14161b', width: 720, minWidth: 480 } } }) +
    line(2, { op: 'create', id: 'faint', kind: 'text', parent: 'card', props: { text: 'Faint', style: { color: { light: '#222', dark: '#222' } } } });
  render(<RichAnswer stateKey="bounds" source={source} complete renderMarkdown={(text) => <span>{text}</span>} />);
  const card = screen.getByText('Faint').parentElement!;
  expect(card.style.backgroundColor).toBe('');
  expect(card.style.maxWidth).toBe('100%');
  expect(card.style.minWidth).toBe('min(480px, 100%)');
  expect(screen.getByText('Faint').style.color).toBe('');
});


// Unit: production action renderer and normal-send boundary. Selection changes
// must stay local; the clicked, visible payload sends once, without running set.
it('submits visible edited values only on a click and survives remount', async () => {
  const { SessionQuickSendProvider } = await import('../SessionQuickSendContext');
  const { act, waitFor } = await import('@testing-library/react');
  let finish!: (accepted: boolean) => void;
  const send = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const source = [
    { id: 'choice', kind: 'input', props: { label: 'Destination', default: 'Park' } },
    { id: 'send', kind: 'button', props: { label: 'Plan trip', send: { op: 'concat', args: ['Plan: ', { ref: 'choice' }] }, set: { choice: 'WRONG' } } },
  ].map((op, i) => line(i + 1, { op: 'create', ...op })).join('');
  const props = { source, complete: true, stateKey: 'explicit-send', renderMarkdown: (text: string) => <span>{text}</span> };
  const element = <SessionQuickSendProvider value={{ send }}><RichAnswer {...props} /></SessionQuickSendProvider>;
  const view = render(element);
  fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'Museum' } });
  expect(screen.getByText('Plan: Museum')).toBeTruthy();
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Plan trip' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenCalledWith('Plan: Museum', { literalText: true, independent: true });
  view.unmount(); render(element);
  fireEvent.click(screen.getByRole('button', { name: 'richAnswer.sending' }));
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => { finish(true); });
  expect((screen.getByRole('button', { name: 'richAnswer.sent' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('Destination') as HTMLInputElement).value).toBe('Museum');
});

it('disables message actions outside a writable conversation while local buttons still work', () => {
  const source = [
    { id: 'form', kind: 'form', props: { label: 'Send form', send: 'My answer' } },
    { id: 'count', kind: 'stat', props: { value: { ref: 'counter' } } },
    { id: 'counter', kind: 'input', props: { default: '0' } },
    { id: 'local', kind: 'button', props: { label: 'Calculate', set: { counter: '1' } } },
  ].map((op, i) => line(i + 1, { op: 'create', ...op })).join('');
  render(<RichAnswer source={source} complete stateKey="readonly-send" renderMarkdown={text => <span>{text}</span>} />);
  expect((screen.getByRole('button', { name: 'Send form' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
  expect(screen.getByText('1')).toBeTruthy();
});
