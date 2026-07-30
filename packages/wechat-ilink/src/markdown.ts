const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

function removeMarkdownImages(markdown: string): string {
  let output = "";
  let offset = 0;
  while (offset < markdown.length) {
    const start = markdown.indexOf("![", offset);
    if (start < 0) return output + markdown.slice(offset);
    const altEnd = markdown.indexOf("]", start + 2);
    if (altEnd < 0) return output + markdown.slice(offset);
    if (markdown[altEnd + 1] !== "(") {
      output += markdown.slice(offset, altEnd + 1);
      offset = altEnd + 1;
      continue;
    }
    const destinationEnd = markdown.indexOf(")", altEnd + 2);
    if (destinationEnd < 0) return output + markdown.slice(offset);
    output += markdown.slice(offset, start);
    offset = destinationEnd + 1;
  }
  return output;
}

function filterPlainMarkdown(markdown: string): string {
  return removeMarkdownImages(markdown)
    .replace(/^#{5,6}\s+/gm, "")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(
      /(\*{1,3}|_{1,3})([^*_\n]+)\1/g,
      (whole, marker: string, body: string) =>
        CJK.test(body) && marker.length !== 2 ? body : whole,
    );
}

function filterInlineCodeAware(markdown: string): string {
  let output = "";
  let offset = 0;
  while (offset < markdown.length) {
    const start = markdown.indexOf("`", offset);
    if (start < 0) return output + filterPlainMarkdown(markdown.slice(offset));
    output += filterPlainMarkdown(markdown.slice(offset, start));
    let markerEnd = start;
    while (markdown[markerEnd] === "`") markerEnd += 1;
    const marker = markdown.slice(start, markerEnd);
    const end = markdown.indexOf(marker, markerEnd);
    if (end < 0) return output + markdown.slice(start);
    output += markdown.slice(start, end + marker.length);
    offset = end + marker.length;
  }
  return output;
}

/** Remove unsupported markdown while preserving fenced and inline code verbatim. */
export function filterWechatMarkdown(markdown: string): string {
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let fenced = false;
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      return fenced ? line : filterInlineCodeAware(line);
    })
    .join("");
}
