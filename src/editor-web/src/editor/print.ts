import { renderPreviewHtml } from './markdown';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildPrintDocument(title: string, bodyHtml: string, dark: boolean): string {
  const bg = dark ? '#16171b' : '#ffffff';
  const fg = dark ? '#e6e7ea' : '#1f2023';
  const muted = dark ? '#a3a6ae' : '#6d6c68';
  const codeBg = dark ? '#111216' : '#f2f0ec';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: ${bg};
    color: ${fg};
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    font-size: 11.5pt;
    line-height: 1.75;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 8px 4px 24px;
  }
  h1, h2, h3, h4, h5, h6 {
    font-family: "Noto Serif SC", "Songti SC", "SimSun", serif;
    line-height: 1.3;
    page-break-after: avoid;
    color: ${fg};
  }
  h1 { font-size: 22pt; margin: 0 0 0.6em; }
  h2 { font-size: 16pt; margin: 1.2em 0 0.45em; }
  h3 { font-size: 13pt; margin: 1em 0 0.4em; }
  h4, h5, h6 { font-size: 11.5pt; margin: 0.9em 0 0.35em; }
  p { margin: 0.45em 0; }
  ul, ol { margin: 0.4em 0 0.4em 1.4em; padding: 0; }
  li { margin: 0.2em 0; }
  blockquote {
    margin: 0.7em 0;
    padding: 0.2em 0 0.2em 0.9em;
    border-left: 3px solid #9d8cf0;
    color: ${muted};
  }
  pre, code { font-family: "JetBrains Mono", Consolas, "Courier New", monospace; }
  pre {
    background: ${codeBg};
    border-radius: 6px;
    padding: 10px 12px;
    overflow: auto;
    font-size: 9.5pt;
    line-height: 1.5;
    page-break-inside: avoid;
    white-space: pre-wrap;
    word-break: break-word;
  }
  code {
    background: ${codeBg};
    border-radius: 3px;
    padding: 0 3px;
    font-size: 0.92em;
  }
  pre code { background: transparent; padding: 0; }
  img {
    max-width: 100% !important;
    height: auto !important;
    display: block;
    margin: 10px 0;
    border-radius: 4px;
    page-break-inside: avoid;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.8em 0;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid rgba(127,127,127,.4);
    padding: 6px 10px;
    text-align: left;
  }
  th { background: rgba(157,140,240,.1); }
  hr {
    border: none;
    border-top: 1px solid rgba(127,127,127,.35);
    margin: 1.2em 0;
  }
  a { color: #3f77c9; text-decoration: none; }
  .print-title {
    font-size: 10pt;
    color: ${muted};
    margin-bottom: 1.2em;
    padding-bottom: 0.5em;
    border-bottom: 1px solid rgba(127,127,127,.2);
  }
  @media print {
    html, body { background: #fff !important; color: #000 !important; }
    a { color: inherit; }
    pre, code, th { background: #f4f4f4 !important; }
  }
</style>
</head>
<body>
  <main>
    <div class="print-title">${escapeHtml(title)}</div>
    <article class="prose">${bodyHtml}</article>
  </main>
</body>
</html>`;
}

function waitForImages(doc: Document, timeoutMs = 8000): Promise<void> {
  const images = Array.from(doc.images);
  if (images.length === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let left = images.length;
    const done = () => {
      left -= 1;
      if (left <= 0) {
        resolve();
      }
    };
    const timer = window.setTimeout(resolve, timeoutMs);
    for (const img of images) {
      if (img.complete && img.naturalWidth > 0) {
        done();
        continue;
      }
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }
    if (left <= 0) {
      window.clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * In-app print: hidden iframe + system print dialog (no external browser).
 * `markdownForDisplay` should already embed local images as data URLs.
 */
export async function printInApp(options: {
  title: string;
  markdownForDisplay: string;
  dark?: boolean;
}): Promise<void> {
  const bodyHtml = renderPreviewHtml(options.markdownForDisplay);
  const html = buildPrintDocument(options.title, bodyHtml, options.dark ?? false);

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;';
  document.body.appendChild(iframe);

  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  if (!win || !doc) {
    iframe.remove();
    throw new Error('无法创建打印视图');
  }

  doc.open();
  doc.write(html);
  doc.close();

  await waitForImages(doc);
  // Layout settle
  await new Promise((r) => window.setTimeout(r, 120));

  try {
    win.focus();
    win.print();
  } finally {
    window.setTimeout(() => iframe.remove(), 1500);
  }
}
