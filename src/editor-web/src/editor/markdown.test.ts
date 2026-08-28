import { describe, expect, it } from 'vitest';
import {
  countWords,
  extractOutline,
  normalizeMarkdown,
  renderPreviewHtml,
  toDisplayMarkdown,
  toStorageMarkdown
} from './markdown';

describe('normalizeMarkdown', () => {
  it('normalizes line endings and trailing newline', () => {
    expect(normalizeMarkdown('a\r\nb\r')).toBe('a\nb\n');
    expect(normalizeMarkdown('a\n')).toBe('a\n');
  });
});

describe('countWords', () => {
  it('counts cjk and latin', () => {
    expect(countWords('你好 world')).toBe(3);
    expect(countWords('')).toBe(0);
  });
});

describe('extractOutline', () => {
  it('extracts h1-h6 with line numbers and skips code fences', () => {
    const md = '# A\n\n## B\ntext\n### C\n\n```\n# not heading\n```\n\n#### D\n';
    expect(extractOutline(md)).toEqual([
      { level: 1, text: 'A', line: 0 },
      { level: 2, text: 'B', line: 2 },
      { level: 3, text: 'C', line: 4 },
      { level: 4, text: 'D', line: 10 }
    ]);
  });
});

describe('display/storage image urls', () => {
  it('round-trips relative images via virtual host', () => {
    const storage = '![x](img/a.png)\n';
    const display = toDisplayMarkdown(storage);
    expect(display).toContain('https://doc.mahodown.local/img/a.png');
    expect(toStorageMarkdown(display)).toBe(storage);
  });
});

describe('renderPreviewHtml GFM', () => {
  it('renders headings, lists, code, strike', () => {
    const html = renderPreviewHtml('# T\n\n- a\n\n1. b\n\n```js\nconst x=1\n```\n\n~~old~~\n');
    expect(html).toContain('<h1>T</h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<ol>');
    expect(html).toContain('data-lang="js"');
    expect(html).toContain('class="hljs"');
    expect(html).toContain('<del>old</del>');
  });

  it('renders tables', () => {
    const html = renderPreviewHtml('| A | B |\n| --- | --- |\n| 1 | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders task lists and hr', () => {
    const html = renderPreviewHtml('- [x] done\n- [ ] todo\n\n---\n');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
    expect(html).toContain('<hr />');
  });

  it('nests lists and keeps mermaid fences as diagram mounts', () => {
    const html = renderPreviewHtml('- a\n  - b\n\n```mermaid\nflowchart LR\n  x-->y\n```\n');
    expect(html).toContain('<ul><li>a<ul><li>b</li></ul></li></ul>');
    expect(html).toContain('class="md-mermaid"');
    expect(html).toContain('flowchart LR');
  });

  it('renders blockquotes that use > without a following space', () => {
    const html = renderPreviewHtml('>hello\n>\n> world\n');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('hello');
    expect(html).toContain('world');
  });
});
