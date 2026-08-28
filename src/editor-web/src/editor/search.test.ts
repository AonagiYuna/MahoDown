import { describe, expect, it } from 'vitest';
import { findInMarkdown, replaceAllInMarkdown, replaceHitInMarkdown } from './search';

describe('findInMarkdown', () => {
  it('finds overlapping-safe case-insensitive hits with offsets', () => {
    const md = '# Hello\n\nhello HELLO\n';
    const hits = findInMarkdown(md, 'hello');
    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({ line: 0, col: 2, from: 2, to: 7 });
    expect(hits[1]?.line).toBe(2);
    expect(hits[2]?.preview.toLowerCase()).toContain('hello');
  });

  it('respects case sensitivity', () => {
    const md = 'Foo foo FOO';
    expect(findInMarkdown(md, 'foo', 200, false)).toHaveLength(3);
    expect(findInMarkdown(md, 'foo', 200, true)).toHaveLength(1);
  });
});

describe('replaceInMarkdown', () => {
  it('replaces one hit and all hits', () => {
    const md = 'a cat and a cat';
    const hits = findInMarkdown(md, 'cat');
    expect(replaceHitInMarkdown(md, hits[0]!, 'dog')).toBe('a dog and a cat');
    expect(replaceAllInMarkdown(md, 'cat', 'dog')).toEqual({ next: 'a dog and a dog', count: 2 });
  });

  it('replaces case-insensitively', () => {
    expect(replaceAllInMarkdown('Cat CAT cat', 'cat', 'dog', false).next).toBe('dog dog dog');
  });
});
