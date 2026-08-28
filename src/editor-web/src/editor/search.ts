export type SearchHit = {
  line: number;
  col: number;
  preview: string;
  index: number;
  from: number;
  to: number;
};

function lineColAt(markdown: string, at: number): { line: number; col: number } {
  const before = markdown.slice(0, at);
  const line = (before.match(/\n/g) ?? []).length;
  const lastNl = before.lastIndexOf('\n');
  return { line, col: lastNl < 0 ? at : at - lastNl - 1 };
}

function previewAt(markdown: string, at: number, queryLen: number): string {
  const lastNl = markdown.lastIndexOf('\n', Math.max(0, at - 1));
  const lineStart = at === 0 ? 0 : lastNl + 1;
  const lineEnd = markdown.indexOf('\n', at);
  const lineText = markdown.slice(lineStart, lineEnd < 0 ? markdown.length : lineEnd);
  const col = at - lineStart;
  const start = Math.max(0, col - 24);
  const end = Math.min(lineText.length, col + queryLen + 36);
  return (start > 0 ? '…' : '') + lineText.slice(start, end) + (end < lineText.length ? '…' : '');
}

/** Document-wide substring hits. Offsets are into the given markdown string. */
export function findInMarkdown(
  markdown: string,
  query: string,
  limit = 200,
  caseSensitive = false
): SearchHit[] {
  const q = query;
  if (!q) {
    return [];
  }
  const source = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const hay = caseSensitive ? source : source.toLowerCase();
  const needle = caseSensitive ? q : q.toLowerCase();
  const hits: SearchHit[] = [];
  let from = 0;
  while (from < hay.length) {
    const at = hay.indexOf(needle, from);
    if (at < 0) {
      break;
    }
    const { line, col } = lineColAt(source, at);
    hits.push({
      line,
      col,
      preview: previewAt(source, at, q.length),
      index: hits.length,
      from: at,
      to: at + q.length
    });
    if (hits.length >= limit) {
      return hits;
    }
    from = at + Math.max(1, needle.length);
  }
  return hits;
}

export function replaceAllInMarkdown(
  markdown: string,
  query: string,
  replacement: string,
  caseSensitive = false
): { next: string; count: number } {
  if (!query) {
    return { next: markdown, count: 0 };
  }
  const source = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const hits = findInMarkdown(source, query, 100000, caseSensitive);
  if (!hits.length) {
    return { next: source, count: 0 };
  }
  let next = source;
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const hit = hits[i];
    if (!hit) {
      continue;
    }
    next = next.slice(0, hit.from) + replacement + next.slice(hit.to);
  }
  return { next, count: hits.length };
}

export function replaceHitInMarkdown(markdown: string, hit: SearchHit, replacement: string): string {
  const source = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (hit.from < 0 || hit.to > source.length || hit.from > hit.to) {
    return source;
  }
  return source.slice(0, hit.from) + replacement + source.slice(hit.to);
}

/** Minimal line-based diff for history preview. */
export function simpleLineDiff(
  before: string,
  after: string
): Array<{ type: 'same' | 'add' | 'del'; text: string }> {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  const out: Array<{ type: 'same' | 'add' | 'del'; text: string }> = [];
  const max = Math.max(a.length, b.length);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if (j + 1 < b.length && a[i] === b[j + 1]) {
      out.push({ type: 'add', text: b[j] ?? '' });
      j += 1;
    } else if (i + 1 < a.length && a[i + 1] === b[j]) {
      out.push({ type: 'del', text: a[i] ?? '' });
      i += 1;
    } else {
      out.push({ type: 'del', text: a[i] ?? '' });
      out.push({ type: 'add', text: b[j] ?? '' });
      i += 1;
      j += 1;
    }
    if (out.length > 400) {
      out.push({ type: 'same', text: '…' });
      break;
    }
  }
  while (i < a.length && out.length < 420) {
    out.push({ type: 'del', text: a[i] ?? '' });
    i += 1;
  }
  while (j < b.length && out.length < 420) {
    out.push({ type: 'add', text: b[j] ?? '' });
    j += 1;
  }
  void max;
  return out;
}

export function groupSnapshotsByDay<T extends { createdAt: string }>(
  items: T[]
): Array<{ label: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  const now = new Date();
  const today = dayKey(now);
  const yest = dayKey(new Date(now.getTime() - 86400000));
  for (const item of items) {
    const key = dayKey(new Date(item.createdAt));
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const ordered = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  return ordered.map(([key, list]) => ({
    label: key === today ? '今天' : key === yest ? '昨天' : key,
    items: list
  }));
}

function dayKey(d: Date): string {
  if (Number.isNaN(d.getTime())) {
    return '未知';
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
