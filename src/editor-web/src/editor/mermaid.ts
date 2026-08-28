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
      el.title = '点击放大';
    } catch {
      el.classList.add('md-mermaid-error');
      el.dataset.mermaidReady = '0';
    }
  }
}

let lightbox: HTMLElement | null = null;
let zoom = 1;
let bound = false;

function stage(): HTMLElement | null {
  return lightbox?.querySelector('.mermaid-lightbox-stage') ?? null;
}

function applyZoom(): void {
  const svg = stage()?.querySelector('svg');
  if (svg) {
    svg.style.transform = `scale(${zoom})`;
  }
}

function closeLightbox(): void {
  lightbox?.remove();
  lightbox = null;
  zoom = 1;
}

function openLightbox(svg: SVGElement): void {
  closeLightbox();
  zoom = 1;
  lightbox = document.createElement('div');
  lightbox.className = 'mermaid-lightbox';
  lightbox.dataset.mermaidLightbox = '1';
  lightbox.innerHTML = `
    <div class="mermaid-lightbox-bar">
      <span>滚轮缩放 · Esc 关闭</span>
      <button type="button" data-mmd-zoom="-">−</button>
      <button type="button" data-mmd-zoom="+">+</button>
      <button type="button" data-mmd-zoom="1">1×</button>
      <button type="button" data-mmd-close>✕</button>
    </div>
    <div class="mermaid-lightbox-stage"></div>`;
  const clone = svg.cloneNode(true) as SVGElement;
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  clone.style.width = 'min(92vw, 1400px)';
  clone.style.height = 'auto';
  clone.style.maxWidth = 'none';
  clone.style.transformOrigin = 'center center';
  stage()?.appendChild(clone);
  document.body.appendChild(lightbox);
  lightbox.addEventListener('click', (event) => {
    const t = event.target as HTMLElement;
    if (t === lightbox || t.dataset.mmdClose !== undefined) {
      closeLightbox();
      return;
    }
    const z = t.dataset.mmdZoom;
    if (z === '+') {
      zoom = Math.min(4, zoom + 0.25);
      applyZoom();
    } else if (z === '-') {
      zoom = Math.max(0.5, zoom - 0.25);
      applyZoom();
    } else if (z === '1') {
      zoom = 1;
      applyZoom();
    }
  });
  stage()?.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoom = Math.min(4, Math.max(0.5, zoom + (event.deltaY < 0 ? 0.12 : -0.12)));
      applyZoom();
    },
    { passive: false }
  );
}

function isMermaidSvg(svg: Element): boolean {
  if (svg.closest('.md-mermaid')) {
    return true;
  }
  if (svg.id.startsWith('maho-mmd')) {
    return true;
  }
  return svg.getAttribute('aria-roledescription') === 'mermaid';
}

export function bindMermaidZoom(): void {
  if (bound) {
    return;
  }
  bound = true;
  document.addEventListener('click', (event) => {
    if (lightbox) {
      return;
    }
    const svg = (event.target as Element | null)?.closest('svg');
    if (!svg || !isMermaidSvg(svg)) {
      return;
    }
    event.preventDefault();
    openLightbox(svg);
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && lightbox) {
        event.preventDefault();
        event.stopPropagation();
        closeLightbox();
      }
    },
    true
  );
}
