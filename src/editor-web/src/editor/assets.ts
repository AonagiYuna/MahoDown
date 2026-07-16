import { sendBridgeRequest } from '../bridge';
import { DOC_ASSET_ORIGIN } from './markdown';

/** dataUrl → relative path for save round-trip */
const dataUrlToRelative = new Map<string, string>();

export function clearAssetCache(): void {
  dataUrlToRelative.clear();
}

export function rememberDataUrl(dataUrl: string, relativePath: string): void {
  dataUrlToRelative.set(dataUrl, relativePath.replace(/\\/g, '/'));
}

export function collapseAssetUrls(markdown: string): string {
  let result = markdown;
  for (const [dataUrl, relative] of dataUrlToRelative) {
    if (result.includes(dataUrl)) {
      result = result.split(dataUrl).join(relative);
    }
  }

  // Also collapse virtual-host form.
  const escaped = DOC_ASSET_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  result = result.replace(
    new RegExp(`!\\[([^\\]]*)\\]\\(${escaped}/([^)\\s]+)(?:\\s+"[^"]*")?\\)`, 'g'),
    '![$1]($2)'
  );
  return result;
}

function isRemoteOrData(url: string): boolean {
  return /^(https?:|data:|blob:)/i.test(url) && !url.startsWith(DOC_ASSET_ORIGIN);
}

function normalizeRelative(url: string): string {
  return url
    .trim()
    .replace(new RegExp(`^${DOC_ASSET_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '')
    .replace(/^\.\//, '')
    .replace(/\\/g, '/');
}

/** Expand relative image paths to data URLs so Milkdown can always render them. */
export async function expandImagesForDisplay(markdown: string): Promise<string> {
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const matches = [...markdown.matchAll(re)];
  if (matches.length === 0) {
    return markdown;
  }

  let result = markdown;
  for (const match of matches) {
    const full = match[0];
    const alt = match[1] ?? '';
    const rawUrl = match[2] ?? '';
    if (!rawUrl || isRemoteOrData(rawUrl) || rawUrl.startsWith('data:')) {
      continue;
    }

    const relative = normalizeRelative(rawUrl);
    if (!relative || relative.startsWith('http')) {
      continue;
    }

    try {
      const response = await sendBridgeRequest<{ dataUrl: string; relativePath?: string }>(
        'file:readAsset',
        { relativePath: relative }
      );
      if (response?.dataUrl) {
        rememberDataUrl(response.dataUrl, response.relativePath ?? relative);
        result = result.replace(full, `![${alt}](${response.dataUrl})`);
      }
    } catch {
      // leave original url
    }
  }

  return result;
}
