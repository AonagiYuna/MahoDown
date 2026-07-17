import { Crepe } from '@milkdown/crepe';
import { replaceAll } from '@milkdown/kit/utils';
import { indentWithTab } from '@codemirror/commands';
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

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
      [Crepe.Feature.Latex]: true
    },
    featureConfigs: {
      [Crepe.Feature.CodeMirror]: {
        // Tab / Shift-Tab indent inside code blocks (CodeMirror ships no Tab
        // binding by default). Prec.highest so Tab indents rather than being
        // swallowed by any default binding; indentWithTab also de-indents.
        extensions: [Prec.highest(keymap.of([indentWithTab]))]
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
