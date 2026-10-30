/* Deterministic DOM/layout workload, not an artificial crash injection. */
(() => {
  const params = new URLSearchParams(location.search);
  let random = Number(params.get('seed')) >>> 0;
  const scenario = params.get('scenario');
  const items = document.getElementById('items');
  const viewport = document.getElementById('viewport');
  document.body.classList.toggle('no-containment', params.get('containment') === 'off');
  const stats = { frames: 0, mutations: 0, replacements: 0, scrolls: 0, layoutReads: 0 };
  window.ax5406Stats = stats;
  const next = () => {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    return random >>> 0;
  };
  const text = 'Synthetic alpha beta gamma 中文文本 한글 العربية 👩‍💻 ffi ABC 0123456789. ';
  function article(index) {
    const root = document.createElement('article');
    root.dataset.index = String(index);
    if (scenario === 'minimal') {
      root.innerHTML = `<p><span>${text.repeat(3)}</span><b>stable sibling</b><span>tail</span></p>`;
      return root;
    }
    root.innerHTML = `<p><span>${text.repeat(3)}</span><b>strong</b><span> tail</span></p>` +
      `<details open><summary>Tool ${index}</summary><pre><code>${text.repeat(2)}</code></pre></details>`;
    return root;
  }
  for (let i = 0; i < Number(params.get('rows') || 80); i++) items.append(article(i));
  function frame() {
    for (let k = 0; k < Number(params.get('batch') || 8); k++) {
      const index = next() % items.children.length;
      const root = items.children[index];
      const p = root.firstElementChild;
      if (scenario === 'minimal') {
        p.firstChild.textContent = text.repeat(1 + next() % 12);
        stats.mutations++;
        continue;
      }
      const variant = scenario === 'stream' ? 0 : scenario === 'detach' ? 1 :
        scenario === 'visibility' ? 2 : scenario === 'inline' ? 3 : next() % 6;
      switch (variant) {
        case 0:
          // Stream append, followed by a Markdown-style text -> inline-node replacement.
          p.firstChild.textContent = text.repeat(1 + next() % 12);
          if (params.get('rewrite') !== 'off' && next() % 4 === 0) p.innerHTML = `<span>${text}</span><em>${text}</em><code>${next()}</code>`;
          break;
        case 1:
          // Virtual-list row replacement and removal of inline LayoutObjects.
          if (next() % 2) { root.replaceWith(article(index)); stats.replacements++; }
          else { p.replaceChildren(document.createTextNode(text), document.createElement('br'), document.createTextNode(text)); }
          break;
        case 2:
          root.style.contentVisibility = ['auto', 'hidden', 'visible'][next() % 3];
          root.querySelector('details').open = !!(next() % 2);
          p.textContent = text.repeat(1 + next() % 10);
          break;
        case 3:
          p.className = ['ellipsis', 'clamp', 'first', ''][next() % 4];
          p.innerHTML = `<span style="display:${next() % 2 ? 'contents' : 'inline'}">${text}</span><ruby>漢<rt>kan</rt></ruby>${text}`;
          root.style.width = `${200 + next() % 650}px`;
          break;
        case 4:
          root.style.display = ['block', 'none', 'contents'][next() % 3];
          p.textContent = text.repeat(2);
          break;
        case 5:
          items.prepend(items.lastElementChild);
          root.querySelector('details').open = !root.querySelector('details').open;
          break;
      }
      stats.mutations++;
    }
    if (params.get('scroll') !== 'off' && stats.frames % 3 === 0) {
      viewport.scrollTop = (next() % 101) / 100 * viewport.scrollHeight;
      stats.scrolls++;
    }
    // Deliberately interleave layout reads with mutations; no Chromium internals/forced crash.
    if (stats.frames % 2 === 0) {
      items.children[next() % items.children.length].getBoundingClientRect();
      stats.layoutReads++;
    }
    stats.frames++;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
