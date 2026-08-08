import { redactSensitiveText } from "@cindy/maker-shared/error-redaction";
import { buildKatexLoaderJs } from "@/session/mathWebViewHtml";
import { MOBILE_MERMAID_SCRIPT_URLS } from "@/session/mermaidWebViewHtml";
import {
  buildSelectableMarkdownCss,
  buildSelectableMarkdownFragmentHtml,
  type SelectableMarkdownHtmlOptions,
} from "@/session/selectableMarkdownHtml";
import { buildMessageContentLayout } from "@/session/messageContentLayout";
import { lineHeight, typeScale } from "@/theme/tokens";

export interface ConversationShareMessage {
  clientId: string;
  kind: "user" | "assistant";
  body: string;
  secondaryBody?: string;
}

export interface ConversationShareWebViewColors {
  background: string;
  surfaceElevated: string;
  border: string;
  codeSurface: string;
  inlineCode: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  dark?: boolean;
  syntax: NonNullable<SelectableMarkdownHtmlOptions["syntaxColors"]>;
}

export interface BuildConversationShareHtmlOptions {
  allShareableIds: readonly string[];
  characterSrc?: string;
  colors: ConversationShareWebViewColors;
  contentWidth: number;
  logoSrc?: string;
  selectedMessages: readonly ConversationShareMessage[];
}

export function buildConversationShareHtml({
  allShareableIds,
  characterSrc,
  colors,
  contentWidth,
  logoSrc,
  selectedMessages,
}: BuildConversationShareHtmlOptions): string {
  const messageIndex = new Map(allShareableIds.map((id, index) => [id, index]));
  const markdownOptions = buildConversationShareMarkdownOptions(
    contentWidth,
    colors,
  );
  const messagesHtml: string[] = [];
  let previousIndex: number | null = null;

  for (const message of selectedMessages) {
    const currentIndex = messageIndex.get(message.clientId) ?? null;
    if (
      previousIndex !== null &&
      currentIndex !== null &&
      currentIndex - previousIndex > 1
    ) {
      messagesHtml.push('<div class="share-gap" aria-hidden="true">⋯</div>');
    }
    messagesHtml.push(buildMessageHtml(message, markdownOptions));
    previousIndex = currentIndex;
  }

  const markdownCss = buildSelectableMarkdownCss(markdownOptions);
  const width = Math.max(280, Math.round(contentWidth));
  const background = cssValue(colors.background);
  const logo = logoSrc
    ? `<img class="share-logo" src="${escapeAttribute(logoSrc)}" alt="">`
    : '<span class="share-wordmark">CINDY.</span>';
  const character = characterSrc
    ? `<img class="share-character" src="${escapeAttribute(characterSrc)}" alt="">`
    : "";

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">',
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://registry.npmmirror.com; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://registry.npmmirror.com; font-src https://cdn.jsdelivr.net https://registry.npmmirror.com data:; object-src 'none'; base-uri 'none'; form-action 'none';\">",
    `<style id="share-style">${markdownCss}${buildConversationShareCss({ background, surfaceElevated: colors.surfaceElevated, textPrimary: colors.textPrimary, textSecondary: colors.textSecondary, textTertiary: colors.textTertiary, width })}</style>`,
    "</head>",
    "<body>",
    `<main id="xdt-content" class="share-stage" data-share-background="${escapeAttribute(background)}">`,
    messagesHtml.join(""),
    '<footer class="share-footer">',
    `<div class="share-lockup">${character}${logo}</div>`,
    "</footer>",
    "</main>",
    buildConversationShareRichContentScript(colors.dark === true),
    buildExportScript(),
    "</body>",
    "</html>",
  ].join("");
}

function buildMessageHtml(
  message: ConversationShareMessage,
  markdownOptions: SelectableMarkdownHtmlOptions,
): string {
  const body = redactSensitiveText(message.body).trim();
  const secondaryBody = message.secondaryBody
    ? redactSensitiveText(message.secondaryBody).trim()
    : "";
  const bodyHtml = body
    ? buildSelectableMarkdownFragmentHtml(body, markdownOptions)
    : "";
  const secondaryHtml = secondaryBody
    ? buildSelectableMarkdownFragmentHtml(secondaryBody, markdownOptions)
    : "";
  return [
    `<article class="share-message share-message-${message.kind}" data-share-message-id="${escapeAttribute(message.clientId)}">`,
    `<div class="share-bubble share-bubble-${message.kind}">`,
    bodyHtml,
    secondaryHtml ? `<div class="share-secondary">${secondaryHtml}</div>` : "",
    "</div>",
    "</article>",
  ].join("");
}

function buildConversationShareMarkdownOptions(
  contentWidth: number,
  colors: ConversationShareWebViewColors,
): SelectableMarkdownHtmlOptions {
  const layout = buildMessageContentLayout({ screenWidth: contentWidth });
  return {
    bodyGap: layout.markdownBodyGap,
    borderColor: colors.border,
    chipColor: colors.codeSurface,
    fontSize: typeScale.bodyLarge,
    inlineCodeColor: colors.inlineCode,
    lineHeight: lineHeight.bodyLarge,
    mutedColor: colors.textSecondary,
    syntaxColors: colors.syntax,
    tableCellMinWidth: layout.markdownTableCellMinWidth,
    textColor: colors.textPrimary,
  };
}

function buildConversationShareCss({
  background,
  surfaceElevated,
  textPrimary,
  textSecondary,
  textTertiary,
  width,
}: {
  background: string;
  surfaceElevated: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  width: number;
}): string {
  return `
    html, body {
      margin: 0;
      padding: 0;
      background: ${background};
      color: ${cssValue(textPrimary)};
      overflow: visible;
    }
    #xdt-content.share-stage {
      box-sizing: border-box;
      width: ${width}px;
      min-width: ${width}px;
      padding: 28px;
      background: ${background};
      color: ${cssValue(textPrimary)};
      gap: 16px;
      overflow: visible;
    }
    .share-message {
      display: flex;
      width: 100%;
      min-width: 0;
    }
    .share-message-user { justify-content: flex-end; }
    .share-message-assistant { justify-content: flex-start; }
    .share-bubble {
      box-sizing: border-box;
      min-width: 0;
    }
    .share-bubble-user {
      max-width: 86%;
      padding: 12px;
      border: 1px solid ${cssValue(textSecondary)};
      border-radius: 12px;
      background: ${cssValue(surfaceElevated)};
    }
    .share-bubble-assistant {
      width: 100%;
      padding: 4px 0;
    }
    .share-secondary {
      margin-top: 8px;
      color: ${cssValue(textSecondary)};
    }
    #xdt-content table {
      display: table;
      width: max-content;
      max-width: none;
      overflow: visible;
    }
    #xdt-content pre {
      width: max-content;
      min-width: 100%;
      max-width: none;
      overflow: visible;
      white-space: pre;
    }
    .share-gap {
      width: 100%;
      color: ${cssValue(textTertiary)};
      font-size: 16px;
      line-height: 16px;
      letter-spacing: 4px;
      text-align: center;
      opacity: 0.58;
    }
    .share-footer {
      display: flex;
      align-items: center;
      flex-direction: column;
      gap: 6px;
      padding-top: 36px;
    }
    .share-lockup {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 28px;
    }
    .share-character {
      width: 22px;
      height: 22px;
      flex: 0 0 22px;
      object-fit: cover;
      border-radius: 6px;
    }
    .share-logo {
      width: auto;
      height: 18px;
      max-height: 18px;
      border-radius: 0;
    }
    .share-wordmark {
      color: ${cssValue(textPrimary)};
      font-size: 18px;
      font-weight: 500;
      letter-spacing: 1px;
    }
    .share-mermaid {
      width: 100%;
      overflow: visible;
    }
    .share-mermaid svg {
      display: block;
      width: 100%;
      height: auto;
      max-width: none;
    }
  `;
}

function buildConversationShareRichContentScript(dark: boolean): string {
  const mermaidUrls = JSON.stringify(MOBILE_MERMAID_SCRIPT_URLS);
  const mermaidTheme = dark ? "dark" : "default";
  const renderKatexJs = [
    'document.querySelectorAll("[data-latex]").forEach(function (element) {',
    "  try {",
    '    window.katex.render(element.getAttribute("data-latex") || "", element, {',
    '      displayMode: element.hasAttribute("data-katex-display"),',
    "      throwOnError: false,",
    '      strict: "ignore",',
    "    });",
    "  } catch (error) { /* 保留公式源码 */ }",
    "});",
    "clearTimeout(mathFallback);",
    "mathDone = true;",
    "maybeReady();",
  ].join("");
  const katexLoader = buildKatexLoaderJs(renderKatexJs);

  return `<script>
(function () {
  var mathNodes = document.querySelectorAll('[data-latex]');
  var mermaidNodes = document.querySelectorAll('[data-mermaid-source]');
  var mathDone = mathNodes.length === 0;
  var mermaidDone = mermaidNodes.length === 0;
  var ready = false;
  window.__cindyConversationShareRichContentReady = false;

  function maybeReady() {
    if (!ready && mathDone && mermaidDone) {
      ready = true;
      window.__cindyConversationShareRichContentReady = true;
    }
  }

  function renderMermaidNodes() {
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: '${mermaidTheme}',
        fontFamily: 'inherit',
        flowchart: { useMaxWidth: false, htmlLabels: false },
        sequence: { useMaxWidth: false },
        class: { useMaxWidth: false },
        state: { useMaxWidth: false },
        er: { useMaxWidth: false },
        gantt: { useMaxWidth: false, useWidth: 760 },
        journey: { useMaxWidth: false },
        pie: { useMaxWidth: false },
      });
    } catch (error) {
      mermaidDone = true;
      maybeReady();
      return;
    }

    var jobs = Array.prototype.map.call(mermaidNodes, function (node, index) {
      var source = node.getAttribute('data-mermaid-source') || '';
      var repaired = node.getAttribute('data-mermaid-repaired-source') || '';
      function renderSource(value) {
        return window.mermaid.parse(value).then(function () {
          return window.mermaid.render('cindy-share-mermaid-' + index, value);
        });
      }
      return renderSource(source).catch(function () {
        return repaired ? renderSource(repaired) : Promise.reject(new Error('mermaid-render-failed'));
      }).then(function (rendered) {
        var replacement = document.createElement('div');
        replacement.className = 'share-mermaid';
        replacement.innerHTML = rendered.svg;
        var pre = node.closest('pre');
        if (pre) pre.replaceWith(replacement);
      }).catch(function () {
        return undefined;
      });
    });
    Promise.all(jobs).then(function () {
      mermaidDone = true;
      maybeReady();
    });
  }

  if (!mathDone) {
    var mathFallback = setTimeout(function () {
      mathDone = true;
      maybeReady();
    }, 13000);
    ${katexLoader}
  }

  if (!mermaidDone) {
    (function attemptMermaid(index) {
      var urls = ${mermaidUrls};
      if (index >= urls.length) {
        mermaidDone = true;
        maybeReady();
        return;
      }
      var finished = false;
      var timer = setTimeout(fail, 6000);
      function fail() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        attemptMermaid(index + 1);
      }
      var script = document.createElement('script');
      script.src = urls[index];
      script.onload = function () {
        if (finished) return;
        if (!window.mermaid) { fail(); return; }
        finished = true;
        clearTimeout(timer);
        renderMermaidNodes();
      };
      script.onerror = fail;
      document.head.appendChild(script);
    })(0);
  }

  maybeReady();
})();
</script>`;
}

function buildExportScript(): string {
  return `<script>
(function () {
  var maxOutputPixels = 12000000;
  function post(payload) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }
  function waitForRichContent() {
    if (window.__cindyConversationShareRichContentReady === true) return Promise.resolve();
    return new Promise(function (resolve) {
      var deadline = Date.now() + 14000;
      function check() {
        if (window.__cindyConversationShareRichContentReady === true || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(check, 25);
      }
      check();
    });
  }
  function waitForImages() {
    var images = Array.prototype.slice.call(document.images);
    return Promise.all(images.map(function (image) {
      var loaded = image.complete
        ? Promise.resolve()
        : new Promise(function (resolve) {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        });
      return loaded.then(function () {
        return image.decode ? image.decode().catch(function () {}) : undefined;
      });
    }));
  }
  function removeExternalImages(stage) {
    Array.prototype.slice.call(stage.querySelectorAll('img')).forEach(function (image) {
      var src = image.getAttribute('src') || '';
      if (!src.startsWith('data:')) {
        var replacement = document.createTextNode(image.getAttribute('alt') || '');
        image.replaceWith(replacement);
      }
    });
  }
  window.__cindyConversationShareExportPng = function (id, scale) {
    var stage = document.getElementById('xdt-content');
    if (!stage) {
      post({ type: 'conversation-share-export', id: id, ok: false, error: 'stage-not-found' });
      return;
    }
    removeExternalImages(stage);
    waitForRichContent().then(waitForImages).then(function () {
      var rect = stage.getBoundingClientRect();
      var width = Math.max(stage.scrollWidth, Math.ceil(rect.width));
      var height = Math.max(stage.scrollHeight, Math.ceil(rect.height));
      var requestedScale = Math.max(Number(scale) || 1, 0.25);
      var maxScale = Math.sqrt(maxOutputPixels / Math.max(1, width * height));
      var effectiveScale = Math.min(requestedScale, maxScale);
      var outputWidth = Math.max(1, Math.ceil(width * effectiveScale));
      var outputHeight = Math.max(1, Math.ceil(height * effectiveScale));
      var style = document.getElementById('share-style');
      var markup = new XMLSerializer().serializeToString(stage);
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + outputWidth + '" height="' + outputHeight + '" viewBox="0 0 ' + width + ' ' + height + '">' +
        '<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:' + width + 'px;background:' + stage.getAttribute('data-share-background') + '"><style>' + (style ? style.textContent : '') + '</style>' + markup + '</div></foreignObject></svg>';
      var image = new Image();
      image.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = outputWidth;
          canvas.height = outputHeight;
          var context = canvas.getContext('2d');
          if (!context) throw new Error('canvas-context-missing');
          context.fillStyle = stage.getAttribute('data-share-background') || '#ffffff';
          context.fillRect(0, 0, outputWidth, outputHeight);
          context.drawImage(image, 0, 0, outputWidth, outputHeight);
          var dataUrl = canvas.toDataURL('image/png');
          post({ type: 'conversation-share-export', id: id, ok: true, base64: dataUrl.slice('data:image/png;base64,'.length) });
        } catch (error) {
          post({ type: 'conversation-share-export', id: id, ok: false, error: String(error && error.message || error) });
        }
      };
      image.onerror = function () {
        post({ type: 'conversation-share-export', id: id, ok: false, error: 'svg-decode-failed' });
      };
      try {
        image.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
      } catch (error) {
        post({ type: 'conversation-share-export', id: id, ok: false, error: String(error && error.message || error) });
      }
    }).catch(function (error) {
      post({ type: 'conversation-share-export', id: id, ok: false, error: String(error && error.message || error) });
    });
  };
  post({ type: 'conversation-share-ready' });
})();
</script>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function cssValue(value: string): string {
  return value.replace(/[;<>]/g, "");
}
