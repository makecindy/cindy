// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MailHtmlPreview, safeMailHtml } from '../MailHtmlPreview';
import { GhostCardForm } from '../GhostCardForm';
import { ChatSessionFileProvider } from '../ChatSessionFileContext';
import { openUrlInSidebarBrowser } from '@/features/right-sidebar/lib/openInSidebarBrowser';
import { _resetLinkOpenPreferenceForTests } from '@/hooks/useLinkOpenPreference';
import { mailInlineBindingScript, mailInlineRefreshScript, mailReadingColor, mailReadingThemeScript } from '@cindy/maker-shared/mail-text-edit';
import { mailBodySerializer } from '../mailBodyEditing';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../ImageLightbox', () => ({ ImageLightbox: ({ src }: { src: string }) => <img alt="attachment-preview" src={src} /> }));
vi.mock('@/features/right-sidebar/lib/openInSidebarBrowser', () => ({ openUrlInSidebarBrowser: vi.fn(async () => undefined) }));
vi.mock('@/features/right-sidebar/lib/mailPreview', () => ({ readMailPreview: vi.fn(async () => ({ supported: false })) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); localStorage.clear(); _resetLinkOpenPreferenceForTests(); });

// Unit regressions: the reader previously had no opt-in and swallowed all links.
// Exercise the actual iframe event listeners and shared chat navigation policy.
it('loads external images only after a click and resets consent when changing mail', () => {
  const first = '<p>First</p><img src="https://images.example.test/first.png">';
  const second = '<p>Second</p><img src="https://images.example.test/second.png">';
  const view = render(<MailHtmlPreview value={first} reading />);
  const load = () => {
    const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    doc.open(); doc.write(frame.srcdoc); doc.close(); fireEvent.load(frame);
    return { frame, doc };
  };
  const blocked = load();
  expect(blocked.doc.querySelector('img')!.hasAttribute('src')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'mailReader.showExternalImages' }));
  const allowed = load();
  expect(allowed.frame).not.toBe(blocked.frame);
  expect(allowed.frame.getAttribute('sandbox')).toBe('allow-same-origin');
  expect(allowed.doc.querySelector('img')!.getAttribute('src')).toBe('https://images.example.test/first.png');
  expect(allowed.doc.querySelector('img')!.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(screen.queryByRole('button', { name: 'mailReader.showExternalImages' })).toBeNull();
  view.rerender(<MailHtmlPreview value={second} reading />);
  expect(load().doc.querySelector('img')!.hasAttribute('src')).toBe(false);
  view.rerender(<MailHtmlPreview value={first} reading />);
  expect(screen.getByRole('button', { name: 'mailReader.showExternalImages' })).toBeTruthy();
  view.rerender(<MailHtmlPreview value='<img src="data:image/png;base64,YQ==">' reading />);
  expect(screen.queryByRole('button', { name: 'mailReader.showExternalImages' })).toBeNull();
  view.rerender(<MailHtmlPreview value={first} onChange={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'mailReader.showExternalImages' })).toBeNull();
});

it('opens reader links with chat preferences and modifiers but never navigates the iframe or editor', async () => {
  const openExternal = vi.fn(async () => ({ success: true }));
  vi.stubGlobal('electronAPI', { openExternal });
  localStorage.setItem('chat.webLinkOpenPreference', 'sidebar');
  _resetLinkOpenPreferenceForTests();
  const value = '<a href="https://example.test/page"><b>Open</b></a><a href="javascript:alert(1)">Unsafe</a><a href="mailto:person@example.test">Email</a>';
  const view = render(<ChatSessionFileProvider value={{ sessionId: 'mail-task', workingDir: '', origin: { kind: 'local' } }}>
    <MailHtmlPreview value={value} reading />
  </ChatSessionFileProvider>);
  const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
  const doc = frame.contentDocument!;
  doc.open(); doc.write(frame.srcdoc); doc.close(); fireEvent.load(frame);
  const click = (type: string, init: MouseEventInit = {}) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    doc.querySelector('b')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  };
  await act(async () => { click('click'); });
  expect(openUrlInSidebarBrowser).toHaveBeenCalledWith('mail-task', 'https://example.test/page');
  expect(openExternal).not.toHaveBeenCalled();
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
    await act(async () => { click('click', modifiers); });
  }
  await act(async () => { click('auxclick', { button: 1 }); });
  expect(openExternal).toHaveBeenCalledTimes(4);
  expect(openExternal).toHaveBeenLastCalledWith('https://example.test/page');
  expect(doc.querySelectorAll('a')[1].hasAttribute('href')).toBe(false);
  await act(async () => { fireEvent.click(doc.querySelectorAll('a')[1]); });
  expect(openExternal).toHaveBeenCalledTimes(4);
  for (const preference of ['sidebar', 'external']) {
    localStorage.setItem('chat.webLinkOpenPreference', preference);
    _resetLinkOpenPreferenceForTests();
    await act(async () => {
      fireEvent.click(doc.querySelectorAll('a')[2]);
      doc.querySelectorAll('a')[2].dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    });
  }
  expect(openExternal).toHaveBeenCalledTimes(4);
  expect(openUrlInSidebarBrowser).toHaveBeenCalledTimes(1);
  view.rerender(<ChatSessionFileProvider value={{ sessionId: 'mail-task', workingDir: '', origin: { kind: 'local' } }}>
    <MailHtmlPreview value={value} reading onChange={vi.fn()} />
  </ChatSessionFileProvider>);
  await act(async () => { click('click'); });
  expect(openUrlInSidebarBrowser).toHaveBeenCalledTimes(1);
});

// Reader links must remain visibly clickable despite sender CSS; preview paint
// must also leave authored styles intact when this frame becomes an editor.
// Unit regression for #7062: inert mailto/credential targets must not expose
// keyboard/AT links; prior tests checked only paint and swallowed clicks.
it('keeps link affordances and authored colors in both themes and restores source styles for editing', async () => {
  const root = document.documentElement, originalClass = root.className, originalStyle = root.getAttribute('style');
  const value = '<style>a{text-decoration:none!important}</style><p><a style="text-decoration:none!important;color:red" href="https://example.test/page">Web</a><a style="text-decoration:underline!important" href="mailto:person@example.test">Email</a><a role="link" href="https://user:pass@example.test">Credentials</a></p>';
  const change = vi.fn();
  try {
    root.classList.remove('dark');
    root.style.setProperty('--surface', '#181818');
    root.style.setProperty('--text-primary', '#eeeeee');
    const view = render(<MailHtmlPreview value={value} reading />);
    const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement, doc = frame.contentDocument!;
    doc.open(); doc.write(frame.srcdoc); doc.close(); fireEvent.load(frame);
    for (const dark of [false, true, false]) {
      await act(async () => { root.classList.toggle('dark', dark); });
      const [web, email] = [...doc.querySelectorAll('a')];
      expect(web.style.textDecoration).toBe('underline');
      expect(web.style.getPropertyPriority('text-decoration')).toBe('important');
      if (dark) expect(web.style.color).not.toBe('red');
      else expect(web.style.color).toBe('red');
      expect(web.querySelector('[data-cindy-mail-run]')).toBeNull();
      expect(web.style.cursor).toBe('pointer');
      expect(email.style.textDecoration).toBe('none');
      expect(email.style.cursor).toBe('text');
      expect(email.hasAttribute('href')).toBe(false);
      expect(within(doc.body).getAllByRole('link')).toEqual([web]);
    }
    const targets = (html: string) => [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a')]
      .map(link => [link.getAttribute('href'), link.getAttribute('role')]);
    const originalTargets = targets(value);
    // Serialization restores a clone without reactivating the live reader.
    expect(targets(mailBodySerializer(doc, value)()!.html)).toEqual(originalTargets);
    expect(within(doc.body).getAllByRole('link')).toHaveLength(1);
    view.rerender(<MailHtmlPreview value={value} reading onChange={change} />);
    expect([...doc.querySelectorAll('a')].map(link => [link.getAttribute('href'), link.getAttribute('role')])).toEqual(originalTargets);
    expect(doc.querySelector('a')!.style.textDecoration).toBe('none');
    expect(doc.querySelector('a')!.style.color).toBe('red');
    fireEvent.input(doc.querySelector('p')!);
    const saved = change.mock.calls.at(-1)![0];
    const link = new DOMParser().parseFromString(saved, 'text/html').querySelector('a')!;
    expect(link.style.textDecoration).toBe('none');
    expect(link.style.color).toBe('red');
    expect(saved).not.toContain('cursor: pointer');
    expect(targets(saved)).toEqual(originalTargets);
    expect(saved).not.toContain('data-cindy-mail-authored-style');
    view.rerender(<MailHtmlPreview value={value} reading />);
    expect(within(doc.body).getAllByRole('link')).toHaveLength(1);
  } finally {
    cleanup(); root.className = originalClass;
    if (originalStyle === null) root.removeAttribute('style'); else root.setAttribute('style', originalStyle);
  }
});
// Chromium can expose a document before the srcdoc parser creates its body.
// Account/CID updates during that interval must wait for load, then apply the
// latest source without crashing the whole conversation reader.
it('waits for the iframe body before refreshing and uses updates received during loading', () => {
  const pendingDoc = document.implementation.createHTMLDocument('');
  pendingDoc.body.remove();
  const content = vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockReturnValue(pendingDoc);
  try {
    const change = vi.fn();
    const view = render(<MailHtmlPreview value="<p>Original</p>" reading />);
    const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
    view.rerender(<MailHtmlPreview value="<p>Latest</p>" reading onChange={change} />);
    fireEvent.load(frame); // An incomplete document must stay hidden.
    expect(frame.style.visibility).toBe('hidden');
    pendingDoc.open(); pendingDoc.write(frame.srcdoc); pendingDoc.close();
    fireEvent.load(frame);
    expect(frame.style.visibility).toBe('visible');
    expect(pendingDoc.body.textContent).toBe('Latest');
    expect(pendingDoc.body.contentEditable).toBe('true');
    expect(change).not.toHaveBeenCalled();
    view.unmount();
  } finally { content.mockRestore(); }
});
// Opening a draft in the sidebar must not create a second modal editor or save it.
it('routes both HTML and plain-text enlargement to the shared mail panel', () => {
  const enlarge = vi.fn(), change = vi.fn();
  const view = render(<GhostCardForm fields={[{ name: 'bodyHtml', label: 'Body', kind: 'mail-html', value: '<p>Hello</p>' }]}
    disabled={false} onChange={change} onEnlarge={enlarge} />);
  fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.mailEnlarge' }));
  expect(enlarge).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<GhostCardForm fields={[{ name: 'body', label: 'Body', multiline: true, value: 'Hello' }]}
    disabled={false} onChange={change} onEnlarge={enlarge} />);
  fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.mailEnlarge' }));
  expect(enlarge).toHaveBeenCalledTimes(2);
  expect(change).not.toHaveBeenCalled();
  view.rerender(<GhostCardForm fields={[{ name: 'body', label: 'Body', multiline: true, value: 'Hello' }]}
    disabled={false} onChange={change} onEnlarge={enlarge} expanded />);
  expect(screen.queryByRole('button', { name: 'chat.ghostCall.mailEnlarge' })).toBeNull();
});
// The sidebar previously inherited the compose card's 440px cap and left most
// of the reader empty. Body/font reflow and root margins were not covered by
// the image-load test, leaving a second scrolling viewport (unit regression).
it('lets the reader grow with long mail and late images while keeping chat cards compact', () => {
  const observers = new Map<Element, ResizeObserverCallback>();
  vi.stubGlobal('ResizeObserver', class {
    targets: Element[] = [];
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.targets.push(target); observers.set(target, this.callback); }
    disconnect() { this.targets.forEach(target => observers.delete(target)); }
  });
  const view = render(<MailHtmlPreview value="<p>Long mail</p>" reading />);
  const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
  const doc = frame.contentDocument!;
  doc.open(); doc.write(frame.srcdoc); doc.close();
  let height = 1500;
  Object.defineProperty(doc.body, 'scrollHeight', { get: () => height });
  Object.defineProperty(doc.documentElement, 'scrollHeight', { get: () => height + 40 });
  fireEvent.load(frame);
  expect(parseInt(frame.style.height)).toBeGreaterThanOrEqual(height + 40);
  height = 2000;
  doc.dispatchEvent(new Event('load'));
  expect(parseInt(frame.style.height)).toBeGreaterThanOrEqual(height + 40);
  height = 2400; // Fonts/reflow do not dispatch an image load event.
  observers.get(doc.body)!([], {} as ResizeObserver);
  expect(parseInt(frame.style.height)).toBeGreaterThanOrEqual(height + 40);
  height = 900;
  observers.get(doc.body)!([], {} as ResizeObserver);
  expect(parseInt(frame.style.height)).toBeLessThan(1000);
  view.unmount();
  expect(observers.has(doc.body)).toBe(false);
  render(<MailHtmlPreview value="<p>Long mail</p>" />);
  const card = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
  Object.defineProperty(card.contentDocument!.body, 'scrollHeight', { value: height });
  fireEvent.load(card);
  expect(parseInt(card.style.height)).toBeLessThan(height);
});
// EasyVote regression: dim the colored paper without crushing its hue, keeping
// text structure and original image pixels intact across host theme changes.
it('adapts the reading palette without changing text structure or accumulating dimming', async () => {
  const root = document.documentElement, oldClass = root.className, oldStyle = root.getAttribute('style');
  try {
    root.classList.add('dark');
    root.style.setProperty('--surface', '#181818');
    root.style.setProperty('--text-primary', '#eeeeee');
    const source = '<body style="background:#f99a3c;color:black"><div style="background:white;border:5px solid white"><p style="margin:0;line-height:28px">\n    Alex\n  </p></div><section style="background:linear-gradient(#fff,#eee);color:#000">Gradient</section><img src="cid:logo"></body>';
    const view = render(<MailHtmlPreview value={source} reading />);
    const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement, doc = frame.contentDocument!;
    doc.open(); doc.write(frame.srcdoc); doc.close(); fireEvent.load(frame);
    const paragraph = doc.querySelector('p');
    for (const dark of [true, false, true]) {
      await act(async () => { root.classList.toggle('dark', dark); });
      expect(doc.body.style.backgroundColor).toBe(dark ? 'rgb(129, 71, 14)' : 'rgb(249, 154, 60)');
      expect(doc.body.style.color).toBe(dark ? 'rgb(238, 238, 238)' : 'black');
      expect(doc.querySelector('div')!.style.backgroundColor).toBe(dark ? 'rgb(24, 24, 24)' : 'white');
      expect(doc.querySelector('div')!.style.borderTopColor).toBe(dark ? 'rgb(24, 24, 24)' : 'white');
      expect(doc.querySelector('img')!.getAttribute('style')).toBeNull();
      // jsdom miscomputes !important longhands beside background shorthand;
      // the Electron fixture separately checks the real computed background.
      expect(doc.querySelector('section')!.style.backgroundImage).toBe(dark ? 'none' : 'linear-gradient(rgb(255, 255, 255), rgb(238, 238, 238))');
      expect(doc.querySelector('[data-cindy-mail-run]')).toBeNull();
      expect(doc.querySelector('p')).toBe(paragraph);
      expect(doc.body.contentEditable).toBe('false');
    }
    view.rerender(<MailHtmlPreview value={source.replace('Alex', 'Sam')} reading />);
    expect(frame.contentDocument).toBe(doc);
    expect(doc.querySelector('p')!.textContent).toBe('\n    Sam\n  ');
    expect(doc.body.style.backgroundColor).toBe('rgb(129, 71, 14)');
  } finally {
    cleanup(); root.className = oldClass;
    if (oldStyle === null) root.removeAttribute('style'); else root.setAttribute('style', oldStyle);
  }
});
it('uses the same reading palette in native injection and restores the original on light mode', () => {
  const frame = document.createElement('iframe'); document.body.append(frame);
  try {
    const doc = frame.contentDocument!;
    doc.body.innerHTML = '<p style="background:rgb(249,154,60);color:black;border:5px solid white">Ticket</p><section style="background:linear-gradient(#fff,#eee);color:#000">Gradient</section><img src="data:image/png;base64,YQ==">';
    const original = doc.body.innerHTML;
    const palette = { surface: '#181818', text: '#eeeeee' };
    const apply = (dark: boolean) => new Function('document', 'getComputedStyle', mailReadingThemeScript(dark, palette))(doc, doc.defaultView!.getComputedStyle.bind(doc.defaultView));
    apply(true);
    const painted = doc.body.innerHTML;
    expect(doc.querySelector('p')!.style.backgroundColor).toBe('rgb(129, 71, 14)');
    expect(mailReadingColor('rgb(249, 154, 60)', 'background', palette)).toBe('rgba(129, 71, 14, 1)');
    expect(doc.querySelector('p')!.style.color).toBe('rgb(238, 238, 238)');
    expect(doc.querySelector('img')!.getAttribute('style')).toBeNull();
    expect(doc.querySelector('section')!.style.backgroundImage).toBe('none');
    apply(true);
    expect(doc.body.innerHTML).toBe(painted);
    apply(false);
    expect(doc.body.innerHTML).toBe(original);
    // The native literal must match the desktop function even in Hermes builds,
    // where serializing the function itself would only return a bytecode stub.
    for (const color of ['rgb(250, 250, 250)', 'rgb(24, 24, 24)', 'rgb(0, 140, 255)', 'rgb(250, 50, 150)', 'rgb(30, 180, 80)', 'rgba(100, 180, 220, 0.5)', 'rgba(0, 0, 0, 0)']) {
      doc.body.innerHTML = `<p style="background-color:${color};color:${color}">Color</p>`;
      const expected = doc.createElement('p');
      expected.style.backgroundColor = mailReadingColor(color, 'background', palette);
      expected.style.color = mailReadingColor(color, 'text', palette);
      apply(true);
      expect(doc.querySelector('p')!.style.backgroundColor).toBe(expected.style.backgroundColor);
      expect(doc.querySelector('p')!.style.color).toBe(expected.style.color);
      apply(false);
    }
  } finally { frame.remove(); }
});
// Dark neutral backgrounds merge into the composing surface. Light mode keeps
// authored white paper intact so signature images/tables don't acquire seams.
// Theme changes must never reload the preview or save a draft (unit regression).
it('adapts authored mail colors to the app theme and restores them without changing content', async () => {
  const change = vi.fn();
  const original = '<body style="background-color: rgb(240, 235, 220); color: rgb(25, 60, 50)"><div style="background:white;color:black"><p>Hello</p></div><img src="cid:photo"></body>';
  const root = document.documentElement;
  const oldClass = root.className, oldStyle = root.getAttribute('style');
  try {
    root.classList.remove('dark');
    root.style.setProperty('--surface', '#f2f2ee');
    root.style.setProperty('--text-primary', '#262626');
    root.style.setProperty('--border-default', '#444444');
    render(<MailHtmlPreview value={original} onChange={change} />);
    const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
    const source = frame.srcdoc, doc = frame.contentDocument!;
    doc.open(); doc.write(source); doc.close(); fireEvent.load(frame);
    const paragraph = doc.querySelector('p'), image = doc.querySelector('img');
    const authored = doc.body.getAttribute('style');
    const neutral = doc.querySelector('div')!;
    expect(neutral.getAttribute('style')).toBe('background:white;color:black');
    expect(neutral.style.color).toBe('black');
    await act(async () => {
      root.classList.add('dark');
      root.style.setProperty('--surface', '#181818');
      root.style.setProperty('--text-primary', '#eeeeee');
    });
    expect(doc.body.style.backgroundColor).not.toBe('rgb(240, 235, 220)');
    expect(doc.body.style.color).not.toBe('rgb(25, 60, 50)');
    expect(neutral.style.backgroundColor).toBe('rgb(24, 24, 24)');
    expect(neutral.style.color).toBe('rgb(238, 238, 238)');
    expect(doc.body.style.backgroundColor).not.toBe(neutral.style.backgroundColor);
    expect(image?.getAttribute('style')).toBeNull();
    expect(frame.srcdoc).toBe(source);
    expect(doc.querySelector('p')).toBe(paragraph);
    await act(async () => {
      root.classList.remove('dark');
      root.style.setProperty('--surface', '#f2f2ee');
      root.style.setProperty('--text-primary', '#262626');
    });
    expect(doc.body.getAttribute('style')).toBe(authored);
    expect(neutral.getAttribute('style')).toBe('background:white;color:black');
    expect(neutral.style.color).toBe('black');
    expect(image?.getAttribute('style')).toBeNull();
    expect(frame.srcdoc).toBe(source);
    cleanup();
    expect(neutral.getAttribute('style')).toBe('background:white;color:black');
    expect(change).not.toHaveBeenCalled();
  } finally {
    root.className = oldClass;
    if (oldStyle === null) root.removeAttribute('style'); else root.setAttribute('style', oldStyle);
  }
});
// Unit regression for #6878 review r4355813972: native paragraph/inline splits
// clone preview paint after the serializer's initial snapshot. Existing theme
// tests only edited text in pre-existing nodes. Saving and theme cleanup must
// both preserve authored styles on these new nodes without reloading the frame.
it('restores authored paint on cloned paragraphs and inline nodes before saving and when changing theme', async () => {
  const root = document.documentElement, oldClass = root.className, oldStyle = root.getAttribute('style');
  try {
    root.classList.add('dark');
    root.style.setProperty('--surface', '#181818');
    root.style.setProperty('--text-primary', '#eeeeee');
    const change = vi.fn();
    render(<MailHtmlPreview value='<p style="background:white;color:black"><strong style="color:#123456">Original</strong></p>' onChange={change} />);
    const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement, doc = frame.contentDocument!;
    doc.open(); doc.write(frame.srcdoc); doc.close(); fireEvent.load(frame);
    const paragraph = doc.querySelector('p')!.cloneNode(true) as HTMLElement;
    doc.body.append(paragraph);
    paragraph.querySelector('strong')!.textContent = 'New paragraph';
    fireEvent.input(paragraph);
    const saved = change.mock.calls.at(-1)![0];
    const parsed = new DOMParser().parseFromString(saved, 'text/html');
    const next = parsed.querySelectorAll('p')[1];
    expect(next.style.backgroundColor).toBe('white');
    expect(next.style.color).toBe('black');
    expect(next.querySelector('strong')!.style.color).toBe('rgb(18, 52, 86)');
    expect(saved).not.toMatch(/color-mix|data-cindy|!important/);
    await act(async () => { root.classList.remove('dark'); });
    expect(paragraph.style.backgroundColor).toBe('white');
    expect(paragraph.style.color).toBe('black');
    expect(paragraph.querySelector('strong')!.style.color).toBe('rgb(18, 52, 86)');
    await act(async () => { root.classList.add('dark'); });
    fireEvent.input(paragraph);
    expect(change.mock.calls.at(-1)![0]).toBe(saved);
    expect(frame.contentDocument).toBe(doc);
  } finally {
    cleanup(); root.className = oldClass;
    if (oldStyle === null) root.removeAttribute('style'); else root.setAttribute('style', oldStyle);
  }
});
// Initial paint is hidden until themed; updates from the other editor must
// change the existing document before paint, without a blank loading frame.
it('themes the first load and updates other-view content without reloading or hiding', () => {
  const root = document.documentElement;
  const oldClass = root.className, oldStyle = root.getAttribute('style');
  const change = vi.fn();
  try {
    root.classList.add('dark');
    root.style.setProperty('--surface', '#181818');
    root.style.setProperty('--text-primary', '#eeeeee');
    const view = render(<MailHtmlPreview value='<body style="background:white;color:black"><p>Hello</p></body>' reading onChange={change} />);
    const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
    const load = () => {
      const doc = frame.contentDocument!;
      doc.open(); doc.write(frame.srcdoc); doc.close(); fireEvent.load(frame);
      expect(doc.documentElement.style.colorScheme).toBe('dark');
      expect(doc.body.style.backgroundColor).not.toBe('white');
      expect(frame.style.visibility).toBe('visible');
      expect(frame.getAttribute('aria-busy')).toBe('false');
    };
    expect(frame.style.visibility).toBe('hidden');
    load();
    const run = frame.contentDocument!.querySelector<HTMLElement>('[data-cindy-mail-run]')!;
    run.textContent = 'Edited'; fireEvent.input(run);
    view.rerender(<MailHtmlPreview value={change.mock.calls.at(-1)![0]} reading onChange={change} />);
    expect(frame.style.visibility).toBe('visible');
    expect(frame.contentDocument!.querySelector('[data-cindy-mail-run]')).toBe(run);
    const doc = frame.contentDocument;
    const src = frame.srcdoc;
    view.rerender(<MailHtmlPreview value='<body style="background:white;color:black"><p>AI update</p></body>' reading onChange={change} />);
    expect(screen.getByTitle('chat.ghostCall.mailPreview')).toBe(frame);
    expect(frame.contentDocument).toBe(doc);
    expect(frame.srcdoc).toBe(src);
    expect(frame.style.visibility).toBe('visible');
    expect(frame.getAttribute('aria-busy')).toBe('false');
    expect(doc!.body.textContent).toBe('AI update');
    expect(doc!.body.style.backgroundColor).not.toBe('white');
    expect(change).toHaveBeenCalledTimes(1);
    const updated = doc!.querySelector('p')!;
    updated.textContent = 'Edited again'; fireEvent.input(updated);
    expect(change.mock.calls.at(-1)![0]).toContain('Edited again');
    expect(change.mock.calls.at(-1)![0]).not.toContain('color-mix');
  } finally {
    root.className = oldClass;
    if (oldStyle === null) root.removeAttribute('style'); else root.setAttribute('style', oldStyle);
  }
});
it('inserts an existing image part into the HTML and hides its duplicate attachment tile', () => {
  const change = vi.fn(), url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
  render(<GhostCardForm disabled={false} onChange={change} fields={[
    { name: 'bodyHtml', label: 'Body', kind: 'mail-html', value: '<html><body><p>Hello</p></body></html>' },
    { name: 'attachmentItems', label: 'Files', kind: 'mail-attachments', value: JSON.stringify([{ key: 'part', filename: 'card.png', mimeType: 'image/png', previewUrl: url }]) },
  ]} />);
  fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.mailInsertImage' }));
  const values = change.mock.calls.at(-1)![0];
  expect(values.bodyHtml).toContain('src="cid:image-1@cindy.local"');
  expect(values.bodyHtml).not.toContain('cindy-media:');
  expect(values.bodyHtml).toMatch(/<\/p><\/body><\/html>$/);
  expect(JSON.parse(values.attachmentItems)).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'chat.ghostCall.mailInsertImage' })).toBeNull();
  const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
  const doc = frame.contentDocument!;
  doc.open(); doc.write(frame.srcdoc); doc.close(); fireEvent.load(frame);
  expect(doc.querySelector('img')?.getAttribute('src')).toBe(url);
  expect(screen.queryByRole('button', { name: 'chat.ghostCall.mailRemoveAttachment' })).toBeNull();
  expect(JSON.parse(values.attachmentItems)[0].contentId).toBe('image-1@cindy.local');
});
it('keeps formatting and tables but removes executable content and unsafe URLs', () => {
  const safe = safeMailHtml('<p onclick="evil()" style="color:red;background-image:url(https://example.test/track)"><b>Hello</b></p><table><tr><td>Cell</td></tr></table><script>evil()</script><iframe src=x></iframe><a href="javascript:evil()">Link</a><img src="file:///private" onerror="evil()">');
  expect(safe).toContain('<b>Hello</b>'); expect(safe).toContain('<td>Cell</td>');
  expect(safe).not.toMatch(/evil|javascript|file:|url\(|onclick|onerror|iframe/);
});
// Opening preview alone never mutates the draft. Typing happens in the rendered
// text itself; author scripts remain blocked (unit regression).
it('enlarges the read-only preview and reflects later AI updates without changing the draft', () => {
  const fields = [{ name: 'bodyHtml', label: 'Body', kind: 'mail-html' as const, value: '<p>Original</p>' }];
  const change = vi.fn();
  const { rerender } = render(<GhostCardForm fields={fields} disabled={false} onChange={change} />);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('toolbar')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.mailEnlarge' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getAllByTitle('chat.ghostCall.mailPreview')).toHaveLength(2);
  const frames = screen.getAllByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement[];
  for (const frame of frames) {
    const doc = frame.contentDocument!;
    doc.open(); doc.write(frame.srcdoc); doc.close(); fireEvent.load(frame);
  }
  rerender(<GhostCardForm fields={[{ ...fields[0], value: '<p>AI updated</p>' }]} disabled={false} onChange={change} />);
  expect(screen.getAllByTitle('chat.ghostCall.mailPreview')).toEqual(frames);
  expect(frames.every(frame => frame.contentDocument!.body.textContent === 'AI updated')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'chat.lightbox.close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(change).not.toHaveBeenCalled();
});
it('autosaves simple HTML text edits and the plain alternative, keeps the caret through echoes and locks sent mail', () => {
  const original = '<style>p{color:red}</style><p>Hello <b>Cherry</b></p><img src="cid:card">';
  const fields = [
    { name: 'bodyHtml', label: 'Body', kind: 'mail-html' as const, value: original },
    { name: 'body', label: 'Plain', kind: 'hidden' as const, value: 'Hello Cherry' },
  ];
  const change = vi.fn();
  const { rerender } = render(<GhostCardForm fields={fields} disabled={false} onChange={change} />);
  const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
  const src = frame.srcdoc;
  const doc = frame.contentDocument!;
  doc.open(); doc.write(src); doc.close(); fireEvent.load(frame);
  const input = doc.querySelector<HTMLElement>('[data-cindy-mail-run="0"]')!;
  expect(doc.body.contentEditable).toBe('true');
  expect(input.hasAttribute('contenteditable')).toBe(false);
  fireEvent.compositionStart(input);
  input.textContent = '你好\n'; fireEvent.input(input);
  expect(change).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  const saved = change.mock.calls.at(-1)![0];
  expect(saved.body).toBe('你好\nCherry');
  expect(saved.bodyHtml).toContain('<p>你好<br><b>Cherry</b></p>');
  expect(saved.bodyHtml).toContain('<style>p{color:red}</style>');
  expect(saved.bodyHtml).toContain('src="cid:card"');
  expect(saved.bodyHtml).not.toContain('cindy-media:');
  rerender(<GhostCardForm fields={fields.map(f => ({ ...f, value: saved[f.name] }))} disabled={false} onChange={change} />);
  expect(frame.srcdoc).toBe(src);
  expect(doc.querySelector('[data-cindy-mail-run="0"]')).toBe(input);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('toolbar')).toBeNull();
  rerender(<GhostCardForm fields={fields.map(f => ({ ...f, value: saved[f.name] }))} disabled readOnly onChange={change} />);
  expect(doc.body.contentEditable).toBe('false');
  const count = change.mock.calls.length;
  input.textContent = 'Should not save'; fireEvent.input(input);
  expect(change).toHaveBeenCalledTimes(count);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'chat.ghostCall.mailEditText' })).toBeNull();
});
// Unit: CodeQL #409 exposed DOM marker -> image source restoration. Existing
// save tests only covered unresolved CID images, not Host-backed preview URLs.
it('restores only Host-backed CID references when serializing an edited body', () => {
  const change = vi.fn(), url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
  render(<MailHtmlPreview value={'<p>Body</p><img src="cid:real@example.test">'} images={[{ cid: 'real@example.test', url }]} onChange={change} />);
  const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement, doc = frame.contentDocument!;
  doc.open(); doc.write(frame.srcdoc); doc.close(); fireEvent.load(frame);
  const paragraph = doc.querySelector('p')!, image = doc.querySelector('img')!;
  expect(image.getAttribute('src')).toBe(url);
  fireEvent.input(paragraph);
  expect(change.mock.calls.at(-1)![0]).toContain('src="cid:real@example.test"');
  expect(change.mock.calls.at(-1)![0]).not.toContain('cindy-media:');
  image.setAttribute('data-cindy-mail-cid', 'forged-reference');
  fireEvent.input(paragraph);
  const saved = change.mock.calls.at(-1)![0];
  expect(saved).not.toContain('forged-reference');
  expect(saved).not.toContain('cindy-media:');
});
it('native WebView binding emits only composed plain text and respects the read-only switch', () => {
  const doc = document.implementation.createHTMLDocument('mail');
  doc.body.innerHTML = '<p><span data-cindy-mail-run="0">Hello</span></p>';
  const postMessage = vi.fn();
  new Function('document', 'window', mailInlineBindingScript(7))(doc, { ReactNativeWebView: { postMessage } });
  new Function('document', mailInlineRefreshScript(true, []))(doc);
  const text = doc.querySelector('span')!;
  text.dispatchEvent(new Event('compositionstart', { bubbles: true })); text.textContent = '你好'; text.dispatchEvent(new Event('input', { bubbles: true }));
  expect(postMessage).not.toHaveBeenCalled();
  text.dispatchEvent(new Event('compositionend', { bubbles: true }));
  expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({ type: 'mail-text', documentId: 7, id: '0', text: '你好' });
  new Function('document', mailInlineRefreshScript(false, []))(doc);
  text.dispatchEvent(new Event('input', { bubbles: true }));
  expect(postMessage).toHaveBeenCalledTimes(1);
});
it('keeps the attachment gesture outside the preview and hides it for sent mail', () => {
  const attach = vi.fn(), fields = [{ name: 'attachmentItems', label: 'Files', kind: 'mail-attachments' as const, value: '[]' }];
  const { rerender } = render(<GhostCardForm fields={fields} disabled={false} onChange={() => {}} onAttach={attach} />);
  fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.mailAttach' }));
  expect(attach).toHaveBeenLastCalledWith(false);
  rerender(<GhostCardForm fields={fields} disabled readOnly onChange={() => {}} onAttach={attach} />);
  expect(screen.queryByRole('button', { name: 'chat.ghostCall.mailAttach' })).toBeNull();
});
it('retains a CID image without duplicate attachment controls or hidden metadata', () => {
  const change = vi.fn();
  render(<GhostCardForm fields={[
    { name: 'body', label: 'Plain', value: 'Body', kind: 'hidden' },
    { name: 'bodyHtml', label: 'Body', value: '<p>Body</p><img src="cid:image@example.test">', kind: 'mail-html' },
    { name: 'attachmentItems', label: 'Files', kind: 'mail-attachments', value: JSON.stringify([{ key: 'part', filename: 'photo.png', contentId: '<image@example.test>' }]) },
  ]} disabled={false} onChange={change} />);
  expect(screen.queryByLabelText('Plain')).toBeNull();
  expect(screen.queryByRole('button', { name: 'chat.ghostCall.mailRemoveAttachment' })).toBeNull();
  expect(change).not.toHaveBeenCalled();
});
// Regression: full HTML cards lost head CSS/body background and class selectors.
it('preserves the authored document and opens an image attachment without editing it', () => {
  const html = '<html><head><style>.card{border-radius:12px;background:linear-gradient(white,pink)}@media(max-width:400px){.card{padding:8px}}</style></head><body style="background-color: ivory"><div class="card">Card</div></body></html>';
  const safe = safeMailHtml(html);
  expect(safe).toContain('.card{border-radius:12px');
  expect(safe).toContain('class="card"');
  expect(safe).toContain('background-color: ivory');
  const url = `cindy-media://blobs/${'a'.repeat(64)}.png`, change = vi.fn();
  render(<GhostCardForm disabled={false} onChange={change} fields={[
    { name: 'attachmentItems', label: 'Files', kind: 'mail-attachments', value: JSON.stringify([{ key: 'part', filename: 'card.png', mimeType: 'image/png', bytes: 1024, previewUrl: url }]) },
  ]} />);
  fireEvent.click(screen.getByRole('button', { name: /card.png/ }));
  expect(screen.getByAltText('attachment-preview').getAttribute('src')).toBe(url);
  expect(change).not.toHaveBeenCalled();
});
