import { sendBridgeRequest } from './bridge';

export type ImageUploadResult = {
  markdownUrl: string;
  contentType?: string;
  size?: number;
};

const BASE64_CHUNK_SIZE = 0x8000;
export const MAX_IMAGE_FILE_BYTES = 14 * 1024 * 1024;

export async function uploadImageFile(
  file: File,
  options?: { hostId?: string; documentPath?: string }
): Promise<string> {
  if (file.size > MAX_IMAGE_FILE_BYTES) {
    throw new Error('图片过大，请使用 14MB 以内的图片。');
  }

  const sourcePath = await writeBrowserFileToNativeTemp(file);
  const result = await sendBridgeRequest<ImageUploadResult>('image:upload', {
    sourcePath,
    originalFileName: file.name || 'image.png',
    contentType: file.type || 'application/octet-stream',
    documentPath: options?.documentPath,
    hostId: options?.hostId
  });

  return result.markdownUrl;
}

export async function writeBrowserFileToNativeTemp(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const base64 = bytesToBase64(new Uint8Array(buffer));
  return sendBridgeRequest<string>('temp:writeFile', {
    originalFileName: file.name || 'image.png',
    base64
  });
}

export function firstImageFile(files: FileList | File[] | undefined | null): File | undefined {
  return Array.from(files ?? []).find((file) => file.type.startsWith('image/'));
}

export function escapeImageAlt(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

export function appendImageMarkdown(markdown: string, fileName: string, markdownUrl: string): string {
  const imageMarkdown = `![${escapeImageAlt(fileName)}](${markdownUrl})\n`;
  if (markdown.trim().length === 0) {
    return imageMarkdown;
  }

  const separator = markdown.endsWith('\n\n') ? '' : markdown.endsWith('\n') ? '\n' : '\n\n';
  return `${markdown}${separator}${imageMarkdown}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
