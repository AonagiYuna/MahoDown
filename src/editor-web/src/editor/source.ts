import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

export type SourceEditor = {
  getMarkdown: () => string;
  setMarkdown: (markdown: string) => void;
  focus: () => void;
  jumpToLine: (line: number) => void;
  jumpToRange: (from: number, to: number) => void;
  getSelection: () => string;
  replaceSelection: (text: string) => void;
  destroy: () => void;
};

const lightHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700', color: '#1f2023' },
  { tag: tags.heading1, fontSize: '1.15em' },
  { tag: tags.strong, fontWeight: '700', color: '#3f77c9' },
  { tag: tags.emphasis, fontStyle: 'italic', color: '#6a5fd0' },
  { tag: tags.link, color: '#3f77c9' },
  { tag: tags.url, color: '#6d6c68' },
  { tag: tags.monospace, color: '#6a5fd0', fontFamily: 'var(--font-mono)' },
  { tag: tags.meta, color: '#a9a7a2' },
  { tag: tags.keyword, color: '#5b8fdd' },
  { tag: tags.comment, color: '#a9a7a2', fontStyle: 'italic' }
]);

const darkHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700', color: '#e6e7ea' },
  { tag: tags.heading1, fontSize: '1.15em' },
  { tag: tags.strong, fontWeight: '700', color: '#8cb4f0' },
  { tag: tags.emphasis, fontStyle: 'italic', color: '#b4a8f5' },
  { tag: tags.link, color: '#8cb4f0' },
  { tag: tags.url, color: '#8b8e96' },
  { tag: tags.monospace, color: '#b4a8f5', fontFamily: 'var(--font-mono)' },
  { tag: tags.meta, color: '#6d7078' },
  { tag: tags.keyword, color: '#8cb4f0' },
  { tag: tags.comment, color: '#6d7078', fontStyle: 'italic' }
]);

function themeExtension(dark: boolean) {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: 'calc(var(--editor-font-size, 15px) - 2px)',
        backgroundColor: 'transparent',
        color: dark ? '#e6e7ea' : '#1f2023'
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: 'var(--editor-line-height, 1.9)',
        overflow: 'auto'
      },
      '.cm-content': {
        padding: '26px 18px 80px 8px',
        caretColor: dark ? '#b4a8f5' : '#8c7ee8'
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        border: 'none',
        color: dark ? '#5c5f66' : '#aca9a2',
        minWidth: '40px',
        paddingLeft: '12px'
      },
      '.cm-activeLineGutter': {
        backgroundColor: dark ? 'rgba(157,140,240,0.12)' : 'rgba(157,140,240,0.1)',
        color: dark ? '#b4a8f5' : '#6a5fd0'
      },
      '.cm-activeLine': {
        backgroundColor: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)'
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'var(--selection) !important'
      },
      '&.cm-focused': {
        outline: 'none'
      },
      '.cm-cursor': {
        borderLeftColor: dark ? '#b4a8f5' : '#8c7ee8'
      }
    },
    { dark }
  );
}

export function mountSourceEditor(
  parent: HTMLElement,
  initialMarkdown: string,
  onChange: (markdown: string) => void,
  options?: { dark?: boolean }
): SourceEditor {
  let suppress = false;
  const dark = options?.dark ?? false;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initialMarkdown,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        markdown(),
        syntaxHighlighting(dark ? darkHighlight : lightHighlight),
        themeExtension(dark),
        placeholder('开始书写 Markdown…'),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (suppress || !update.docChanged) {
            return;
          }
          onChange(update.state.doc.toString());
        }),
        EditorView.lineWrapping
      ]
    })
  });

  return {
    getMarkdown: () => view.state.doc.toString(),
    setMarkdown: (markdown: string) => {
      const current = view.state.doc.toString();
      if (current === markdown) {
        return;
      }
      suppress = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: markdown }
      });
      suppress = false;
    },
    focus: () => view.focus(),
    jumpToLine: (line: number) => {
      const doc = view.state.doc;
      const target = Math.max(1, Math.min(line + 1, doc.lines));
      const lineInfo = doc.line(target);
      view.dispatch({
        selection: { anchor: lineInfo.from, head: lineInfo.to },
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'start', yMargin: 48 })
      });
      view.focus();
    },
    jumpToRange: (from: number, to: number) => {
      const doc = view.state.doc;
      const f = Math.max(0, Math.min(from, doc.length));
      const t = Math.max(f, Math.min(to, doc.length));
      view.dispatch({
        selection: { anchor: f, head: t },
        effects: EditorView.scrollIntoView(f, { y: 'center', yMargin: 60 })
      });
      view.focus();
    },
    getSelection: () => {
      const sel = view.state.selection.main;
      if (sel.empty) {
        return '';
      }
      return view.state.doc.sliceString(sel.from, sel.to);
    },
    replaceSelection: (text: string) => {
      const sel = view.state.selection.main;
      suppress = true;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length }
      });
      suppress = false;
    },
    destroy: () => {
      view.destroy();
    }
  };
}
