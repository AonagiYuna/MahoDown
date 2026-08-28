import { Crepe } from '@milkdown/crepe';
import { replaceAll } from '@milkdown/kit/utils';
import { indentWithTab } from '@codemirror/commands';
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import { languages as cmLanguages } from '@codemirror/language-data';
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

const mermaidLanguage = LanguageDescription.of({
  name: 'Mermaid',
  alias: ['mermaid', 'mmd'],
  extensions: ['mmd'],
  load: () =>
    Promise.resolve(
      new LanguageSupport(
        StreamLanguage.define({
          token: (stream) => {
            stream.next();
            return null;
          }
        })
      )
    )
});

export type RichEditor = {
  ready: Promise<void>;
  getMarkdown: () => string;
  setMarkdown: (markdown: string) => void;
  destroy: () => void;
};

export function mountRichEditor(
  root: HTMLElement,
  initialMarkdown: string,
  onChange: (markdown: string) => void
): RichEditor {
  let readyState: 'pending' | 'ready' | 'failed' = 'pending';
  const crepe = new Crepe({
    root,
    defaultValue: initialMarkdown,
    features: {
      [Crepe.Feature.BlockEdit]: true,
      [Crepe.Feature.Toolbar]: true,
      [Crepe.Feature.Placeholder]: true,
      [Crepe.Feature.Cursor]: true,
      [Crepe.Feature.ListItem]: true,
      [Crepe.Feature.LinkTooltip]: true,
      [Crepe.Feature.ImageBlock]: true,
      [Crepe.Feature.CodeMirror]: true,
      [Crepe.Feature.Table]: true,
      // Latex pulls KaTeX (large). Off by default for faster first editor open.
      [Crepe.Feature.Latex]: false
    },
    featureConfigs: {
      [Crepe.Feature.CodeMirror]: {
        extensions: [Prec.highest(keymap.of([indentWithTab]))],
        languages: [mermaidLanguage, ...cmLanguages],
        renderPreview: (language, content, applyPreview) => {
          if (language.toLowerCase() !== 'mermaid') {
            return null;
          }
          const dark = document.documentElement.dataset.theme === 'dark';
          void import('./mermaid')
            .then(({ renderMermaidSvg }) => renderMermaidSvg(content, dark))
            .then((svg) => applyPreview(svg))
            .catch(() => applyPreview(null));
          return '图表渲染中…';
        }
      }
    }
  });

  crepe.on((api) => {
    api.markdownUpdated((_ctx, markdown, prevMarkdown) => {
      if (markdown !== prevMarkdown) {
        onChange(markdown);
      }
    });
  });

  const ready = crepe.create().then(
    () => {
      readyState = 'ready';
    },
    () => {
      readyState = 'failed';
      throw new Error('Editor failed to load.');
    }
  );

  const ensureReady = () => {
    if (readyState !== 'ready') {
      throw new Error('Editor is not ready.');
    }
  };

  return {
    ready,
    getMarkdown: () => {
      ensureReady();
      return crepe.getMarkdown();
    },
    setMarkdown: (markdown: string) => {
      ensureReady();
      crepe.editor.action(replaceAll(markdown, true));
    },
    destroy: () => {
      void crepe.destroy();
    }
  };
}
