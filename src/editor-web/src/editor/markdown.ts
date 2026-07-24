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
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) {
      items.push({ level: match[1].length, text: match[2].trim(), line: i });
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

function inline(text: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/!\[([^\]]*)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, url) => {
      return `<img src="${resolveImageSrc(url)}" alt="${alt}" />`;
    })
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]+\|?\s*$/.test(line) && /\|/.test(line) && /-/.test(line);
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
    const label = languageLabel(String(lang ?? ''));
    const colored = highlightCode(String(code ?? ''), label);
    codeBlocks.push(
      `<pre class="code-block" data-lang="${escapeHtml(label)}"><div class="code-lang">${escapeHtml(label)}</div><code class="hljs">${colored}</code></pre>`
    );
    return `\u0000CODE${idx}\u0000`;
  });

  const lines = withPlaceholders.split('\n');
  const html: string[] = [];
  let i = 0;
  let listType: 'ul' | 'ol' | null = null;

  const flushList = () => {
    if (listType) {
      html.push(listType === 'ul' ? '</ul>' : '</ol>');
      listType = null;
    }
  };

  const openList = (type: 'ul' | 'ol') => {
    if (listType !== type) {
      flushList();
      html.push(type === 'ul' ? '<ul>' : '<ol>');
      listType = type;
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

    if (line.startsWith('> ')) {
      flushList();
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('> ')) {
        quote.push((lines[i] ?? '').slice(2));
        i += 1;
      }
      html.push(`<blockquote>${quote.map((q) => `<p>${inline(q)}</p>`).join('')}</blockquote>`);
      continue;
    }

    const task = /^[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (task) {
      openList('ul');
      const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
      html.push(
        `<li class="task"><input type="checkbox" disabled${checked} /> ${inline(task[2])}</li>`
      );
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      openList('ul');
      html.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
      i += 1;
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      openList('ol');
      html.push(`<li>${inline(line.replace(/^\d+\.\s+/, ''))}</li>`);
      i += 1;
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
  return html.join('\n');
}
