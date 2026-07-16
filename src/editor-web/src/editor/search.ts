export type SearchHit = {
  line: number;
  col: number;
  preview: string;
  index: number;
};

/** Case-insensitive line hits for current document search. */
export function findInMarkdown(markdown: string, query: string, limit = 200): SearchHit[] {
  const q = query.trim();
  if (!q) {
    return [];
  }
  const lower = q.toLowerCase();
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const hits: SearchHit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const hay = line.toLowerCase();
    let from = 0;
    while (from < hay.length) {
      const at = hay.indexOf(lower, from);
      if (at < 0) {
        break;
      }
      const start = Math.max(0, at - 24);
      const end = Math.min(line.length, at + q.length + 36);
      const preview =
        (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
      hits.push({ line: i, col: at, preview, index: hits.length });
      if (hits.length >= limit) {
        return hits;
      }
      from = at + Math.max(1, q.length);
    }
  }
  return hits;
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
  // LCS is heavy; use simple walk for short docs
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
