import { describe, expect, it } from 'vitest';
import { appendImageMarkdown, escapeImageAlt } from './imageUpload';

describe('escapeImageAlt', () => {
  it('escapes brackets and backslashes', () => {
    expect(escapeImageAlt('a[b]c')).toBe('a\\[b\\]c');
    expect(escapeImageAlt('a\\b')).toBe('a\\\\b');
  });
});

describe('appendImageMarkdown', () => {
  it('appends image block with spacing', () => {
    expect(appendImageMarkdown('', 'x.png', 'img/x.png')).toBe('![x.png](img/x.png)\n');
    expect(appendImageMarkdown('hi', 'x.png', 'https://a/b.png')).toBe('hi\n\n![x.png](https://a/b.png)\n');
    expect(appendImageMarkdown('hi\n', 'x.png', 'u')).toBe('hi\n\n![x.png](u)\n');
  });
});
