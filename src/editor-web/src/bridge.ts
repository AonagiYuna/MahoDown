type BridgePayload = Record<string, unknown>;

export type BridgeResponse<T> = {
  id: string;
  ok: boolean;
  payload?: T;
  errorCode?: string;
  errorMessage?: string;
};

declare global {
  interface Window {
    chrome?: {
      webview?: {
        postMessage: (message: unknown) => void;
        addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
        removeEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
      };
    };
    __TAURI_INTERNALS__?: unknown;
  }
}

function isBridgeResponse<T>(value: unknown): value is BridgeResponse<T> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const response = value as Partial<BridgeResponse<T>>;
  return typeof response.id === 'string' && typeof response.ok === 'boolean';
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

// Static import avoids a dynamic-import hop on every first bridge call (cold start).
import { invoke } from '@tauri-apps/api/core';

async function sendViaTauri<T>(command: string, payload: BridgePayload): Promise<T> {
  return invoke<T>('bridge_dispatch', { command, payload });
}

function sendViaWebView2<T>(command: string, payload: BridgePayload): Promise<T> {
  const webview = window.chrome?.webview;
  if (!webview) {
    return Promise.reject(new Error('Native bridge is unavailable (not Tauri / WebView2).'));
  }

  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('Bridge request timed out.'));
    }, 30_000);

    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      webview.removeEventListener('message', onMessage);
    };

    const onMessage = (event: MessageEvent) => {
      if (!isBridgeResponse<T>(event.data) || event.data.id !== id) {
        return;
      }
      cleanup();
      if (event.data.ok) {
        resolve(event.data.payload as T);
      } else {
        reject(new Error(event.data.errorMessage ?? event.data.errorCode ?? 'Bridge request failed.'));
      }
    };

    webview.addEventListener('message', onMessage);
    try {
      webview.postMessage({ id, command, payload });
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error('Bridge request could not be posted.'));
    }
  });
}

/** Host bridge: Tauri (primary) or legacy WebView2. */
export function sendBridgeRequest<T>(command: string, payload: BridgePayload = {}): Promise<T> {
  if (isTauri()) {
    return sendViaTauri<T>(command, payload);
  }
  return sendViaWebView2<T>(command, payload);
}
