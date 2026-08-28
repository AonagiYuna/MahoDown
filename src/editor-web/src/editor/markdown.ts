export const DOC_ASSET_ORIGIN = 'https://doc.mahodown.local';

type HighlightMod = typeof import('./highlight');
let highlightMod: HighlightMod | null = null;
let highlightLoad: Promise<HighlightMod> | null = null;

/** Prefetch hljs after first paint; preview works uncolored until ready. */
export function preloadHighlight(): Promise<HighlightMod> {
  if (!highlightLoad) {
    highlightLoad = import('./highlight').then((m) => {
      highlightMod = m;
      return m;
    });
  }
  return highlightLoad;
}

function languageLabel(lang?: string): string {
  return highlightMod?.languageLabel(lang) ?? ((lang ?? '').trim() || 'text');
}

function highlightCode(code: string, lang?: string): string {
  if (!highlightMod) {
    return code
      .replace(/\n$/, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  return highlightMod.highlightCode(code, lang);
}

export function normalizeMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

/** Relative local image paths → virtual host URLs for WebView2 display. */
export function toDisplayMarkdown(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, alt, url) => {
    const trimmed = String(url).trim();
    if (/^(https?:|data:|blob:)/i.test(trimmed)) {
      return full;
    }
    const clean = trimmed.replace(/^\.\//, '').replace(/\\/g, '/');
    return `![${alt}](${DOC_ASSET_ORIGIN}/${clean})`;
  });
}

/** Virtual host image URLs → relative paths for saving Markdown. */
export function toStorageMarkdown(markdown: string): string {
  const escaped = DOC_ASSET_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return markdown.replace(new RegExp(`!\\[([^\\]]*)\\]\\(${escaped}/([^)\\s]+)(?:\\s+"[^"]*")?\\)`, 'g'), '![$1]($2)');
}

export function countWords(markdown: string): number {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/[#>*_~\-|[\](){}]/g, ' ')
    .trim();
  if (!text) {
    return 0;
  }
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = text
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + latin;
}

export function estimateReadMinutes(wordCount: number): number {
  return Math.max(1, Math.ceil(wordCount / 300));
}

export function extractOutline(markdown: string): Array<{ level: number; text: string; line: number }> {
  const lines = markdown.split('\n');
  const items: Array<{ level: number; text: string; line: number }> = [];
  let inCode = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      continue;
    }
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      items.push({ level: match[1].length, text: (match[2] ?? '').trim(), line: i });
    }
  }
  return items;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resolveImageSrc(url: string): string {
  const trimmed = url.trim();
  if (/^(https?:|data:|blob:)/i.test(trimmed)) {
    return trimmed;
  }
  const clean = trimmed.replace(/^\.\//, '').replace(/\\/g, '/');
  return `${DOC_ASSET_ORIGIN}/${clean}`;
}

type FootnoteCtx = {
  defs: Map<string, string>;
  order: string[];
};

let footnoteCtx: FootnoteCtx | null = null;

function fnSlug(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

const INLINE_HTML = new Set([
  'br',
  'kbd',
  'mark',
  'sub',
  'sup',
  'span',
  'u',
  'small',
  'abbr',
  'cite',
  'dfn',
  'time',
  'wbr',
  'img',
  'video',
  'audio',
  'source'
]);

function sanitizeAttrValue(name: string, value: string): string | null {
  const n = name.toLowerCase();
  const v = value.trim();
  if (n.startsWith('on') || n === 'srcdoc') {
    return null;
  }
  if (/^(javascript|vbscript):/i.test(v)) {
    return null;
  }
  if (/^data:/i.test(v) && !/^data:image\//i.test(v)) {
    return null;
  }
  return value;
}

function sanitizeInlineHtml(tag: string): string {
  const parsed = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)\/?>$/.exec(tag.trim());
  if (!parsed) {
    return escapeHtml(tag);
  }
  const name = (parsed[1] ?? '').toLowerCase();
  if (!INLINE_HTML.has(name)) {
    return escapeHtml(tag);
  }
  const closing = tag.trim().startsWith('</');
  if (closing) {
    return `</${name}>`;
  }
  const attrSrc = parsed[2] ?? '';
  const attrs: string[] = [];
  const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrSrc))) {
    const key = m[1] ?? '';
    const raw = m[2] ?? m[3] ?? m[4] ?? '';
    const safe = sanitizeAttrValue(key, raw);
    if (safe === null) {
      continue;
    }
    if (m[2] !== undefined || m[3] !== undefined || m[4] !== undefined) {
      attrs.push(`${key}="${escapeHtml(safe)}"`);
    } else {
      attrs.push(key);
    }
  }
  const voidish = name === 'br' || name === 'img' || name === 'wbr' || name === 'source';
  const attrStr = attrs.length ? ` ${attrs.join(' ')}` : '';
  return voidish ? `<${name}${attrStr} />` : `<${name}${attrStr}>`;
}

function decorateMarkdown(escaped: string): string {
  return escaped
    .replace(/!\[([^\]]*)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, url) => {
      return `<img src="${resolveImageSrc(url)}" alt="${alt}" />`;
    })
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\[\^([^\]]+)\]/g, (_m, id: string) => {
      const ctx = footnoteCtx;
      if (!ctx || !ctx.defs.has(id)) {
        return _m;
      }
      if (!ctx.order.includes(id)) {
        ctx.order.push(id);
      }
      const n = ctx.order.indexOf(id) + 1;
      const slug = fnSlug(id);
      return `<sup class="fn-ref"><a href="#fn-${slug}" id="fnref-${slug}-${n}">${n}</a></sup>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function inline(text: string): string {
  const chunks = text.split(/(<\/?[a-zA-Z][a-zA-Z0-9-]*[^>]*>)/);
  return chunks
    .map((chunk, idx) => {
      if (idx % 2 === 1) {
        return sanitizeInlineHtml(chunk);
      }
      return decorateMarkdown(escapeHtml(chunk));
    })
    .join('');
}

const BLOCKED_HTML = /^(SCRIPT|IFRAME|OBJECT|EMBED|FORM|LINK|META|BASE|STYLE)$/;

export function sanitizeHtml(raw: string): string {
  if (typeof DOMParser === 'undefined') {
    return escapeHtml(raw);
  }
  const doc = new DOMParser().parseFromString(`<body>${raw}</body>`, 'text/html');
  const body = doc.body;
  const walk = (el: Element) => {
    [...el.children].forEach((child) => {
      if (BLOCKED_HTML.test(child.tagName)) {
        child.remove();
        return;
      }
      [...child.attributes].forEach((attr) => {
        const safe = sanitizeAttrValue(attr.name, attr.value);
        if (safe === null) {
          child.removeAttribute(attr.name);
        } else if (safe !== attr.value) {
          child.setAttribute(attr.name, safe);
        }
      });
      walk(child);
    });
  };
  walk(body);
  return body.innerHTML;
}

function pullFootnotes(lines: string[]): Map<string, string> {
  const defs = new Map<string, string>();
  const skip = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(lines[i] ?? '');
    if (!m) {
      continue;
    }
    skip.add(i);
    const parts = [m[2] ?? ''];
    let j = i + 1;
    while (j < lines.length) {
      const ln = lines[j] ?? '';
      if (/^(?:\s{2,}|\t)\S/.test(ln)) {
        parts.push(ln.trim());
        skip.add(j);
        j += 1;
        continue;
      }
      break;
    }
    defs.set(m[1] ?? '', parts.join(' ').trim());
  }
  for (const idx of skip) {
    lines[idx] = '';
  }
  return defs;
}

function isHtmlBlockStart(line: string): boolean {
  return /^<\/?[a-zA-Z][a-zA-Z0-9-]*/.test(line.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]+\|?\s*$/.test(line) && /\|/.test(line) && /-/.test(line);
}

type ListItem = {
  indent: number;
  ordered: boolean;
  task: boolean;
  checked: boolean;
  text: string;
};

function parseListItem(line: string): ListItem | null {
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return null;
  }
  const m = /^(\s*)([-*+]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
  if (!m) {
    return null;
  }
  return {
    indent: (m[1] ?? '').length,
    ordered: /^\d+\./.test(m[2] ?? ''),
    task: m[3] !== undefined,
    checked: (m[3] ?? '').toLowerCase() === 'x',
    text: m[4] ?? ''
  };
}

function consumeList(
  lines: string[],
  cursor: { i: number },
  startIndent: number,
  ordered: boolean
): string {
  const tag = ordered ? 'ol' : 'ul';
  const out: string[] = [`<${tag}>`];
  while (cursor.i < lines.length) {
    const item = parseListItem(lines[cursor.i] ?? '');
    if (!item || item.indent < startIndent) {
      break;
    }
    if (item.indent > startIndent) {
      out.push(consumeList(lines, cursor, item.indent, item.ordered));
      continue;
    }
    if (item.ordered !== ordered) {
      break;
    }
    cursor.i += 1;
    let nested = '';
    const next = parseListItem(lines[cursor.i] ?? '');
    if (next && next.indent > startIndent) {
      nested = consumeList(lines, cursor, next.indent, next.ordered);
    }
    if (item.task) {
      const checked = item.checked ? ' checked' : '';
      out.push(
        `<li class="task"><input type="checkbox" disabled${checked} /> ${inline(item.text)}${nested}</li>`
      );
    } else {
      out.push(`<li>${inline(item.text)}${nested}</li>`);
    }
  }
  out.push(`</${tag}>`);
  return out.join('');
}

function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) {
    row = row.slice(1);
  }
  if (row.endsWith('|')) {
    row = row.slice(0, -1);
  }
  return row.split('|').map((cell) => cell.trim());
}

/** GFM-leaning preview renderer for split mode (tables, lists, hr, tasks). */
export function renderPreviewHtml(markdown: string): string {
  const source = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Protect fenced code blocks first (syntax-colored).
  const codeBlocks: string[] = [];
  const withPlaceholders = source.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const rawLang = String(lang ?? '').trim();
    if (rawLang.toLowerCase() === 'mermaid') {
      const body = String(code ?? '').replace(/\n$/, '');
      codeBlocks.push(
        `<div class="md-mermaid"><pre class="md-mermaid-src">${escapeHtml(body)}</pre></div>`
      );
      return `\u0000CODE${idx}\u0000`;
    }
    const label = languageLabel(rawLang);
    const colored = highlightCode(String(code ?? ''), label);
    codeBlocks.push(
      `<pre class="code-block" data-lang="${escapeHtml(label)}"><div class="code-lang">${escapeHtml(label)}</div><code class="hljs">${colored}</code></pre>`
    );
    return `\u0000CODE${idx}\u0000`;
  });

  const lines = withPlaceholders.split('\n');
  const defs = pullFootnotes(lines);
  footnoteCtx = { defs, order: [] };
  const html: string[] = [];
  let i = 0;
  let listType: 'ul' | 'ol' | null = null;

  const flushList = () => {
    if (listType) {
      html.push(listType === 'ul' ? '</ul>' : '</ol>');
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';

    const codeMatch = /^\u0000CODE(\d+)\u0000$/.exec(line.trim());
    if (codeMatch) {
      flushList();
      html.push(codeBlocks[Number(codeMatch[1])] ?? '');
      i += 1;
      continue;
    }

    // Table: header + separator + rows
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1] ?? '')
    ) {
      flushList();
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        if (isTableSeparator(lines[i] ?? '')) {
          i += 1;
          continue;
        }
        rows.push(splitTableRow(lines[i] ?? ''));
        i += 1;
      }
      html.push('<table><thead><tr>');
      for (const cell of header) {
        html.push(`<th>${inline(cell)}</th>`);
      }
      html.push('</tr></thead><tbody>');
      for (const row of rows) {
        html.push('<tr>');
        for (let c = 0; c < header.length; c += 1) {
          html.push(`<td>${inline(row[c] ?? '')}</td>`);
        }
        html.push('</tr>');
      }
      html.push('</tbody></table>');
      continue;
    }

    if (isHtmlBlockStart(line)) {
      flushList();
      const buf: string[] = [];
      while (i < lines.length) {
        const ln = lines[i] ?? '';
        if (buf.length > 0 && !ln.trim()) {
          break;
        }
        buf.push(ln);
        i += 1;
      }
      html.push(sanitizeHtml(buf.join('\n')));
      continue;
    }

    if (
      line.trim() &&
      i + 1 < lines.length &&
      /^:\s+\S/.test(lines[i + 1] ?? '') &&
      !parseListItem(line) &&
      !line.includes('|')
    ) {
      flushList();
      html.push('<dl>');
      while (i < lines.length) {
        const terms: string[] = [];
        while (
          i < lines.length &&
          (lines[i] ?? '').trim() &&
          !/^:\s+/.test(lines[i] ?? '') &&
          i + 1 < lines.length &&
          /^:\s+\S/.test(lines[i + 1] ?? '')
        ) {
          terms.push((lines[i] ?? '').trim());
          i += 1;
        }
        if (!terms.length) {
          break;
        }
        for (const term of terms) {
          html.push(`<dt>${inline(term)}</dt>`);
        }
        while (i < lines.length && /^:\s+/.test(lines[i] ?? '')) {
          const chunks = [(lines[i] ?? '').replace(/^:\s+/, '')];
          i += 1;
          while (i < lines.length && /^(?:\s{2,}|\t)\S/.test(lines[i] ?? '')) {
            chunks.push((lines[i] ?? '').trim());
            i += 1;
          }
          html.push(`<dd>${inline(chunks.join(' '))}</dd>`);
        }
      }
      html.push('</dl>');
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(-\s*){3,}$|^\s*---+\s*$|^\s*\*\*\*+\s*$|^\s*___+\s*$/.test(line)) {
      flushList();
      html.push('<hr />');
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line) || line === '>') {
      flushList();
      const quote: string[] = [];
      while (i < lines.length) {
        const q = lines[i] ?? '';
        if (!(q === '>' || /^>\s?/.test(q))) {
          break;
        }
        quote.push(q.replace(/^>\s?/, ''));
        i += 1;
      }
      const paras = quote
        .join('\n')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p>${inline(p.replace(/\n/g, ' '))}</p>`);
      html.push(`<blockquote>${paras.join('')}</blockquote>`);
      continue;
    }

    const listHead = parseListItem(line);
    if (listHead) {
      flushList();
      const cursor = { i };
      html.push(consumeList(lines, cursor, listHead.indent, listHead.ordered));
      i = cursor.i;
      continue;
    }

    if (!line.trim()) {
      flushList();
      i += 1;
      continue;
    }

    flushList();
    html.push(`<p>${inline(line)}</p>`);
    i += 1;
  }

  flushList();
  const noteOrder = footnoteCtx ? [...footnoteCtx.order] : [];
  if (noteOrder.length) {
    html.push('<hr class="footnotes-sep" /><section class="footnotes"><ol>');
    for (const id of noteOrder) {
      const slug = fnSlug(id);
      const body = footnoteCtx?.defs.get(id) ?? '';
      html.push(
        `<li id="fn-${slug}">${inline(body)} <a class="fn-back" href="#fnref-${slug}-1">↩</a></li>`
      );
    }
    html.push('</ol></section>');
  }
  footnoteCtx = null;
  return html.join('\n');
}
