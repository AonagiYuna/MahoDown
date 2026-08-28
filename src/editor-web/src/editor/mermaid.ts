type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

let mermaidApi: MermaidApi | null = null;
let load: Promise<MermaidApi> | null = null;
let seq = 0;

function loadMermaid(): Promise<MermaidApi> {
  if (!load) {
    load = import('mermaid').then((mod) => {
      const api = (mod.default ?? mod) as MermaidApi;
      mermaidApi = api;
      return api;
    });
  }
  return load;
}

function sourceOf(el: HTMLElement): string {
  const pre = el.querySelector('.md-mermaid-src');
  return (pre?.textContent ?? el.dataset.mermaidSrc ?? '').trim();
}

export async function renderMermaidSvg(src: string, dark: boolean): Promise<string> {
  const api = mermaidApi ?? (await loadMermaid());
  api.initialize({
    startOnLoad: false,
    theme: dark ? 'dark' : 'default',
    securityLevel: 'strict',
    fontFamily: 'inherit'
  });
  seq += 1;
  const { svg } = await api.render(`maho-mmd-${seq}`, src);
  return svg;
}

export async function hydrateMermaid(root: ParentNode, dark: boolean): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('.md-mermaid'));
  if (!blocks.length) {
    return;
  }
  for (const el of blocks) {
    if (el.dataset.mermaidReady === '1') {
      continue;
    }
    const src = sourceOf(el);
    if (!src) {
      continue;
    }
    try {
      const svg = await renderMermaidSvg(src, dark);
      const srcEl = el.querySelector('.md-mermaid-src');
      el.innerHTML = svg;
      if (srcEl) {
        el.appendChild(srcEl);
      }
      el.dataset.mermaidReady = '1';
    } catch {
      el.classList.add('md-mermaid-error');
      el.dataset.mermaidReady = '0';
    }
  }
}
