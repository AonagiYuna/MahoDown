import './styles/app.css';
import './styles/code-theme.css';
import { sendBridgeRequest } from './bridge';
import type { RichEditor } from './editor/rich';
import type { SourceEditor } from './editor/source';
import {
  countWords,
  estimateReadMinutes,
  extractOutline,
  normalizeMarkdown,
  preloadHighlight,
  renderPreviewHtml,
  toStorageMarkdown
} from './editor/markdown';
import { clearAssetCache, collapseAssetUrls, expandImagesForDisplay } from './editor/assets';
import {
  findInMarkdown,
  groupSnapshotsByDay,
  replaceAllInMarkdown,
  replaceHitInMarkdown,
  simpleLineDiff,
  type SearchHit
} from './editor/search';
import { appendImageMarkdown, firstImageFile, uploadImageFile } from './imageUpload';

type EditorMode = 'src' | 'split' | 'rich';
type SettingsTab =
  | 'general'
  | 'editor'
  | 'theme'
  | 'ai'
  | 'image'
  | 'export'
  | 'plugins'
  | 'shortcuts'
  | 'history';
type RecentItem = { filePath: string; fileName: string; lastWriteTime: string };
type HostConfigs = Record<string, Record<string, string>>;
type SnapshotItem = {
  id: string;
  targetFilePath?: string | null;
  createdAt: string;
  wordCount: number;
  kind: string;
};

type AppState = {
  view: 'welcome' | 'editor';
  mode: EditorMode;
  focus: boolean;
  theme: 'light' | 'dark';
  markdown: string;
  filePath?: string;
  isDirty: boolean;
  isReady: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  paletteOpen: boolean;
  paletteQuery: string;
  toast: string;
  recent: RecentItem[];
  defaultHost: string;
  hostConfigs: HostConfigs;
  pasteUploadImages: boolean;
  keepLocalOnUploadFailure: boolean;
  historyOpen: boolean;
  historyItems: SnapshotItem[];
  captionInset: number;
  uploading: boolean;
  menuOpen: boolean;
  showOutline: boolean;
  showStatus: boolean;
  themePreference: 'system' | 'light' | 'dark';
  fontSize: number;
  lineHeight: number;
  autoSnapshotMinutes: number;
  /** Chrome UI scale: fonts/icons in titlebar, outline, status (0.9–1.25) */
  uiScale: number;
  lineWidth: 'narrow' | 'standard' | 'full';
  defaultMode: EditorMode;
  autoPairBrackets: boolean;
  expandMarkdownOnCaret: boolean;
  stripPasteFormatting: boolean;
  autoSpaceCjk: boolean;
  lastSavedAt?: string;
  cursorLine: number;
  cursorCol: number;
  searchOpen: boolean;
  searchQuery: string;
  searchReplace: boolean;
  replaceQuery: string;
  searchIndex: number;
  searchCase: boolean;
  historyDiffId?: string;
  historyDiffText?: string;
  aiBaseUrl: string;
  aiModel: string;
  aiApiKey: string;
  hasAiKey: boolean;
  aiBusy: boolean;
  aiPanelOpen: boolean;
  aiChat: { role: 'user' | 'assistant'; content: string }[];
  aiChatBusy: boolean;
  aiChatModel: string;
  aiPendingDoc: string | null;
  aiChatInput: string;
  updateDialog: UpdateCheckResult | null;
};

type UpdateCheckResult = {
  ok?: boolean;
  configured?: boolean;
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  message?: string;
  htmlUrl?: string;
  downloadUrl?: string | null;
  notes?: string;
  repoUrl?: string;
  releasesUrl?: string;
  releaseName?: string;
  tagName?: string;
};

const DEFAULT_MARKDOWN = `# MahoDown

小巧精致的 Markdown 编辑器。

- 源码 / 分屏 / 富文本
- 图床与本地图片
- 专注写作

开始写下你的第一段文字吧。
`;

const HOSTS = [
  { id: 'local', title: '本地相对路径', desc: '拷贝到 ./img 目录' },
  { id: 'github', title: 'GitHub', desc: '仓库 + jsDelivr CDN' },
  { id: 'picgo', title: 'PicGo', desc: '调用本机 PicGo' },
  { id: 's3', title: '对象存储', desc: 'OSS · COS · S3' },
  { id: 'smms', title: 'SM.MS', desc: '免费图床' },
  { id: 'custom', title: '自定义 API', desc: 'POST 表单/JSON' }
] as const;

const state: AppState = {
  view: 'welcome',
  mode: 'rich',
  focus: false,
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  markdown: DEFAULT_MARKDOWN,
  isDirty: false,
  isReady: false,
  settingsOpen: false,
  settingsTab: 'image',
  paletteOpen: false,
  paletteQuery: '',
  toast: '',
  recent: [],
  defaultHost: 'local',
  hostConfigs: {},
  pasteUploadImages: true,
  keepLocalOnUploadFailure: true,
  historyOpen: false,
  historyItems: [],
  captionInset: 138,
  uploading: false,
  menuOpen: false,
  showOutline: true,
  showStatus: true,
  themePreference: 'system',
  fontSize: 15,
  lineHeight: 1.9,
  autoSnapshotMinutes: 30,
  uiScale: 1,
  lineWidth: 'standard',
  defaultMode: 'rich',
  autoPairBrackets: true,
  expandMarkdownOnCaret: true,
  stripPasteFormatting: true,
  autoSpaceCjk: false,
  cursorLine: 1,
  cursorCol: 1,
  searchOpen: false,
  searchQuery: '',
  searchReplace: false,
  replaceQuery: '',
  searchIndex: 0,
  searchCase: false,
  aiBaseUrl: 'https://api.deepseek.com/v1',
  aiModel: 'deepseek-chat',
  aiApiKey: '',
  hasAiKey: false,
  aiBusy: false,
  aiPanelOpen: false,
  aiChat: [],
  aiChatBusy: false,
  aiChatModel: '',
  aiPendingDoc: null,
  aiChatInput: '',
  updateDialog: null
};

const appRoot = document.querySelector<HTMLElement>('#app');
if (!appRoot) {
  throw new Error('App root missing');
}
const app = appRoot;

let rich: RichEditor | undefined;
let richRoot: HTMLElement | undefined;
let source: SourceEditor | undefined;
let sourceRoot: HTMLElement | undefined;
let suppressRichChange = false;
let suppressSourceChange = false;
let toastTimer = 0;
let dirtyQueued = false;
let saveInFlight = false;
let suppressDirtyUntil = 0;
let richContentToken = 0;
let autoSnapshotTimer = 0;
/** Canonical saved content; dirty = current storage markdown !== this. */
let lastSavedMarkdown = normalizeMarkdown('');

function hatSvg(size = 24): string {
  // Small titlebar mark uses pure white strokes (design 4b 11px mark).
  if (size <= 12) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"><path d="M2.8 16.8c3-1.5 6.3-2.3 9.2-2.3s6.2.8 9.2 2.3"/><path d="M8.9 14.7C9.4 10.8 10.4 7.3 12.3 4.9"/><path d="M15.1 14.7c-.2-2.4-.5-4.2-1.3-6.1"/><path d="M12.3 4.9c.3 1.6 1.5 1.9 3.4 1.2-.8 1.4-.5 2.2.9 2.7-1.5.3-2.4-.1-2.8-.7"/></svg>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-linejoin="round" stroke-linecap="round"><path d="M2.8 16.8c3-1.5 6.3-2.3 9.2-2.3s6.2.8 9.2 2.3" stroke="#ffffff" stroke-width="1.7"/><path d="M8.9 14.7C9.4 10.8 10.4 7.3 12.3 4.9" stroke="#ffffff" stroke-width="1.7"/><path d="M15.1 14.7c-.2-2.4-.5-4.2-1.3-6.1" stroke="#ffffff" stroke-width="1.7"/><path d="M12.3 4.9c.3 1.6 1.5 1.9 3.4 1.2-.8 1.4-.5 2.2.9 2.7-1.5.3-2.4-.1-2.8-.7" stroke="#ffffff" stroke-width="1.7"/><path d="M8.4 12.5c2.4.9 5 .9 7.2.1" stroke="#e4dcff" stroke-width="1.5"/><line x1="16.7" y1="9.2" x2="17.1" y2="11" stroke="#ffd98a" stroke-width="1.2"/><circle cx="17.3" cy="12.4" r="1.3" stroke="#ffd98a" stroke-width="1.2"/></svg>`;
}

function bookSvg(): string {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M12 6.5C9.5 5 6.5 5 4.5 5.8V18c2-.8 5-.8 7.5.7 2.5-1.5 5.5-1.5 7.5-.7V5.8C17.5 5 14.5 5 12 6.5Z"/><line x1="12" y1="6.5" x2="12" y2="18.7"/></svg>`;
}

/** Custom window chrome (Tauri decorations:false). */
const MAXIMIZE_ICON =
  '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
// "Restore down": a front square with an L-shaped square peeking behind it (Windows convention).
const RESTORE_ICON =
  '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="1.3" y="3.2" width="5" height="5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 3.2V1.5h5v5H6.8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

// Tracks the real window state so the maximize button shows the correct icon
// across re-renders (windowControlsHtml is rebuilt on every render()).
let windowMaximized = false;

function windowControlsHtml(): string {
  const maxTitle = windowMaximized ? '向下还原' : '最大化';
  return `
    <div class="win-controls" role="group" aria-label="窗口">
      <button type="button" class="win-btn" data-win="minimize" title="最小化" aria-label="最小化">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 5h8" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
      <button type="button" class="win-btn" data-win="maximize" title="${maxTitle}" aria-label="${maxTitle}">
        ${windowMaximized ? RESTORE_ICON : MAXIMIZE_ICON}
      </button>
      <button type="button" class="win-btn win-close" data-win="close" title="关闭" aria-label="关闭">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
    </div>`;
}

/** Sync the maximize/restore button icon (and tooltip) with the actual window state. */
async function refreshMaximizeIcon(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    windowMaximized = await getCurrentWindow().isMaximized();
  } catch {
    return; // browser / no window API
  }
  const icon = windowMaximized ? RESTORE_ICON : MAXIMIZE_ICON;
  const title = windowMaximized ? '向下还原' : '最大化';
  document.querySelectorAll<HTMLElement>('[data-win="maximize"]').forEach((btn) => {
    btn.innerHTML = icon;
    btn.title = title;
    btn.setAttribute('aria-label', title);
  });
}

async function handleWindowControl(action: string): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (action === 'minimize') {
      await win.minimize();
    } else if (action === 'maximize') {
      await win.toggleMaximize();
      await refreshMaximizeIcon();
    } else if (action === 'close') {
      await win.close();
    }
  } catch {
    // Not Tauri / permission missing
  }
}

/** IDEA-like: compact welcome window, larger editor window. Only on view switch. */
let lastLayoutView: 'welcome' | 'editor' | null = null;
async function applyWindowLayoutForView(view: 'welcome' | 'editor'): Promise<void> {
  if (lastLayoutView === view) {
    return;
  }
  lastLayoutView = view;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const { LogicalSize } = await import('@tauri-apps/api/dpi');
    const win = getCurrentWindow();
    const maximized = await win.isMaximized();
    // Never resize/recenter while maximized — that causes the "jump" when clicking chrome.
    if (maximized) {
      return;
    }
    if (view === 'welcome') {
      await win.setSize(new LogicalSize(720, 520));
      await win.setMinSize(new LogicalSize(640, 460));
      await win.center();
    } else {
      await win.setMinSize(new LogicalSize(800, 520));
      const factor = await win.scaleFactor();
      const size = await win.innerSize();
      const logicalW = size.width / factor;
      const logicalH = size.height / factor;
      if (logicalW < 1000 || logicalH < 600) {
        await win.setSize(new LogicalSize(1180, 760));
        await win.center();
      }
    }
  } catch {
    // browser / no window API
  }
}

const BOOT_CACHE_KEY = 'maho.bootCache';

function readBootCache(): {
  theme?: string;
  mode?: string;
  uiScale?: number;
  fontSize?: number;
  lineHeight?: number;
  lineWidth?: string;
} {
  try {
    return JSON.parse(localStorage.getItem(BOOT_CACHE_KEY) || '{}') as {
      theme?: string;
      mode?: string;
      uiScale?: number;
      fontSize?: number;
      lineHeight?: number;
      lineWidth?: string;
    };
  } catch {
    return {};
  }
}

function writeBootCache(): void {
  try {
    localStorage.setItem(
      BOOT_CACHE_KEY,
      JSON.stringify({
        theme: state.themePreference,
        mode: state.defaultMode || state.mode,
        uiScale: state.uiScale,
        fontSize: state.fontSize,
        lineHeight: state.lineHeight,
        lineWidth: state.lineWidth
      })
    );
  } catch {
    // private mode / quota
  }
}

function applyBootCache(): void {
  const c = readBootCache();
  if (c.theme === 'system' || c.theme === 'dark' || c.theme === 'light') {
    state.themePreference = c.theme;
  }
  if (c.mode === 'src' || c.mode === 'split' || c.mode === 'rich') {
    state.mode = c.mode;
    state.defaultMode = c.mode;
  }
  if (typeof c.uiScale === 'number' && c.uiScale >= 0.85 && c.uiScale <= 1.3) {
    state.uiScale = c.uiScale;
  }
  if (typeof c.fontSize === 'number' && c.fontSize >= 12 && c.fontSize <= 24) {
    state.fontSize = c.fontSize;
  }
  if (typeof c.lineHeight === 'number' && c.lineHeight >= 1.2 && c.lineHeight <= 2.4) {
    state.lineHeight = c.lineHeight;
  }
  if (c.lineWidth === 'narrow' || c.lineWidth === 'standard' || c.lineWidth === 'full') {
    state.lineWidth = c.lineWidth;
  }
}

function applyTheme(): void {
  let resolved: 'light' | 'dark' = state.theme;
  if (state.themePreference === 'system') {
    resolved = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    resolved = state.themePreference;
  }
  state.theme = resolved;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.setProperty('--caption-inset', `${state.captionInset}px`);
  document.documentElement.style.setProperty('--editor-font-size', `${state.fontSize}px`);
  document.documentElement.style.setProperty('--editor-line-height', String(state.lineHeight));
  document.documentElement.style.setProperty('--ui-scale', String(state.uiScale));
  const prose =
    state.lineWidth === 'narrow' ? '520px' : state.lineWidth === 'full' ? '100%' : 'clamp(480px, 56vw, 920px)';
  document.documentElement.style.setProperty('--prose-w', prose);
}

function scheduleAutoSnapshot(): void {
  window.clearInterval(autoSnapshotTimer);
  const minutes = state.autoSnapshotMinutes;
  if (minutes <= 0) {
    return;
  }
  autoSnapshotTimer = window.setInterval(() => {
    if (state.view !== 'editor' || !state.isDirty) {
      return;
    }
    void saveHistorySnapshot('auto').catch(() => undefined);
  }, minutes * 60_000);
}

function setThemePreference(pref: 'system' | 'light' | 'dark'): void {
  state.themePreference = pref;
  if (pref === 'system') {
    state.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    state.theme = pref;
  }
  applyTheme();
  void persistSettings().catch(() => undefined);
}

function showToast(message: string, ms = 2200): void {
  state.toast = message;
  window.clearTimeout(toastTimer);
  // Update toast node in-place — never full re-render (that remounts Milkdown and re-dirties).
  let el = document.querySelector<HTMLElement>('[data-toast]');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.dataset.toast = '1';
    const host = document.querySelector('.main') ?? document.body;
    host.appendChild(el);
  }
  el.textContent = message;
  el.hidden = false;
  toastTimer = window.setTimeout(() => {
    state.toast = '';
    el.hidden = true;
  }, ms);
}

function currentStorageMarkdown(): string {
  return normalizeMarkdown(getCurrentMarkdown());
}

function recomputeDirty(forceNotify = false): boolean {
  const current = currentStorageMarkdown();
  const dirty = current !== lastSavedMarkdown;
  const changed = dirty !== state.isDirty;
  state.isDirty = dirty;
  updateSaveChrome();
  if (forceNotify || changed) {
    void sendBridgeRequest('app:setDirtyState', { isDirty: dirty }).catch(() => undefined);
  }
  return dirty;
}

function queueDirty(): void {
  if (Date.now() < suppressDirtyUntil) {
    return;
  }
  if (dirtyQueued) {
    return;
  }
  dirtyQueued = true;
  queueMicrotask(() => {
    dirtyQueued = false;
    if (Date.now() < suppressDirtyUntil) {
      return;
    }
    recomputeDirty(false);
  });
}

function markClean(savedMarkdown?: string): void {
  lastSavedMarkdown = normalizeMarkdown(savedMarkdown ?? getCurrentMarkdown());
  state.isDirty = false;
  state.lastSavedAt = new Date().toISOString();
  suppressDirtyUntil = Date.now() + 1500;
  void sendBridgeRequest('app:setDirtyState', { isDirty: false }).catch(() => undefined);
  updateSaveChrome();
  updateStatusExtras();
}

function updateStatusExtras(): void {
  const cursor = document.querySelector('[data-status-cursor]');
  if (cursor) {
    cursor.textContent = `行 ${state.cursorLine} · 列 ${state.cursorCol}`;
  }
  const saved = document.querySelector('[data-status-saved]');
  if (saved) {
    saved.textContent = state.lastSavedAt
      ? `保存 ${formatRelative(state.lastSavedAt)}`
      : '尚未保存';
  }
}

function trackCursorFromSource(): void {
  const ta = document.querySelector<HTMLTextAreaElement>('[data-source]');
  if (!ta) {
    return;
  }
  const pos = ta.selectionStart ?? 0;
  const before = ta.value.slice(0, pos);
  const lines = before.split('\n');
  state.cursorLine = lines.length;
  state.cursorCol = (lines[lines.length - 1] ?? '').length + 1;
  updateStatusExtras();
}

/** A doc counts as saved only once it lives on disk and has no pending edits. */
function isSavedToDisk(): boolean {
  return !!state.filePath && !state.isDirty;
}

function updateSaveChrome(): void {
  const saveState = document.querySelector('[data-save-state]');
  if (saveState) {
    saveState.textContent = isSavedToDisk() ? '✦ 已保存' : '✦ 未保存';
  }
}

async function applyRichMarkdown(
  storageMarkdown: string,
  options?: { acceptAsSaved?: boolean }
): Promise<void> {
  if (!rich || state.mode !== 'rich') {
    return;
  }
  const token = ++richContentToken;
  suppressRichChange = true;
  suppressDirtyUntil = Date.now() + 2000;
  try {
    const display = await expandImagesForDisplay(storageMarkdown);
    if (token !== richContentToken || !rich) {
      return;
    }
    rich.setMarkdown(display);
  } finally {
    window.setTimeout(() => {
      suppressRichChange = false;
      // Milkdown may normalize markdown on load; treat that as the clean baseline when opening/saving.
      if (options?.acceptAsSaved) {
        lastSavedMarkdown = currentStorageMarkdown();
        state.isDirty = false;
        updateSaveChrome();
        void sendBridgeRequest('app:setDirtyState', { isDirty: false }).catch(() => undefined);
      } else {
        recomputeDirty(true);
      }
    }, 250);
  }
}

function setMarkdown(markdown: string, options?: { dirty?: boolean; fromRich?: boolean; acceptAsSaved?: boolean }): void {
  // Always keep storage form (relative image paths) in state.
  state.markdown = collapseAssetUrls(toStorageMarkdown(markdown));
  if (options?.dirty) {
    queueDirty();
  } else if (options?.acceptAsSaved) {
    lastSavedMarkdown = normalizeMarkdown(state.markdown);
    state.isDirty = false;
  }
  if (!options?.fromRich && rich && state.mode === 'rich') {
    void applyRichMarkdown(state.markdown, { acceptAsSaved: options?.acceptAsSaved });
  }
  if (!options?.fromRich && source && (state.mode === 'src' || state.mode === 'split')) {
    suppressSourceChange = true;
    source.setMarkdown(state.markdown);
    suppressSourceChange = false;
  }
}

function fileName(): string {
  if (!state.filePath) {
    return '未命名.md';
  }
  const parts = state.filePath.split(/[/\\]/);
  return parts[parts.length - 1] || '未命名.md';
}

function modeLabel(): string {
  if (state.mode === 'src') return '源码';
  if (state.mode === 'split') return '分屏';
  return '富文本';
}

async function loadRecent(): Promise<void> {
  try {
    const result = await sendBridgeRequest<{ items: RecentItem[] }>('app:getRecentFiles', {});
    state.recent = result.items ?? [];
  } catch {
    state.recent = [];
  }
}

type SettingsPayload = {
  defaultImageHost?: string;
  imageHostConfigs?: HostConfigs;
  pasteUploadImages?: boolean;
  keepLocalOnUploadFailure?: boolean;
  theme?: string;
  defaultMode?: string;
  fontSize?: number;
  lineHeight?: number;
  autoSnapshotMinutes?: number;
  uiScale?: number;
  lineWidth?: string;
  autoPairBrackets?: boolean;
  expandMarkdownOnCaret?: boolean;
  stripPasteFormatting?: boolean;
  autoSpaceCjk?: boolean;
  aiBaseUrl?: string;
  aiModel?: string;
  aiApiKey?: string;
  hasAiKey?: boolean;
};

function applySettingsObject(settings: SettingsPayload, opts?: { forceMode?: boolean }): void {
  state.defaultHost = settings.defaultImageHost ?? state.defaultHost;
  state.hostConfigs = settings.imageHostConfigs ?? state.hostConfigs;
  state.pasteUploadImages = settings.pasteUploadImages ?? true;
  state.keepLocalOnUploadFailure = settings.keepLocalOnUploadFailure ?? true;
  if (settings.theme === 'system' || settings.theme === 'dark' || settings.theme === 'light') {
    state.themePreference = settings.theme;
  }
  if (settings.defaultMode === 'src' || settings.defaultMode === 'split' || settings.defaultMode === 'rich') {
    state.defaultMode = settings.defaultMode;
    if (opts?.forceMode || state.view === 'welcome') {
      state.mode = settings.defaultMode;
    }
  }
  if (typeof settings.fontSize === 'number' && settings.fontSize >= 12 && settings.fontSize <= 24) {
    state.fontSize = settings.fontSize;
  }
  if (typeof settings.lineHeight === 'number' && settings.lineHeight >= 1.2 && settings.lineHeight <= 2.4) {
    state.lineHeight = settings.lineHeight;
  }
  if (typeof settings.autoSnapshotMinutes === 'number' && settings.autoSnapshotMinutes >= 0) {
    state.autoSnapshotMinutes = settings.autoSnapshotMinutes;
  }
  if (typeof settings.uiScale === 'number' && settings.uiScale >= 0.85 && settings.uiScale <= 1.3) {
    state.uiScale = settings.uiScale;
  }
  if (settings.lineWidth === 'narrow' || settings.lineWidth === 'standard' || settings.lineWidth === 'full') {
    state.lineWidth = settings.lineWidth;
  }
  if (typeof settings.autoPairBrackets === 'boolean') state.autoPairBrackets = settings.autoPairBrackets;
  if (typeof settings.expandMarkdownOnCaret === 'boolean') {
    state.expandMarkdownOnCaret = settings.expandMarkdownOnCaret;
  }
  if (typeof settings.stripPasteFormatting === 'boolean') {
    state.stripPasteFormatting = settings.stripPasteFormatting;
  }
  if (typeof settings.autoSpaceCjk === 'boolean') state.autoSpaceCjk = settings.autoSpaceCjk;
  if (typeof settings.aiBaseUrl === 'string' && settings.aiBaseUrl) state.aiBaseUrl = settings.aiBaseUrl;
  if (typeof settings.aiModel === 'string' && settings.aiModel) state.aiModel = settings.aiModel;
  if (typeof settings.aiApiKey === 'string') state.aiApiKey = settings.aiApiKey;
  if (typeof settings.hasAiKey === 'boolean') state.hasAiKey = settings.hasAiKey;
  scheduleAutoSnapshot();
  writeBootCache();
}

async function loadSettings(): Promise<void> {
  try {
    const settings = await sendBridgeRequest<SettingsPayload>('app:getSettings', {});
    applySettingsObject(settings);
  } catch {
    // keep defaults
  }
}

function hostConfig(hostId: string): Record<string, string> {
  return state.hostConfigs[hostId] ?? {};
}

function setHostField(hostId: string, key: string, value: string): void {
  state.hostConfigs = {
    ...state.hostConfigs,
    [hostId]: {
      ...hostConfig(hostId),
      [key]: value
    }
  };
}

async function persistSettings(): Promise<void> {
  await sendBridgeRequest('app:updateSettings', {
    theme: state.themePreference,
    defaultMode: state.defaultMode,
    defaultImageHost: state.defaultHost,
    pasteUploadImages: state.pasteUploadImages,
    keepLocalOnUploadFailure: state.keepLocalOnUploadFailure,
    imageHostConfigs: state.hostConfigs,
    fontSize: state.fontSize,
    lineHeight: state.lineHeight,
    lineWidth: state.lineWidth,
    autoPairBrackets: state.autoPairBrackets,
    expandMarkdownOnCaret: state.expandMarkdownOnCaret,
    stripPasteFormatting: state.stripPasteFormatting,
    autoSpaceCjk: state.autoSpaceCjk,
    autoSnapshotMinutes: state.autoSnapshotMinutes,
    followSystemAccent: true,
    uiScale: state.uiScale,
    aiBaseUrl: state.aiBaseUrl,
    aiModel: state.aiModel,
    aiApiKey: state.aiApiKey,
    recentFiles: []
  });
}

function getEditorSelection(): string {
  if ((state.mode === 'src' || state.mode === 'split') && source) {
    try {
      const s = source.getSelection();
      if (s) return s;
    } catch {
      // fall through
    }
  }
  return window.getSelection()?.toString() ?? '';
}

function replaceEditorSelection(replacement: string): void {
  if ((state.mode === 'src' || state.mode === 'split') && source) {
    try {
      source.replaceSelection(replacement);
      state.markdown = source.getMarkdown();
      recomputeDirty(true);
      scheduleOutlineRefresh();
      return;
    } catch {
      // fall through
    }
  }
  const selected = window.getSelection()?.toString() ?? '';
  const full = getCurrentMarkdown();
  if (selected && full.includes(selected)) {
    const next = full.replace(selected, replacement);
    void applyContentReplace(next);
    return;
  }
  // No selection: append for continue
  const next = full.endsWith('\n') ? `${full}${replacement}\n` : `${full}\n\n${replacement}\n`;
  void applyContentReplace(next);
}

async function applyContentReplace(next: string): Promise<void> {
  state.markdown = normalizeMarkdown(next);
  if (state.mode === 'rich') {
    await applyRichMarkdown(state.markdown);
  } else if (source) {
    suppressSourceChange = true;
    source.setMarkdown(state.markdown);
    suppressSourceChange = false;
  }
  recomputeDirty(true);
  scheduleOutlineRefresh();
  renderStatusAndOutline();
}

/** Build full-doc markdown after a selection-level AI edit (or append for continue). */
function previewDocAfterAiEdit(action: 'polish' | 'continue' | 'translate', content: string): string {
  const full = getCurrentMarkdown();
  if (action === 'continue') {
    return normalizeMarkdown(full.endsWith('\n') ? `${full}${content}\n` : `${full}\n\n${content}\n`);
  }
  const selected = getEditorSelection();
  if (selected && full.includes(selected)) {
    return normalizeMarkdown(full.replace(selected, content));
  }
  // Fallback: append if we lost the selection
  return normalizeMarkdown(full.endsWith('\n') ? `${full}${content}\n` : `${full}\n\n${content}\n`);
}

async function runAiAction(action: 'polish' | 'continue' | 'translate'): Promise<void> {
  if (state.view !== 'editor') {
    showToast('请先打开文档');
    return;
  }
  if (state.aiBusy || state.aiChatBusy) {
    return;
  }
  if (!state.hasAiKey && !state.aiApiKey) {
    state.settingsOpen = true;
    state.settingsTab = 'ai';
    render();
    showToast('请先配置 AI API Key（DeepSeek 等）');
    return;
  }

  const selected = getEditorSelection().trim();
  const full = getCurrentMarkdown();
  if (action === 'polish' || action === 'translate') {
    if (!selected) {
      showToast(action === 'polish' ? '请先选中要润色的文字' : '请先选中要翻译的文字');
      return;
    }
  }

  const context =
    action === 'continue'
      ? selected || full.slice(Math.max(0, full.length - 2500))
      : full.slice(Math.max(0, full.length - 800));

  const labels = { polish: '润色', continue: '续写', translate: '翻译' } as const;
  const userPrompt =
    action === 'continue'
      ? '请续写下一段'
      : action === 'polish'
        ? `请润色选中内容：\n${selected.slice(0, 200)}${selected.length > 200 ? '…' : ''}`
        : `请翻译选中内容：\n${selected.slice(0, 200)}${selected.length > 200 ? '…' : ''}`;

  // Show work in the side panel with review — never silent apply.
  state.aiPanelOpen = true;
  if (!state.aiChatModel) state.aiChatModel = state.aiModel;
  state.aiChat.push({ role: 'user', content: userPrompt });
  state.aiChatBusy = true;
  state.aiBusy = true;
  render();
  scrollAiToBottom();

  try {
    if (state.aiApiKey && state.aiApiKey !== '********') {
      await persistSettings();
    }
    const result = await sendBridgeRequest<{ content: string }>('ai:complete', {
      action,
      text: selected,
      context
    });
    const content = (result.content ?? '').trim();
    if (!content) {
      state.aiChat.push({ role: 'assistant', content: 'AI 未返回内容' });
      return;
    }
    const nextDoc = previewDocAfterAiEdit(action, content);
    state.aiChat.push({
      role: 'assistant',
      content: `已完成${labels[action]}。下方用绿/红标出与当前文档的差异，确认后点「接受改动」。`
    });
    if (normalizeMarkdown(nextDoc) !== normalizeMarkdown(getCurrentMarkdown())) {
      state.aiPendingDoc = nextDoc;
    } else {
      state.aiChat.push({ role: 'assistant', content: '（与当前文档无差异）' });
    }
  } catch (error) {
    state.aiChat.push({
      role: 'assistant',
      content: '⚠ ' + (error instanceof Error ? error.message : 'AI 请求失败')
    });
  } finally {
    state.aiBusy = false;
    state.aiChatBusy = false;
    render();
    scrollAiToBottom();
  }
}

// ---- AI chat side panel: talk to the model, review its edits, accept/reject ----

function currentChatModel(): string {
  return (state.aiChatModel || state.aiModel || 'deepseek-chat').trim();
}

function openAiPanel(): void {
  if (state.view !== 'editor') {
    showToast('请先打开文档');
    return;
  }
  state.aiPanelOpen = true;
  if (!state.aiChatModel) state.aiChatModel = state.aiModel;
  render();
  setTimeout(() => app.querySelector<HTMLTextAreaElement>('[data-ai-input]')?.focus(), 30);
}

function toggleAiPanel(): void {
  if (state.aiPanelOpen) {
    state.aiPanelOpen = false;
    render();
  } else {
    openAiPanel();
  }
}

function scrollAiToBottom(): void {
  setTimeout(() => {
    const el = app.querySelector('[data-ai-scroll]');
    if (el) el.scrollTop = el.scrollHeight;
  }, 20);
}

/** Minimal line-level LCS diff for the change-review pane. */
function computeLineDiff(
  oldText: string,
  newText: string
): { type: 'same' | 'add' | 'del'; text: string }[] {
  const a = oldText.replace(/\r\n/g, '\n').split('\n');
  const b = newText.replace(/\r\n/g, '\n').split('\n');
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: { type: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] });
      i++;
    } else {
      rows.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ type: 'del', text: a[i++] });
  while (j < m) rows.push({ type: 'add', text: b[j++] });
  return rows;
}

function diffRowHtml(r: { type: string; text: string }): string {
  const sign = r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ';
  return `<div class="ai-diff-row ${r.type}"><span class="ai-diff-sign">${sign}</span><span class="ai-diff-text">${escapeHtml(r.text) || '&nbsp;'}</span></div>`;
}

function renderDiffHtml(oldText: string, newText: string): string {
  const rows = computeLineDiff(oldText, newText);
  const adds = rows.filter((r) => r.type === 'add').length;
  const dels = rows.filter((r) => r.type === 'del').length;
  const parts: string[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type === 'same') {
      let j = i;
      while (j < rows.length && rows[j].type === 'same') j++;
      const run = rows.slice(i, j);
      if (run.length > 4) {
        parts.push(diffRowHtml(run[0]));
        parts.push(`<div class="ai-diff-fold">⋯ ${run.length - 2} 行未改动 ⋯</div>`);
        parts.push(diffRowHtml(run[run.length - 1]));
      } else {
        run.forEach((r) => parts.push(diffRowHtml(r)));
      }
      i = j;
    } else {
      parts.push(diffRowHtml(rows[i]));
      i++;
    }
  }
  return `<div class="ai-diff-head">改动 <b class="add">+${adds}</b> <b class="del">−${dels}</b> 行</div><div class="ai-diff-body">${parts.join('')}</div>`;
}

function renderAiPanel(): string {
  const msgs = state.aiChat
    .map(
      (msg) =>
        `<div class="ai-msg ${msg.role}">${escapeHtml(msg.content).replace(/\n/g, '<br>')}</div>`
    )
    .join('');
  const busy = state.aiChatBusy ? `<div class="ai-msg assistant ai-typing">AI 思考中…</div>` : '';
  const pending =
    state.aiPendingDoc != null
      ? `<div class="ai-review">
           <div class="ai-review-label">文档改动预览（未写入，需手动接受）</div>
           ${renderDiffHtml(getCurrentMarkdown(), state.aiPendingDoc)}
           <div class="ai-review-actions">
             <button type="button" class="btn-primary" data-ai-accept>✦ 接受改动</button>
             <button type="button" class="btn-secondary" data-ai-reject>放弃</button>
           </div>
         </div>`
      : '';
  const empty =
    state.aiChat.length === 0 && !state.aiChatBusy
      ? `<div class="ai-empty">和 AI 聊聊这篇文档，让它帮你改：<br>· “把第二段润色一下”<br>· “给全文加个结尾总结”<br>· “标题换个更抓人的”<br><br>它<strong>不会直接改文档</strong>：改动用<span class="add">绿</span>/<span class="del">红</span>标出，你点「接受」后才写入。</div>`
      : '';
  const modelVal = escapeHtml(currentChatModel());
  return `
  <aside class="ai-panel" aria-label="AI 助手">
    <div class="ai-panel-head">
      <span class="ai-panel-title">✦ AI 助手</span>
      <label class="ai-model-wrap" title="本会话模型（Key/服务商仍用设置 → AI）">
        <span class="ai-model-label">模型</span>
        <select class="ai-model" data-ai-model>
          ${['deepseek-chat', 'deepseek-reasoner', 'gpt-4o-mini', 'gpt-4o', 'moonshot-v1-8k', 'qwen2.5', state.aiModel]
            .filter((v, i, a) => v && a.indexOf(v) === i)
            .map(
              (m) =>
                `<option value="${escapeHtml(m)}" ${m === currentChatModel() ? 'selected' : ''}>${escapeHtml(m)}</option>`
            )
            .join('')}
        </select>
      </label>
      <input class="ai-model-custom" data-ai-model-custom list="ai-model-list" value="${modelVal}" placeholder="或输入模型名" spellcheck="false" />
      <datalist id="ai-model-list">
        <option value="deepseek-chat"></option>
        <option value="deepseek-reasoner"></option>
        <option value="gpt-4o"></option>
        <option value="gpt-4o-mini"></option>
        <option value="moonshot-v1-8k"></option>
        <option value="qwen2.5"></option>
      </datalist>
      <button type="button" class="ai-panel-close" data-ai-close title="关闭">×</button>
    </div>
    <div class="ai-panel-body" data-ai-scroll>
      ${empty}${msgs}${busy}${pending}
    </div>
    <div class="ai-panel-input">
      <textarea data-ai-input rows="2" placeholder="让 AI 帮你改文档 · Enter 发送 / Shift+Enter 换行">${escapeHtml(state.aiChatInput)}</textarea>
      <button type="button" class="btn-primary ai-send" data-ai-send ${state.aiChatBusy ? 'disabled' : ''}>发送</button>
    </div>
  </aside>`;
}

async function sendAiChat(): Promise<void> {
  const text = state.aiChatInput.trim();
  if (!text || state.aiChatBusy) return;
  if (!state.hasAiKey && !state.aiApiKey) {
    state.settingsOpen = true;
    state.settingsTab = 'ai';
    render();
    showToast('请先在设置 → AI 配置 API Key');
    return;
  }
  state.aiChat.push({ role: 'user', content: text });
  state.aiChatInput = '';
  state.aiChatBusy = true;
  render();
  scrollAiToBottom();
  try {
    if (state.aiApiKey && state.aiApiKey !== '********') await persistSettings();
    const res = await sendBridgeRequest<{ reply: string; document: string | null }>('ai:chat', {
      messages: state.aiChat.map((m) => ({ role: m.role, content: m.content })),
      document: getCurrentMarkdown(),
      model: currentChatModel()
    });
    const reply = (res.reply ?? '').trim() || '（已处理）';
    state.aiChat.push({ role: 'assistant', content: reply });
    const doc = res.document;
    if (doc != null && normalizeMarkdown(doc) !== normalizeMarkdown(getCurrentMarkdown())) {
      state.aiPendingDoc = normalizeMarkdown(doc);
    }
  } catch (error) {
    state.aiChat.push({
      role: 'assistant',
      content: '⚠ ' + (error instanceof Error ? error.message : 'AI 请求失败')
    });
  } finally {
    state.aiChatBusy = false;
    render();
    scrollAiToBottom();
  }
}

async function acceptAiEdit(): Promise<void> {
  if (state.aiPendingDoc == null) return;
  const doc = state.aiPendingDoc;
  state.aiPendingDoc = null;
  await applyContentReplace(doc);
  showToast('✦ 已应用 AI 改动');
  render();
  scrollAiToBottom();
}

function rejectAiEdit(): void {
  state.aiPendingDoc = null;
  render();
  scrollAiToBottom();
}

function bindAiPanel(): void {
  if (!state.aiPanelOpen) return;
  const input = app.querySelector<HTMLTextAreaElement>('[data-ai-input]');
  if (input) {
    input.addEventListener('input', () => {
      state.aiChatInput = input.value;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        state.aiChatInput = input.value;
        void sendAiChat();
      }
    });
  }
  app.querySelector('[data-ai-send]')?.addEventListener('click', () => void sendAiChat());
  app.querySelector('[data-ai-close]')?.addEventListener('click', () => {
    state.aiPanelOpen = false;
    render();
  });
  app.querySelector('[data-ai-accept]')?.addEventListener('click', () => void acceptAiEdit());
  app.querySelector('[data-ai-reject]')?.addEventListener('click', () => rejectAiEdit());
  const modelSel = app.querySelector<HTMLSelectElement>('select[data-ai-model]');
  const modelCustom = app.querySelector<HTMLInputElement>('[data-ai-model-custom]');
  modelSel?.addEventListener('change', () => {
    const v = modelSel.value.trim();
    if (v) {
      state.aiChatModel = v;
      if (modelCustom) modelCustom.value = v;
    }
  });
  modelCustom?.addEventListener('change', () => {
    const v = modelCustom.value.trim();
    if (v) {
      state.aiChatModel = v;
      if (modelSel && [...modelSel.options].some((o) => o.value === v)) {
        modelSel.value = v;
      }
    }
  });
}

async function persistSecret(hostId: string, key: string, value: string): Promise<void> {
  if (!value || value === '********') {
    return;
  }
  await sendBridgeRequest('app:setSecret', { hostId, key, value });
}

async function insertImageFromFile(file: File): Promise<void> {
  if (!state.filePath) {
    showToast('请先保存 Markdown 文件，再插入图片');
    return;
  }
  if (state.uploading) {
    return;
  }

  state.uploading = true;
  showToast('正在上传图片…', 8000);
  try {
    let hostUsed = state.defaultHost;
    let url: string;
    try {
      url = await uploadImageFile(file, {
        hostId: state.defaultHost,
        documentPath: state.filePath
      });
    } catch (error) {
      if (state.keepLocalOnUploadFailure && state.defaultHost !== 'local') {
        url = await uploadImageFile(file, {
          hostId: 'local',
          documentPath: state.filePath
        });
        hostUsed = 'local';
        showToast(
          `远程失败，已保留本地副本（${error instanceof Error ? error.message : '上传失败'}）`,
          3600
        );
      } else {
        throw error;
      }
    }
    const next = appendImageMarkdown(getCurrentMarkdown(), file.name || 'image.png', url);
    state.markdown = next;
    await applyRichMarkdown(next);
    recomputeDirty(true);
    renderStatusAndOutline();
    if (hostUsed === state.defaultHost) {
      showToast(`✦ 已上传 → ${HOSTS.find((h) => h.id === hostUsed)?.title ?? hostUsed}`);
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : '图片上传失败');
  } finally {
    state.uploading = false;
  }
}

function isLocalImageUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || /^(https?:|data:|blob:)/i.test(trimmed)) {
    return false;
  }
  return true;
}

function collectLocalImageRefs(markdown: string): Array<{ alt: string; url: string; fileName: string }> {
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const seen = new Set<string>();
  const items: Array<{ alt: string; url: string; fileName: string }> = [];
  for (const match of markdown.matchAll(re)) {
    const alt = match[1] ?? '';
    const raw = (match[2] ?? '').trim();
    if (!isLocalImageUrl(raw)) {
      continue;
    }
    const url = raw.replace(/^\.\//, '').replace(/\\/g, '/');
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    const fileName = url.split('/').pop() || alt || 'image.png';
    items.push({ alt, url, fileName });
  }
  return items;
}

async function uploadRelativeLocalImage(
  relativePath: string,
  fileName: string,
  hostId: string
): Promise<string> {
  const asset = await sendBridgeRequest<{ dataUrl: string }>('file:readAsset', {
    relativePath
  });
  const dataUrl = asset?.dataUrl ?? '';
  const parsed = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
  if (!parsed) {
    throw new Error(`无法读取本地图片：${relativePath}`);
  }
  const contentType = parsed[1] || 'application/octet-stream';
  const base64 = parsed[2] || '';
  const sourcePath = await sendBridgeRequest<string>('temp:writeFile', {
    originalFileName: fileName,
    base64
  });
  const result = await sendBridgeRequest<{ markdownUrl: string }>('image:upload', {
    sourcePath,
    originalFileName: fileName,
    contentType,
    documentPath: state.filePath,
    hostId
  });
  if (!result?.markdownUrl) {
    throw new Error('图床未返回地址');
  }
  return result.markdownUrl;
}

async function uploadAllLocalImages(): Promise<void> {
  if (!state.filePath) {
    showToast('请先保存 Markdown 文件');
    return;
  }
  if (state.defaultHost === 'local') {
    showToast('当前图床为本地，请先在设置中选择远程图床');
    return;
  }
  if (state.uploading) {
    return;
  }

  const markdown = getCurrentMarkdown();
  const locals = collectLocalImageRefs(markdown);
  if (locals.length === 0) {
    showToast('文档中没有本地图片');
    return;
  }

  state.uploading = true;
  showToast(`正在上传 ${locals.length} 张本地图片…`, 12_000);
  let next = markdown;
  let ok = 0;
  let failed = 0;
  try {
    for (const item of locals) {
      try {
        const remoteUrl = await uploadRelativeLocalImage(item.url, item.fileName, state.defaultHost);
        const escaped = item.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        next = next.replace(
          new RegExp(`(!\\[[^\\]]*\\]\\()(?:\\./)?${escaped}((?:\\s+"[^"]*")?\\))`, 'g'),
          `$1${remoteUrl}$2`
        );
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    if (ok > 0) {
      state.markdown = next;
      await applyRichMarkdown(next);
      recomputeDirty(true);
      renderStatusAndOutline();
    }
    if (failed === 0) {
      showToast(`✦ 已上传 ${ok} 张 → ${HOSTS.find((h) => h.id === state.defaultHost)?.title ?? state.defaultHost}`);
    } else {
      showToast(`上传完成：成功 ${ok}，失败 ${failed}`);
    }
  } finally {
    state.uploading = false;
  }
}

function collectEditorHeadings(): HTMLElement[] {
  const root =
    state.mode === 'rich'
      ? document.querySelector('.milkdown-host .ProseMirror')
      : document.querySelector('[data-preview]');
  if (!root) {
    return [];
  }
  return Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')).filter(
    (el) => !el.closest('pre, .cm-editor, .milkdown-slash-menu')
  );
}

function scrollHeadingIntoEditor(heading: HTMLElement): void {
  const pane = heading.closest('.rich-pane, .preview-pane') as HTMLElement | null;
  if (!pane) {
    heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const paneRect = pane.getBoundingClientRect();
  const headRect = heading.getBoundingClientRect();
  const nextTop = pane.scrollTop + (headRect.top - paneRect.top) - 20;
  pane.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
}

function jumpToOutlineLine(line: number, index?: number): void {
  if ((state.mode === 'src' || state.mode === 'split') && source) {
    source.jumpToLine(line);
  }

  const reveal = (idx?: number) => {
    if (state.mode !== 'split' && state.mode !== 'rich') {
      return false;
    }
    const headings = collectEditorHeadings();
    let heading: HTMLElement | undefined;
    if (typeof idx === 'number' && idx >= 0) {
      heading = headings[idx];
    }
    if (!heading) {
      const items = extractOutline(state.markdown);
      const found = items.findIndex((entry) => entry.line === line);
      heading = headings[found];
    }
    if (!heading) {
      return false;
    }
    scrollHeadingIntoEditor(heading);
    return true;
  };

  if (!reveal(index) && state.mode === 'rich') {
    requestAnimationFrame(() => reveal(index));
  }

  document.querySelectorAll('.outline-item').forEach((el) => {
    const btn = el as HTMLElement;
    const matchIndex = typeof index === 'number' && Number(btn.dataset.outlineIndex) === index;
    const matchLine = Number(btn.dataset.outlineLine) === line;
    btn.classList.toggle('active', matchIndex || matchLine);
  });
}

async function loadHistory(): Promise<void> {
  try {
    const result = await sendBridgeRequest<{ items: SnapshotItem[] }>('history:list', {
      filePath: state.filePath ?? null
    });
    state.historyItems = result.items ?? [];
  } catch {
    state.historyItems = [];
  }
}

async function saveHistorySnapshot(kind = 'manual'): Promise<void> {
  try {
    await sendBridgeRequest('history:save', {
      filePath: state.filePath ?? null,
      markdown: normalizeMarkdown(getCurrentMarkdown()),
      kind
    });
    if (kind !== 'auto') {
      showToast('已保存版本快照');
    }
    if (state.historyOpen && kind !== 'auto') {
      await loadHistory();
      render();
    }
  } catch (error) {
    if (kind !== 'auto') {
      showToast(error instanceof Error ? error.message : '快照失败');
    }
  }
}

async function restoreSnapshot(id: string): Promise<void> {
  try {
    const result = await sendBridgeRequest<{ markdown: string }>('history:load', {
      filePath: state.filePath ?? null,
      snapshotId: id
    });
    state.historyOpen = false;
    state.view = 'editor';
    setMarkdown(result.markdown, { dirty: true });
    showToast('已恢复此版本（未自动保存到文件）');
    render();
  } catch (error) {
    showToast(error instanceof Error ? error.message : '恢复失败');
  }
}

async function exportDocument(format: 'html' | 'pdf' | 'word' | 'png'): Promise<void> {
  try {
    const result = await sendBridgeRequest<{
      cancelled?: boolean;
      filePath?: string;
      note?: string;
    }>('export:file', {
      format,
      markdown: normalizeMarkdown(getCurrentMarkdown()),
      title: fileName().replace(/\.md$/i, ''),
      dark: state.theme === 'dark'
    });
    if (result.cancelled) {
      return;
    }
    showToast(result.note ?? `已导出 ${format.toUpperCase()}`, result.note ? 4200 : 2200);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '导出失败');
  }
}

async function printDocument(): Promise<void> {
  if (state.view !== 'editor') {
    showToast('请先打开文档再打印');
    return;
  }
  try {
    showToast('正在准备打印（嵌入图片）…', 5000);
    // Embed local images as data URLs so print preview can show them (no external browser).
    const storage = normalizeMarkdown(getCurrentMarkdown());
    const forPrint = await expandImagesForDisplay(storage);
    const { printInApp } = await import('./editor/print');
    await printInApp({
      title: fileName().replace(/\.md$/i, '') || 'MahoDown',
      markdownForDisplay: forPrint,
      dark: false
    });
  } catch (error) {
    showToast(error instanceof Error ? error.message : '打印失败');
  }
}

async function newDocument(): Promise<void> {
  try {
    const result = await sendBridgeRequest<{
      cancelled?: boolean;
      markdown?: string;
      filePath?: string | null;
      isDirty?: boolean;
    }>('file:new', {});
    if (result.cancelled) {
      return;
    }
    state.view = 'editor';
    state.filePath = result.filePath ?? undefined;
    clearAssetCache();
    const md = result.markdown ?? '# 未命名\n\n开始写作…\n';
    state.markdown = md;
    lastSavedMarkdown = normalizeMarkdown(md);
    state.isDirty = false;
    render();
    void sendBridgeRequest('app:setDirtyState', { isDirty: false }).catch(() => undefined);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '新建失败');
  }
}

async function openDocument(path?: string): Promise<void> {
  try {
    const result = await sendBridgeRequest<{
      cancelled?: boolean;
      markdown?: string;
      filePath?: string | null;
    }>('file:open', path ? { filePath: path } : {});
    if (result.cancelled) {
      return;
    }
    state.view = 'editor';
    state.filePath = result.filePath ?? undefined;
    clearAssetCache();
    const md = result.markdown ?? '';
    state.markdown = md;
    lastSavedMarkdown = normalizeMarkdown(md);
    state.isDirty = false;
    render();
    void loadRecent();
    void sendBridgeRequest('app:setDirtyState', { isDirty: false }).catch(() => undefined);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '打开失败');
  }
}

async function saveDocument(saveAs = false): Promise<void> {
  if (saveInFlight) {
    return;
  }
  saveInFlight = true;
  try {
    const markdown = normalizeMarkdown(getCurrentMarkdown());
    // Prefer overwrite when we already know the path, even if caller asked saveAs by mistake.
    const hasPath = Boolean(state.filePath && state.filePath.trim());
    const command = saveAs || !hasPath ? 'file:saveAs' : 'file:save';
    const result = await sendBridgeRequest<{
      cancelled?: boolean;
      filePath?: string;
      isDirty?: boolean;
    }>(command, { markdown });
    if (result.cancelled) {
      return;
    }
    if (result.filePath && result.filePath.trim()) {
      state.filePath = result.filePath;
    }
    // Baseline = what we wrote; then re-baseline from live editor after Milkdown settles.
    markClean(markdown);
    showToast('已保存');
    await loadRecent();
    const nameEl = document.querySelector('[data-doc-name]');
    if (nameEl) {
      nameEl.textContent = fileName();
    }
    updateSaveChrome();
    window.setTimeout(() => {
      lastSavedMarkdown = currentStorageMarkdown();
      state.isDirty = false;
      updateSaveChrome();
      void sendBridgeRequest('app:setDirtyState', { isDirty: false }).catch(() => undefined);
    }, 300);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '保存失败');
  } finally {
    saveInFlight = false;
  }
}

function getCurrentMarkdown(): string {
  if (state.mode === 'rich' && rich) {
    try {
      const raw = rich.getMarkdown();
      const storage = collapseAssetUrls(toStorageMarkdown(raw));
      state.markdown = storage;
      return storage;
    } catch {
      return state.markdown;
    }
  }
  if ((state.mode === 'src' || state.mode === 'split') && source) {
    try {
      const storage = normalizeMarkdown(source.getMarkdown());
      state.markdown = storage;
      return storage;
    } catch {
      return state.markdown;
    }
  }
  return state.markdown;
}

function onMarkdownEdited(markdown: string, fromRich = false): void {
  setMarkdown(markdown, { dirty: true, fromRich });
  renderStatusAndOutline();
}

let outlineRefreshTimer = 0;

function scheduleOutlineRefresh(): void {
  window.clearTimeout(outlineRefreshTimer);
  outlineRefreshTimer = window.setTimeout(() => renderStatusAndOutline(), 120);
}

function renderStatusAndOutline(): void {
  // Prefer live editor markdown (rich may lag state.markdown by one tick).
  let md = state.markdown;
  try {
    md = getCurrentMarkdown();
  } catch {
    // keep state.markdown
  }
  const words = countWords(md);
  const statusWords = document.querySelector('[data-status-words]');
  const statusRead = document.querySelector('[data-status-read]');
  const saveState = document.querySelector('[data-save-state]');
  if (statusWords) statusWords.textContent = `字数 ${words.toLocaleString()}`;
  if (statusRead) statusRead.textContent = `阅读 ${estimateReadMinutes(words)} 分钟`;
  if (saveState) saveState.textContent = state.isDirty ? '✦ 未保存' : '✦ 已保存';

  const outline = document.querySelector('[data-outline]');
  if (outline) {
    const items = extractOutline(md);
    outline.innerHTML = items.length
      ? items
          .map(
            (item, index) =>
              `<button class="outline-item ${index === 0 ? 'active' : ''} depth-${item.level}" type="button" data-outline-index="${index}" data-outline-line="${item.line}" title="H${item.level}">${escapeHtml(item.text)}</button>`
          )
          .join('')
      : '<div class="outline-empty">暂无标题</div>';
  }

  const preview = document.querySelector('[data-preview]');
  if (preview) {
    preview.innerHTML = renderPreviewHtml(state.markdown);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paletteItems(): Array<{ id: string; label: string; kbd?: string; run: () => void }> {
  const q = state.paletteQuery.trim().toLowerCase();
  const all = [
    { id: 'save', label: '保存', kbd: 'Ctrl+S', run: () => void saveDocument(false) },
    { id: 'saveas', label: '另存为…', kbd: 'Ctrl+Shift+S', run: () => void saveDocument(true) },
    { id: 'open', label: '打开文件…', kbd: 'Ctrl+O', run: () => void openDocument() },
    { id: 'new', label: '新建文档', kbd: 'Ctrl+N', run: () => void newDocument() },
    { id: 'focus', label: '切换专注模式', kbd: 'Ctrl+E', run: () => {
      state.focus = !state.focus;
      render();
    } },
    { id: 'settings', label: '打开设置', kbd: 'Ctrl+,', run: () => {
      state.settingsOpen = true;
      render();
    } },
    {
      id: 'history',
      label: '版本历史',
      kbd: 'Ctrl+Shift+H',
      run: () => {
        void (async () => {
          state.historyOpen = true;
          await loadHistory();
          render();
        })();
      }
    },
    { id: 'snapshot', label: '保存版本快照', run: () => void saveHistorySnapshot('manual') },
    { id: 'print', label: '打印…', kbd: 'Ctrl+P', run: () => void printDocument() },
    { id: 'export-html', label: '导出 HTML', run: () => void exportDocument('html') },
    { id: 'export-pdf', label: '导出 PDF', run: () => void exportDocument('pdf') },
    { id: 'export-word', label: '导出 Word', run: () => void exportDocument('word') },
    { id: 'export-png', label: '导出 PNG', run: () => void exportDocument('png') },
    {
      id: 'upload-all',
      label: '上传全部本地图片到图床',
      run: () => void uploadAllLocalImages()
    },
    {
      id: 'search',
      label: '查找',
      kbd: 'Ctrl+F',
      run: () => openFindBar(false)
    },
    {
      id: 'replace',
      label: '替换',
      kbd: 'Ctrl+H',
      run: () => openFindBar(true)
    },
    { id: 'mode-rich', label: '切换到富文本', run: () => setMode('rich') },
    { id: 'mode-split', label: '切换到分屏', run: () => setMode('split') },
    { id: 'mode-src', label: '切换到源码', run: () => setMode('src') },
    { id: 'ai-polish', label: '✦ 润色选中内容', kbd: 'AI', run: () => void runAiAction('polish') },
    { id: 'ai-continue', label: '续写下一段', kbd: 'AI', run: () => void runAiAction('continue') },
    { id: 'ai-translate', label: '翻译选中内容', kbd: 'AI', run: () => void runAiAction('translate') },
    { id: 'check-update', label: '检查更新…', run: () => void checkForUpdates() },
    {
      id: 'ai-settings',
      label: 'AI 设置…',
      run: () => {
        state.settingsOpen = true;
        state.settingsTab = 'ai';
        render();
      }
    }
  ];
  return all.filter((item) => !q || item.label.toLowerCase().includes(q));
}

function setMode(mode: EditorMode): void {
  state.markdown = getCurrentMarkdown();
  state.mode = mode;
  render();
}

function renderWelcome(): string {
  const recent = state.recent.length
    ? state.recent
        .map(
          (item) => `
        <button class="recent-item" type="button" data-open-recent="${escapeHtml(item.filePath)}">
          <span class="doc-icon">${bookSvg()}</span>
          <span class="name">${escapeHtml(item.fileName)}</span>
          <span class="time">${formatRelative(item.lastWriteTime)}</span>
        </button>`
        )
        .join('')
    : `<div style="font-size:12px;color:var(--muted);padding:8px">暂无最近文档</div>`;

  return `
  <div class="welcome">
    <div class="welcome-bar">
      <div class="title-drag" data-tauri-drag-region aria-hidden="true"></div>
      <div class="title-actions">${windowControlsHtml()}</div>
    </div>
    <div class="welcome-body">
      <div class="welcome-logo">${hatSvg(50)}</div>
      <div class="welcome-title">Maho<span>Down</span></div>
      <div class="welcome-sub">小巧精致的 Markdown 编辑器</div>
      <div class="welcome-ver" style="font-size:11px;color:var(--muted);opacity:.75;margin-top:2px">v${__APP_VERSION__} · build ${__BUILD_TIME__}</div>
      <div class="welcome-actions">
        <button class="btn-primary" type="button" data-action="new">✦ 新建文档</button>
        <button class="btn-secondary" type="button" data-action="open">打开文件…</button>
      </div>
      <div class="recent">
        <div class="recent-label">最近文档</div>
        ${recent}
      </div>
    </div>
  </div>`;
}

function formatRelative(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 172_800_000) return '昨天';
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function kindLabel(kind: string): string {
  if (kind === 'manual-save') return '保存时快照';
  if (kind === 'manual') return '手动快照';
  if (kind === 'auto') return '自动快照';
  return kind || '快照';
}

function field(label: string, key: string, value: string, type = 'text', placeholder = ''): string {
  return `
    <div class="field-row">
      <label>${label}</label>
      <input data-host-field="${key}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" />
    </div>`;
}

function renderHostForm(hostId: string, cfg: Record<string, string>): string {
  if (hostId === 'local') {
    return `<div style="font-size:12px;color:var(--text2)">图片将复制到文档旁的 <code>./img</code> 目录，Markdown 使用相对路径。已支持预览与粘贴上传。</div>`;
  }
  if (hostId === 'github') {
    return (
      field('仓库', 'repo', cfg.repo ?? '', 'text', 'owner/repo') +
      field('分支', 'branch', cfg.branch ?? 'main') +
      field('Token', 'token', cfg.token ?? '', 'password', 'ghp_…') +
      field('路径模板', 'pathTemplate', cfg.pathTemplate ?? 'img/{year}-{month}/{filename}')
    );
  }
  if (hostId === 's3') {
    return (
      field('Endpoint', 'endpoint', cfg.endpoint ?? '', 'text', 'https://…') +
      field('Region', 'region', cfg.region ?? 'us-east-1') +
      field('Bucket', 'bucket', cfg.bucket ?? '') +
      field('AccessKey', 'accessKey', cfg.accessKey ?? '', 'password') +
      field('SecretKey', 'secretKey', cfg.secretKey ?? '', 'password') +
      field('Public URL', 'publicBaseUrl', cfg.publicBaseUrl ?? '') +
      field('Prefix', 'prefix', cfg.prefix ?? 'img')
    );
  }
  if (hostId === 'picgo') {
    return field('Endpoint', 'endpoint', cfg.endpoint ?? 'http://127.0.0.1:36677', 'text', 'http://127.0.0.1:36677');
  }
  if (hostId === 'smms') {
    return field('Token', 'token', cfg.token ?? '', 'password', 'SM.MS API token');
  }
  if (hostId === 'custom') {
    return (
      field('URL', 'url', cfg.url ?? '', 'text', 'https://api.example.com/upload') +
      field('模式', 'mode', cfg.mode ?? 'multipart', 'text', 'multipart 或 json') +
      field('Token', 'token', cfg.token ?? '', 'password') +
      field('JSON 路径', 'jsonPath', cfg.jsonPath ?? 'url', 'text', 'url 或 data.url')
    );
  }
  return '';
}

function renderSettings(): string {
  if (!state.settingsOpen) {
    return '';
  }

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'general', label: '通用' },
    { id: 'editor', label: '编辑器' },
    { id: 'theme', label: '主题' },
    { id: 'ai', label: 'AI' },
    { id: 'image', label: '图床与上传' },
    { id: 'export', label: '导出' },
    { id: 'history', label: '版本历史' },
    { id: 'plugins', label: '插件' },
    { id: 'shortcuts', label: '快捷键' }
  ];

  const nav = tabs
    .map(
      (tab) =>
        `<button type="button" class="${state.settingsTab === tab.id ? 'active' : ''}" data-settings-tab="${tab.id}">${tab.label}</button>`
    )
    .join('');

  let content = '';
  if (state.settingsTab === 'image') {
    const cfg = hostConfig(state.defaultHost);
    content = `
      <h2>图床与上传</h2>
      <p class="desc">插入图片时的存储方式，可随时切换，已插入的链接不受影响</p>
      <div class="host-grid">
        ${HOSTS.map(
          (host) => `
          <button class="host-card ${state.defaultHost === host.id ? 'active' : ''}" type="button" data-host="${host.id}">
            <div class="t">${host.title}</div>
            <div class="d">${host.desc}</div>
          </button>`
        ).join('')}
      </div>
      <div class="host-form" style="margin-top:14px;background:var(--panel);border:1px solid var(--hair);border-radius:8px;padding:12px 14px">
        ${renderHostForm(state.defaultHost, cfg)}
        <div style="display:flex;gap:8px;margin-top:12px;align-items:center">
          <button class="btn-primary" type="button" data-action="save-host">保存配置</button>
          <button class="btn-secondary" type="button" data-action="test-host">测试连接</button>
          <span data-host-test style="font-size:11px;color:var(--muted)"></span>
        </div>
      </div>
      <div class="toggle-row" style="margin-top:14px">粘贴截图自动上传
        <button type="button" class="focus-toggle ${state.pasteUploadImages ? 'on' : ''}" data-action="toggle-paste-upload" style="margin-left:auto">
          <span class="track"><span class="knob"></span></span>
        </button>
      </div>
      <div class="toggle-row">上传失败时保留本地副本
        <button type="button" class="focus-toggle ${state.keepLocalOnUploadFailure ? 'on' : ''}" data-action="toggle-keep-local" style="margin-left:auto">
          <span class="track"><span class="knob"></span></span>
        </button>
      </div>`;
  } else if (state.settingsTab === 'plugins') {
    content = `
      <h2>插件</h2>
      <div class="coming-soon">
        <strong>即将到来</strong>
        插件商店与沙箱运行环境正在准备中，当前版本暂不可启用插件。
      </div>`;
  } else if (state.settingsTab === 'theme') {
    const themeOpt = (id: 'system' | 'light' | 'dark', label: string) =>
      `<button type="button" class="btn-secondary ${state.themePreference === id ? 'active-pref' : ''}" data-theme-pref="${id}">${label}</button>`;
    content = `
      <h2>主题</h2>
      <p class="desc">外观与强调色</p>
      <div class="field-row" style="gap:8px;flex-wrap:wrap">
        <label>外观</label>
        ${themeOpt('system', '跟随系统')}
        ${themeOpt('light', '浅色')}
        ${themeOpt('dark', '深色')}
      </div>
      <div class="field-row">
        <label>AI</label>
        <button class="btn-secondary" type="button" data-settings-tab="ai">配置 DeepSeek 等模型 →</button>
      </div>`;
  } else if (state.settingsTab === 'ai') {
    content = `
      <h2>AI</h2>
      <p class="desc">兼容 OpenAI 协议：DeepSeek、OpenAI、Kimi、硅基流动、Ollama…</p>
      <div class="ai-presets">
        <button type="button" class="btn-secondary" data-ai-preset="deepseek">DeepSeek</button>
        <button type="button" class="btn-secondary" data-ai-preset="openai">OpenAI</button>
        <button type="button" class="btn-secondary" data-ai-preset="moonshot">Kimi</button>
        <button type="button" class="btn-secondary" data-ai-preset="siliconflow">硅基流动</button>
        <button type="button" class="btn-secondary" data-ai-preset="ollama">Ollama</button>
      </div>
      <div class="field-row" style="margin-top:12px">
        <label>API Base</label>
        <input data-ai-base type="text" value="${escapeHtml(state.aiBaseUrl)}" placeholder="https://api.deepseek.com/v1" style="flex:1;min-width:0" />
      </div>
      <div class="field-row">
        <label>模型</label>
        <input data-ai-model type="text" value="${escapeHtml(state.aiModel)}" placeholder="deepseek-chat" style="flex:1;min-width:0" />
      </div>
      <div class="field-row">
        <label>API Key</label>
        <input data-ai-key type="password" value="${escapeHtml(state.aiApiKey)}" placeholder="${state.hasAiKey ? '已保存，留空不修改' : 'sk-…'}" style="flex:1;min-width:0" />
      </div>
      <p class="desc" style="margin-top:8px">Key 仅保存在本机。命令面板可调：润色 / 续写 / 翻译（需先选中文字，续写可不选）。</p>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn-primary" type="button" data-action="save-ai">保存 AI 配置</button>
        <button class="btn-secondary" type="button" data-action="ai-test">测试连接</button>
        <button class="btn-secondary" type="button" data-action="ai-polish">试润色选中</button>
      </div>`;
  } else if (state.settingsTab === 'editor') {
    content = `
      <h2>编辑器</h2>
      <p class="desc">字体与排版、默认模式、输入行为</p>
      <div class="field-row">
        <label>默认模式</label>
        <select data-setting-default-mode style="min-width:120px">
          <option value="rich" ${state.defaultMode === 'rich' ? 'selected' : ''}>富文本</option>
          <option value="split" ${state.defaultMode === 'split' ? 'selected' : ''}>分屏</option>
          <option value="src" ${state.defaultMode === 'src' ? 'selected' : ''}>源码</option>
        </select>
      </div>
      <div class="field-row">
        <label>正文字号</label>
        <input data-setting-font type="number" min="12" max="24" step="1" value="${state.fontSize}" style="width:72px" />
        <span style="color:var(--muted);font-size:11px">px</span>
      </div>
      <div class="field-row">
        <label>行高</label>
        <input data-setting-line type="number" min="1.2" max="2.4" step="0.1" value="${state.lineHeight}" style="width:72px" />
      </div>
      <div class="field-row">
        <label>行宽</label>
        <select data-setting-line-width style="min-width:120px">
          <option value="narrow" ${state.lineWidth === 'narrow' ? 'selected' : ''}>窄</option>
          <option value="standard" ${state.lineWidth === 'standard' ? 'selected' : ''}>标准</option>
          <option value="full" ${state.lineWidth === 'full' ? 'selected' : ''}>全宽</option>
        </select>
      </div>
      <div class="field-row">
        <label>界面缩放</label>
        <select data-setting-ui-scale style="min-width:120px">
          <option value="0.85" ${state.uiScale === 0.85 ? 'selected' : ''}>很小 85%</option>
          <option value="0.9" ${state.uiScale === 0.9 ? 'selected' : ''}>小 90%</option>
          <option value="0.95" ${state.uiScale === 0.95 ? 'selected' : ''}>略小 95%</option>
          <option value="1" ${state.uiScale === 1 ? 'selected' : ''}>标准 100%</option>
          <option value="1.05" ${state.uiScale === 1.05 ? 'selected' : ''}>略大 105%</option>
          <option value="1.1" ${state.uiScale === 1.1 ? 'selected' : ''}>大 110%</option>
          <option value="1.15" ${state.uiScale === 1.15 ? 'selected' : ''}>较大 115%</option>
          <option value="1.2" ${state.uiScale === 1.2 ? 'selected' : ''}>更大 120%</option>
          <option value="1.25" ${state.uiScale === 1.25 ? 'selected' : ''}>很大 125%</option>
          <option value="1.3" ${state.uiScale === 1.3 ? 'selected' : ''}>最大 130%</option>
        </select>
      </div>
      <div class="toggle-row">自动配对括号与引号
        <button type="button" class="focus-toggle ${state.autoPairBrackets ? 'on' : ''}" data-action="toggle-auto-pair" style="margin-left:auto"><span class="track"><span class="knob"></span></span></button>
      </div>
      <div class="toggle-row">光标行展开 Markdown 标记
        <button type="button" class="focus-toggle ${state.expandMarkdownOnCaret ? 'on' : ''}" data-action="toggle-expand-md" style="margin-left:auto"><span class="track"><span class="knob"></span></span></button>
      </div>
      <div class="toggle-row">粘贴时清除格式
        <button type="button" class="focus-toggle ${state.stripPasteFormatting ? 'on' : ''}" data-action="toggle-strip-paste" style="margin-left:auto"><span class="track"><span class="knob"></span></span></button>
      </div>
      <div class="toggle-row">中英文自动空格
        <button type="button" class="focus-toggle ${state.autoSpaceCjk ? 'on' : ''}" data-action="toggle-auto-space" style="margin-left:auto"><span class="track"><span class="knob"></span></span></button>
      </div>
      <div class="field-row">
        <label>自动快照</label>
        <input data-setting-snapshot type="number" min="0" max="240" step="5" value="${state.autoSnapshotMinutes}" style="width:72px" />
        <span style="color:var(--muted);font-size:11px">分钟（0=关闭）</span>
      </div>
      <button class="btn-primary" type="button" data-action="save-editor-settings" style="margin-top:8px">保存编辑器设置</button>`;
  } else if (state.settingsTab === 'export') {
    content = `
      <h2>导出</h2>
      <p class="desc">HTML 直接保存；PDF/PNG 打开打印页；Word 导出结构化 docx</p>
      <div class="host-grid" style="grid-template-columns:1fr 1fr 1fr 1fr">
        <button class="host-card" type="button" data-export="html"><div class="t">HTML</div><div class="d">单文件网页</div></button>
        <button class="host-card" type="button" data-export="pdf"><div class="t">PDF</div><div class="d">浏览器另存 PDF</div></button>
        <button class="host-card" type="button" data-export="word"><div class="t">Word</div><div class="d">.docx 标题/列表</div></button>
        <button class="host-card" type="button" data-export="png"><div class="t">PNG</div><div class="d">预览页截图</div></button>
      </div>
      <button class="btn-primary" type="button" data-action="print-doc" style="margin-top:14px">🖨 打印当前文档…</button>`;
  } else if (state.settingsTab === 'history') {
    content = renderHistoryListPanel();
  } else if (state.settingsTab === 'shortcuts') {
    content = `
      <h2>快捷键</h2>
      <div class="field-row"><label>命令面板</label><div>Ctrl+K</div></div>
      <div class="field-row"><label>新建</label><div>Ctrl+N</div></div>
      <div class="field-row"><label>打开</label><div>Ctrl+O</div></div>
      <div class="field-row"><label>保存</label><div>Ctrl+S</div></div>
      <div class="field-row"><label>另存为</label><div>Ctrl+Shift+S</div></div>
      <div class="field-row"><label>专注模式</label><div>Ctrl+E</div></div>
      <div class="field-row"><label>版本历史</label><div>Ctrl+Shift+H</div></div>
      <div class="field-row"><label>查找</label><div>Ctrl+F</div></div>
      <div class="field-row"><label>替换</label><div>Ctrl+H</div></div>
      <div class="field-row"><label>查找下一个 / 上一个</label><div>F3 / Shift+F3</div></div>
      <div class="field-row"><label>打印</label><div>Ctrl+P</div></div>
      <div class="field-row"><label>设置</label><div>Ctrl+,</div></div>
      <div class="field-row"><label>关闭面板</label><div>Esc</div></div>`;
  } else {
    content = `
      <h2>通用</h2>
      <p class="desc">MahoDown v${__APP_VERSION__} · 小巧精致的 Markdown 编辑器</p>
      <div class="field-row"><label>语言</label><div>简体中文</div></div>
      <div class="field-row"><label>壳</label><div>Tauri 2 · 跨平台</div></div>
      <div class="field-row"><label>编辑器</label><div>Milkdown Crepe · CodeMirror</div></div>
      <div class="field-row"><label>自动快照</label><div>${state.autoSnapshotMinutes > 0 ? `每 ${state.autoSnapshotMinutes} 分钟` : '已关闭'}</div></div>
      <div class="field-row"><label>更新</label><div>
        <button type="button" class="btn-secondary" data-action="check-update" style="height:28px;padding:0 10px;font-size:12px">检查更新</button>
      </div></div>
      <p class="desc" style="margin-top:10px">开源后通过 GitHub Releases 推送版本；菜单「检查更新」会查询 latest release。</p>`;
  }

  return `
  <div class="settings-overlay" data-settings-overlay>
    <div class="settings-card">
      <div class="settings-top">
        <div class="brand-mark">${hatSvg(11)}</div>
        <div style="font-size:12px">设置</div>
        <button class="icon-btn" type="button" data-action="close-settings" style="margin-left:auto">✕</button>
      </div>
      <div class="settings-body">
        <div class="settings-nav">${nav}<div class="version">MahoDown v${__APP_VERSION__}<br />build ${__BUILD_TIME__}</div></div>
        <div class="settings-content">${content}</div>
      </div>
    </div>
  </div>`;
}

function renderHistoryListPanel(): string {
  const groups = groupSnapshotsByDay(state.historyItems);
  const list = groups.length
    ? groups
        .map((g) => {
          const rows = g.items
            .map(
              (item) => `
            <div class="history-row">
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:600">${escapeHtml(kindLabel(item.kind))}</div>
                <div style="font-size:10.5px;color:var(--muted)">${escapeHtml(formatDate(item.createdAt))} · ${item.wordCount} 字</div>
              </div>
              <button class="btn-secondary" type="button" data-history-diff="${escapeHtml(item.id)}">对比</button>
              <button class="btn-secondary" type="button" data-restore="${escapeHtml(item.id)}">恢复</button>
            </div>`
            )
            .join('');
          return `<div class="history-day">${escapeHtml(g.label)}</div>${rows}`;
        })
        .join('')
    : `<div style="font-size:12px;color:var(--muted)">暂无快照。保存文档或手动创建后会出现在这里。</div>`;

  const diff = state.historyDiffText
    ? `<div class="history-diff">${simpleLineDiff(state.historyDiffText, getCurrentMarkdown())
        .map((row) => {
          const cls = row.type === 'add' ? 'diff-add' : row.type === 'del' ? 'diff-del' : 'diff-same';
          const mark = row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' ';
          return `<div class="${cls}"><span class="diff-mark">${mark}</span>${escapeHtml(row.text)}</div>`;
        })
        .join('')}</div>`
    : '';

  return `
      <h2>版本历史</h2>
      <p class="desc">按时间分组 · 可对比当前文档 · 恢复后需手动保存</p>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <button class="btn-primary" type="button" data-action="save-snapshot">✦ 保存当前快照</button>
        <button class="btn-secondary" type="button" data-action="refresh-history">刷新</button>
      </div>
      <div class="history-layout">
        <div data-history-list class="history-list">${list}</div>
        ${diff ? `<div class="history-diff-pane"><div class="history-day">与当前对比</div>${diff}</div>` : ''}
      </div>`;
}

function renderHistoryOverlay(): string {
  if (!state.historyOpen) {
    return '';
  }
  return `
  <div class="settings-overlay" data-history-overlay>
    <div class="settings-card" style="height:min(560px,90vh);width:min(720px,96vw)">
      <div class="settings-top">
        <div class="brand-mark">${hatSvg(11)}</div>
        <div style="font-size:12px">版本历史</div>
        <button class="icon-btn" type="button" data-action="close-history" style="margin-left:auto">✕</button>
      </div>
      <div style="padding:16px;overflow:auto;flex:1">
        ${renderHistoryListPanel().replace('<h2>版本历史</h2>', '')}
      </div>
    </div>
  </div>`;
}

function currentSearchHits(): SearchHit[] {
  return findInMarkdown(getCurrentMarkdown(), state.searchQuery, 500, state.searchCase);
}

function jumpToTextOccurrence(root: Element, query: string, occurrence: number, caseSensitive: boolean): boolean {
  if (!query) {
    return false;
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('pre, .cm-editor, .milkdown-slash-menu')) {
      continue;
    }
    const raw = node.textContent ?? '';
    const hay = caseSensitive ? raw : raw.toLowerCase();
    let from = 0;
    while (from < hay.length) {
      const at = hay.indexOf(needle, from);
      if (at < 0) {
        break;
      }
      if (seen === occurrence) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, Math.min(raw.length, at + query.length));
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        const el = node.parentElement;
        if (el) {
          scrollHeadingIntoEditor(el);
        }
        return true;
      }
      seen += 1;
      from = at + Math.max(1, needle.length);
    }
  }
  return false;
}

function revealSearchHit(hit: SearchHit): void {
  if ((state.mode === 'src' || state.mode === 'split') && source) {
    source.jumpToRange(hit.from, hit.to);
  }
  if (state.mode === 'rich' || state.mode === 'split') {
    const root =
      state.mode === 'rich'
        ? document.querySelector('.milkdown-host .ProseMirror')
        : document.querySelector('[data-preview]');
    if (root) {
      jumpToTextOccurrence(root, state.searchQuery, hit.index, state.searchCase);
    }
  }
}

function updateFindBarStats(bar: HTMLElement): void {
  const hits = state.searchQuery ? currentSearchHits() : [];
  if (hits.length) {
    state.searchIndex = ((state.searchIndex % hits.length) + hits.length) % hits.length;
  } else {
    state.searchIndex = 0;
  }
  const count = bar.querySelector('[data-find-count]');
  if (count) {
    count.textContent = !state.searchQuery ? '' : hits.length ? `${state.searchIndex + 1}/${hits.length}` : '0/0';
  }
  bar.querySelector('[data-find-case]')?.classList.toggle('on', state.searchCase);
  bar.classList.toggle('has-replace', state.searchReplace);
}

function bindFindBar(bar: HTMLElement): void {
  const queryInput = bar.querySelector<HTMLInputElement>('[data-find-query]');
  const replaceInput = bar.querySelector<HTMLInputElement>('[data-find-replace]');
  queryInput?.addEventListener('input', () => {
    state.searchQuery = queryInput.value;
    state.searchIndex = 0;
    updateFindBarStats(bar);
    const hits = currentSearchHits();
    if (hits[0]) {
      revealSearchHit(hits[0]);
      queryInput.focus();
    }
  });
  replaceInput?.addEventListener('input', () => {
    state.replaceQuery = replaceInput.value;
  });
  queryInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      findStep(event.shiftKey ? -1 : 1);
    }
  });
  replaceInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      replaceCurrentHit();
    }
  });
  bar.querySelector('[data-find-next]')?.addEventListener('click', () => findStep(1));
  bar.querySelector('[data-find-prev]')?.addEventListener('click', () => findStep(-1));
  bar.querySelector('[data-find-case]')?.addEventListener('click', () => {
    state.searchCase = !state.searchCase;
    state.searchIndex = 0;
    updateFindBarStats(bar);
    const hits = currentSearchHits();
    if (hits[0]) {
      revealSearchHit(hits[0]);
    }
  });
  bar.querySelector('[data-find-close]')?.addEventListener('click', () => closeFindBar());
  bar.querySelector('[data-find-replace-one]')?.addEventListener('click', () => replaceCurrentHit());
  bar.querySelector('[data-find-replace-all]')?.addEventListener('click', () => replaceAllHits());
}

function ensureFindBar(): HTMLElement | null {
  if (state.view !== 'editor') {
    return null;
  }
  const host = app.querySelector('.main') ?? app;
  let bar = app.querySelector<HTMLElement>('[data-find-bar]');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'find-bar';
    bar.dataset.findBar = '';
    bar.innerHTML = `
      <div class="find-bar-row">
        <input data-find-query type="text" placeholder="查找" spellcheck="false" />
        <span class="find-count" data-find-count></span>
        <button type="button" class="find-icon-btn" data-find-prev title="上一个 Shift+F3">↑</button>
        <button type="button" class="find-icon-btn" data-find-next title="下一个 F3">↓</button>
        <button type="button" class="find-icon-btn" data-find-case title="区分大小写">Aa</button>
        <button type="button" class="find-icon-btn" data-find-close title="关闭 Esc">✕</button>
      </div>
      <div class="find-bar-row find-replace-row">
        <input data-find-replace type="text" placeholder="替换为" spellcheck="false" />
        <button type="button" class="find-text-btn" data-find-replace-one>替换</button>
        <button type="button" class="find-text-btn" data-find-replace-all>全部</button>
      </div>`;
    host.appendChild(bar);
    bindFindBar(bar);
  }
  const q = bar.querySelector<HTMLInputElement>('[data-find-query]');
  const r = bar.querySelector<HTMLInputElement>('[data-find-replace]');
  if (q && q.value !== state.searchQuery) {
    q.value = state.searchQuery;
  }
  if (r && r.value !== state.replaceQuery) {
    r.value = state.replaceQuery;
  }
  updateFindBarStats(bar);
  return bar;
}

function closeFindBar(): void {
  state.searchOpen = false;
  app.querySelector('[data-find-bar]')?.remove();
}

function openFindBar(replace: boolean): void {
  if (state.view !== 'editor') {
    return;
  }
  if (state.paletteOpen) {
    state.paletteOpen = false;
    app.querySelector('[data-palette]')?.remove();
  }
  state.searchOpen = true;
  if (replace) {
    state.searchReplace = true;
  } else if (!app.querySelector('[data-find-bar]')) {
    state.searchReplace = false;
  }
  const bar = ensureFindBar();
  const focusReplace = replace && Boolean(state.searchQuery);
  const input = bar?.querySelector<HTMLInputElement>(focusReplace ? '[data-find-replace]' : '[data-find-query]');
  input?.focus();
  input?.select();
  const hits = currentSearchHits();
  if (hits[state.searchIndex]) {
    revealSearchHit(hits[state.searchIndex]!);
    input?.focus();
  }
}

function findStep(delta: number): void {
  if (!state.searchOpen) {
    openFindBar(false);
    return;
  }
  const hits = currentSearchHits();
  if (!hits.length) {
    ensureFindBar();
    return;
  }
  state.searchIndex = (state.searchIndex + delta + hits.length) % hits.length;
  const bar = ensureFindBar();
  if (bar) {
    updateFindBarStats(bar);
  }
  const hit = hits[state.searchIndex];
  if (hit) {
    revealSearchHit(hit);
  }
}

function replaceCurrentHit(): void {
  if (!state.searchQuery) {
    return;
  }
  const md = getCurrentMarkdown();
  const hits = findInMarkdown(md, state.searchQuery, 500, state.searchCase);
  const hit = hits[state.searchIndex] ?? hits[0];
  if (!hit) {
    showToast('无匹配');
    return;
  }
  const next = replaceHitInMarkdown(md, hit, state.replaceQuery);
  setMarkdown(next, { dirty: true });
  renderStatusAndOutline();
  const remaining = findInMarkdown(next, state.searchQuery, 500, state.searchCase);
  state.searchIndex = Math.min(hit.index, Math.max(0, remaining.length - 1));
  const bar = ensureFindBar();
  if (bar) {
    updateFindBarStats(bar);
  }
  const follow = remaining[state.searchIndex];
  if (follow) {
    window.setTimeout(() => revealSearchHit(follow), 40);
  }
}

function replaceAllHits(): void {
  if (!state.searchQuery) {
    return;
  }
  const md = getCurrentMarkdown();
  const { next, count } = replaceAllInMarkdown(md, state.searchQuery, state.replaceQuery, state.searchCase);
  if (!count) {
    showToast('无匹配');
    return;
  }
  setMarkdown(next, { dirty: true });
  renderStatusAndOutline();
  state.searchIndex = 0;
  const bar = ensureFindBar();
  if (bar) {
    updateFindBarStats(bar);
  }
  showToast(`已替换 ${count} 处`);
}

function renderPalette(): string {
  if (!state.paletteOpen) {
    return '';
  }
  const items = paletteItems();
  return `
  <div class="palette" data-palette>
    <div class="palette-card">
      <div class="palette-input">
        <span style="color:var(--acc-b)">✦</span>
        <input data-palette-input placeholder="输入命令…" value="${escapeHtml(state.paletteQuery)}" />
        <span class="kbd">Esc</span>
      </div>
      <div style="padding:5px">
        ${items
          .map(
            (item, index) => `
          <button class="palette-item ${index === 0 ? 'active' : ''}" type="button" data-palette-run="${item.id}">
            ${escapeHtml(item.label)}
            <span class="kbd">${item.kbd ?? ''}</span>
          </button>`
          )
          .join('')}
      </div>
    </div>
  </div>`;
}

function renderEditor(): string {
  const outline = extractOutline(state.markdown)
    .map(
      (item, index) =>
        `<button class="outline-item ${index === 0 ? 'active' : ''} depth-${item.level}" type="button" data-outline-index="${index}" data-outline-line="${item.line}">${escapeHtml(item.text)}</button>`
    )
    .join('');

  const words = countWords(state.markdown);
  let center = '';
  if (state.mode === 'src') {
    center = `<div class="source-pane"><div class="cm-host" data-source-root></div></div>`;
  } else if (state.mode === 'split') {
    center = `
      <div class="source-pane"><div class="cm-host" data-source-root></div></div>
      <div class="split-divider" title="同步滚动"></div>
      <div class="preview-pane"><div class="prose" data-preview>${renderPreviewHtml(state.markdown)}</div></div>`;
  } else {
    center = `<div class="rich-pane"><div class="milkdown-host" data-rich-root></div></div>`;
  }

  const hostLabel = HOSTS.find((h) => h.id === state.defaultHost)?.title ?? '本地';
  const modeStatus =
    state.mode === 'src' ? 'Markdown · 源码' : state.mode === 'split' ? 'Markdown · 分屏' : 'Markdown · GFM';

  return `
  <div class="shell ${state.focus ? 'focus-mode' : ''} ${state.showStatus ? '' : 'no-status'}">
    <div class="titlebar">
      <div class="title-left">
        <button type="button" class="brand-mark brand-menu-btn ${state.menuOpen ? 'open' : ''}" data-action="toggle-menu" title="主菜单">
          ${hatSvg(11)}
        </button>
        <span class="doc-icon" aria-hidden="true">${bookSvg()}</span>
        <span class="doc-name" data-doc-name>${escapeHtml(fileName())}</span>
        <span class="save-state" data-save-state>${isSavedToDisk() ? '✦ 已保存' : '✦ 未保存'}</span>
        <div class="title-drag" data-tauri-drag-region aria-hidden="true"></div>
      </div>
      <div class="title-center">
        <div class="seg" role="tablist" aria-label="编辑模式">
          <button type="button" class="${state.mode === 'src' ? 'active' : ''}" data-mode="src" title="源码">‹/›</button>
          <button type="button" class="${state.mode === 'split' ? 'active' : ''}" data-mode="split" title="分屏">
            <span class="split-glyph"><i></i><i class="fill"></i></span>
          </button>
          <button type="button" class="${state.mode === 'rich' ? 'active' : ''}" data-mode="rich" title="富文本">
            <span class="rich-glyph">${bookSvg()}</span>富文本
          </button>
        </div>
        <button class="focus-toggle ${state.focus ? 'on' : ''}" type="button" data-action="toggle-focus" title="专注模式 Ctrl+E">
          <span>专注</span>
          <span class="track"><span class="knob"></span></span>
        </button>
        <button type="button" class="ai-toggle ${state.aiPanelOpen ? 'on' : ''}" data-action="toggle-ai" title="AI 助手 · 与文档对话">✦ AI</button>
      </div>
      <div class="title-right">
        <div class="title-drag" data-tauri-drag-region aria-hidden="true"></div>
        <div class="title-actions">${windowControlsHtml()}</div>
      </div>
    </div>
    <div class="main">
      ${
        state.focus || !state.showOutline
          ? ''
          : `<aside class="outline"><div class="outline-label">大纲</div><div data-outline>${outline || '<div class="outline-empty">暂无标题</div>'}</div></aside>`
      }
      <div class="editor-pane"><div class="editor-stage">${center}</div></div>
      ${state.aiPanelOpen ? renderAiPanel() : ''}
      ${
        state.focus
          ? `<div class="focus-pill"><strong>专注</strong><span data-status-words>${words.toLocaleString()} 字</span><span style="font-family:var(--font-mono)">Ctrl+E 退出</span></div>`
          : ''
      }
      ${renderAppMenu()}
      ${renderSettings()}
      ${renderPalette()}
      ${renderHistoryOverlay()}
      ${renderUpdateDialog()}
      <div class="toast" data-toast ${state.toast ? '' : 'hidden'}>${escapeHtml(state.toast)}</div>
    </div>
    ${
      state.showStatus
        ? `<div class="statusbar">
      <div data-status-words>字数 ${words.toLocaleString('zh-CN')}</div>
      <div data-status-read>阅读 ${estimateReadMinutes(words)} 分钟</div>
      <div data-status-cursor>行 ${state.cursorLine} · 列 ${state.cursorCol}</div>
      <div data-status-saved>${state.lastSavedAt ? `保存 ${formatRelative(state.lastSavedAt)}` : '尚未保存'}</div>
      <div>${modeStatus}</div>
      <div class="spacer accent">图床 ${hostLabel} ✦</div>
      <div>Ctrl+K 命令</div>
      <div>UTF-8</div>
    </div>`
        : ''
    }
  </div>`;
}

/** Open/close hat menu without full page re-render (avoids main content flicker). */
function setMenuOpen(open: boolean): void {
  if (state.menuOpen === open) {
    return;
  }
  state.menuOpen = open;
  const hat = app.querySelector('.brand-menu-btn');
  hat?.classList.toggle('open', open);

  app.querySelector('[data-menu-backdrop]')?.remove();
  app.querySelector('.app-menu')?.remove();

  if (!open) {
    return;
  }

  const host = app.querySelector('.main') ?? app;
  const wrap = document.createElement('div');
  wrap.innerHTML = renderAppMenu();
  while (wrap.firstChild) {
    host.appendChild(wrap.firstChild);
  }
  bindMenuEvents();
}

function bindMenuEvents(): void {
  app.querySelector('[data-menu-backdrop]')?.addEventListener('click', () => {
    setMenuOpen(false);
  });
  app.querySelectorAll<HTMLElement>('[data-theme-pref]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      const pref = el.dataset.themePref as 'system' | 'light' | 'dark';
      setThemePreference(pref); // re-themes instantly via CSS vars — no re-render
      // Keep the menu open so the user can compare themes; just move the active
      // pill to the picked option in place.
      app.querySelectorAll<HTMLElement>('[data-theme-pref]').forEach((b) => {
        b.classList.toggle('active', b.dataset.themePref === pref);
      });
    });
  });
  app.querySelectorAll<HTMLElement>('[data-menu]').forEach((el) => {
    el.addEventListener('click', () => {
      const cmd = el.dataset.menu;
      state.menuOpen = false;
      // Remove menu shell immediately before command may full-render
      app.querySelector('[data-menu-backdrop]')?.remove();
      app.querySelector('.app-menu')?.remove();
      app.querySelector('.brand-menu-btn')?.classList.remove('open');
      runMenuCommand(cmd);
    });
  });
}

function runMenuCommand(cmd: string | undefined): void {
  if (!cmd) {
    return;
  }
  if (cmd === 'new') {
    void newDocument();
    return;
  }
  if (cmd === 'open') {
    void openDocument();
    return;
  }
  if (cmd === 'save') {
    void saveDocument(false);
    return;
  }
  if (cmd === 'print') {
    void printDocument();
    return;
  }
  if (cmd === 'export-html') {
    void exportDocument('html');
    return;
  }
  if (cmd === 'export-pdf') {
    void exportDocument('pdf');
    return;
  }
  if (cmd === 'export-word') {
    void exportDocument('word');
    return;
  }
  if (cmd === 'export-png') {
    void exportDocument('png');
    return;
  }
  if (cmd === 'search') {
    openFindBar(false);
    return;
  }
  if (cmd === 'replace') {
    openFindBar(true);
    return;
  }
  if (cmd === 'ai-polish') {
    void runAiAction('polish');
    return;
  }
  if (cmd === 'ai-continue') {
    void runAiAction('continue');
    return;
  }
  if (cmd === 'ai-translate') {
    void runAiAction('translate');
    return;
  }
  if (cmd === 'ai-chat') {
    openAiPanel();
    return;
  }
  if (cmd === 'export') {
    state.settingsOpen = true;
    state.settingsTab = 'export';
    render();
    return;
  }
  if (cmd === 'outline') {
    state.showOutline = !state.showOutline;
    render();
    return;
  }
  if (cmd === 'status') {
    state.showStatus = !state.showStatus;
    render();
    return;
  }
  if (cmd === 'upload-all') {
    void uploadAllLocalImages();
    return;
  }
  if (cmd === 'history') {
    state.historyOpen = true;
    void loadHistory().then(() => render());
    return;
  }
  if (cmd === 'plugins') {
    state.settingsOpen = true;
    state.settingsTab = 'plugins';
    render();
    return;
  }
  if (cmd === 'settings') {
    state.settingsOpen = true;
    state.settingsTab = 'image';
    render();
    return;
  }
  if (cmd === 'shortcuts') {
    state.settingsOpen = true;
    state.settingsTab = 'shortcuts';
    render();
    return;
  }
  if (cmd === 'update') {
    void checkForUpdates();
    return;
  }
  if (cmd === 'about') {
    state.settingsOpen = true;
    state.settingsTab = 'general';
    render();
  }
}

async function checkForUpdates(): Promise<void> {
  showToast('正在检查更新…', 10_000);
  try {
    const result = await sendBridgeRequest<UpdateCheckResult>('app:checkUpdate', {});
    state.updateDialog = result;
    state.toast = '';
    render();
  } catch (error) {
    showToast(error instanceof Error ? error.message : '检查更新失败');
  }
}

async function openExternalUrl(url: string): Promise<void> {
  const target = url.trim();
  if (!target) {
    return;
  }
  try {
    await sendBridgeRequest('app:openExternal', { url: target });
  } catch (error) {
    showToast(error instanceof Error ? error.message : '无法打开链接');
  }
}

function renderUpdateDialog(): string {
  const info = state.updateDialog;
  if (!info) {
    return '';
  }
  const title = info.updateAvailable ? '发现新版本' : info.configured === false ? '更新未配置' : '检查更新';
  const verLine =
    info.latestVersion && info.currentVersion
      ? `<div class="update-ver">当前 <strong>v${escapeHtml(info.currentVersion)}</strong>${
          info.updateAvailable
            ? ` → 最新 <strong>v${escapeHtml(info.latestVersion)}</strong>`
            : ''
        }</div>`
      : `<div class="update-ver">当前 <strong>v${escapeHtml(info.currentVersion || __APP_VERSION__)}</strong></div>`;
  const notes = (info.notes || '').trim();
  const notesHtml = notes
    ? `<pre class="update-notes">${escapeHtml(notes.slice(0, 1200))}${notes.length > 1200 ? '…' : ''}</pre>`
    : '';
  const primaryUrl = info.downloadUrl || info.htmlUrl || info.releasesUrl || '';
  const primaryLabel = info.downloadUrl ? '下载安装包' : info.updateAvailable ? '查看 Release' : '打开 Releases';
  const secondaryUrl = info.repoUrl || '';

  return `
  <div class="update-overlay" data-update-overlay>
    <div class="update-card" role="dialog" aria-label="检查更新">
      <div class="update-top">
        <div class="brand-mark">${hatSvg(11)}</div>
        <div class="update-title">${escapeHtml(title)}</div>
        <button class="icon-btn" type="button" data-update-close style="margin-left:auto">✕</button>
      </div>
      <p class="update-msg">${escapeHtml(info.message || '')}</p>
      ${verLine}
      ${notesHtml}
      <div class="update-actions">
        ${
          primaryUrl
            ? `<button type="button" class="btn-primary" data-update-open="${escapeHtml(primaryUrl)}">${primaryLabel}</button>`
            : ''
        }
        ${
          secondaryUrl && secondaryUrl !== primaryUrl
            ? `<button type="button" class="btn-secondary" data-update-open="${escapeHtml(secondaryUrl)}">GitHub 仓库</button>`
            : ''
        }
        <button type="button" class="btn-secondary" data-update-close>关闭</button>
      </div>
    </div>
  </div>`;
}

function renderAppMenu(): string {
  if (!state.menuOpen) {
    return '';
  }
  const themeSeg = (id: 'system' | 'light' | 'dark', label: string) =>
    `<button type="button" class="menu-theme-opt ${state.themePreference === id ? 'active' : ''}" data-theme-pref="${id}">${label}</button>`;

  return `
  <div class="menu-backdrop" data-menu-backdrop></div>
  <div class="app-menu" role="menu" aria-label="主菜单">
    <div class="menu-section-label">文件</div>
    <button type="button" class="menu-item" data-menu="new">新建<span class="kbd">Ctrl+N</span></button>
    <button type="button" class="menu-item" data-menu="open">打开…<span class="kbd">Ctrl+O</span></button>
    <button type="button" class="menu-item" data-menu="save">保存 / 另存为<span class="kbd">Ctrl+S</span></button>
    <div class="menu-section-label" style="margin-top:4px">导出 / 打印</div>
    <button type="button" class="menu-item" data-menu="print">打印…<span class="kbd">Ctrl+P</span></button>
    <div class="menu-item menu-parent" tabindex="0" role="menuitem" aria-haspopup="true">
      <span>导出</span><span class="chev">›</span>
      <div class="menu-sub" role="menu" aria-label="导出格式">
        <button type="button" class="menu-item" data-menu="export-html">HTML<span class="kbd">网页</span></button>
        <button type="button" class="menu-item" data-menu="export-pdf">PDF<span class="kbd">打印页</span></button>
        <button type="button" class="menu-item" data-menu="export-word">Word<span class="kbd">.docx</span></button>
        <button type="button" class="menu-item" data-menu="export-png">PNG<span class="kbd">图片</span></button>
      </div>
    </div>

    <div class="menu-section-label menu-section-divider">视图</div>
    <div class="menu-item menu-item-static">主题
      <span class="menu-theme-seg">
        ${themeSeg('system', '系统')}
        ${themeSeg('light', '浅')}
        ${themeSeg('dark', '深')}
      </span>
    </div>
    <button type="button" class="menu-item" data-menu="outline">大纲面板${state.showOutline ? '<span class="menu-check">✦</span>' : ''}</button>
    <button type="button" class="menu-item" data-menu="status">状态栏${state.showStatus ? '<span class="menu-check">✦</span>' : ''}</button>

    <div class="menu-section-label menu-section-divider">工具</div>
    <button type="button" class="menu-item" data-menu="upload-all">上传全部本地图片到图床</button>
    <button type="button" class="menu-item" data-menu="search">查找…<span class="kbd">Ctrl+F</span></button>
    <button type="button" class="menu-item" data-menu="replace">替换…<span class="kbd">Ctrl+H</span></button>
    <div class="menu-item menu-parent" tabindex="0" role="menuitem" aria-haspopup="true">
      <span>✦ AI 处理</span><span class="chev">›</span>
      <div class="menu-sub" role="menu" aria-label="AI 处理">
        <button type="button" class="menu-item" data-menu="ai-chat">✦ AI 对话…<span class="kbd">侧栏</span></button>
        <button type="button" class="menu-item" data-menu="ai-polish">润色选中</button>
        <button type="button" class="menu-item" data-menu="ai-continue">续写下一段</button>
        <button type="button" class="menu-item" data-menu="ai-translate">翻译选中</button>
      </div>
    </div>
    <button type="button" class="menu-item" data-menu="history">版本历史<span class="kbd">Ctrl+Shift+H</span></button>
    <button type="button" class="menu-item" data-menu="plugins">插件…</button>
    <button type="button" class="menu-item" data-menu="settings">设置…<span class="kbd">Ctrl+,</span></button>

    <div class="menu-section-label menu-section-divider">帮助</div>
    <button type="button" class="menu-item" data-menu="shortcuts">快捷键一览</button>
    <button type="button" class="menu-item" data-menu="update">检查更新</button>
    <button type="button" class="menu-item" data-menu="about">关于</button>
  </div>`;
}

function bindRichEditor(): void {
  if (state.view !== 'editor' || state.mode !== 'rich') {
    rich?.destroy();
    rich = undefined;
    richRoot = undefined;
    return;
  }

  const root = document.querySelector<HTMLElement>('[data-rich-root]');
  if (!root) {
    return;
  }
  if (rich && richRoot === root) {
    return;
  }
  // Destroy immediately so a mode switch doesn't leave a stale instance.
  rich?.destroy();
  rich = undefined;
  richRoot = root;
  const mountToken = root;
  // Instant text while Crepe chunk loads (file-association cold path).
  if (!mountToken.childElementCount) {
    const preview = state.markdown.slice(0, 12000);
    mountToken.innerHTML = `<pre class="editor-boot-md">${preview
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')}</pre>`;
  }
  void import('./editor/rich')
    .then(({ mountRichEditor }) => {
      if (state.view !== 'editor' || state.mode !== 'rich' || richRoot !== mountToken) {
        return;
      }
      const live = document.querySelector<HTMLElement>('[data-rich-root]');
      if (live !== mountToken) {
        return;
      }
      mountToken.replaceChildren();
      rich = mountRichEditor(mountToken, '', (markdown) => {
        if (suppressRichChange) {
          return;
        }
        state.markdown = collapseAssetUrls(toStorageMarkdown(markdown));
        recomputeDirty(false);
        scheduleOutlineRefresh();
      });
      return rich.ready.then(() => applyRichMarkdown(state.markdown, { acceptAsSaved: !state.isDirty }));
    })
    .catch(() => {
      if (richRoot === mountToken) {
        showToast('富文本编辑器加载失败');
      }
    });
}

function bindSourceEditor(): void {
  if (state.view !== 'editor' || (state.mode !== 'src' && state.mode !== 'split')) {
    source?.destroy();
    source = undefined;
    sourceRoot = undefined;
    return;
  }

  const root = document.querySelector<HTMLElement>('[data-source-root]');
  if (!root) {
    return;
  }
  if (source && sourceRoot === root) {
    return;
  }
  source?.destroy();
  source = undefined;
  sourceRoot = root;
  const mountToken = root;
  void import('./editor/source')
    .then(({ mountSourceEditor }) => {
      if (
        state.view !== 'editor' ||
        (state.mode !== 'src' && state.mode !== 'split') ||
        sourceRoot !== mountToken
      ) {
        return;
      }
      const live = document.querySelector<HTMLElement>('[data-source-root]');
      if (live !== mountToken) {
        return;
      }
      source = mountSourceEditor(
        mountToken,
        state.markdown,
        (markdown) => {
          if (suppressSourceChange) {
            return;
          }
          onMarkdownEdited(markdown);
        },
        { dark: state.theme === 'dark' }
      );
    })
    .catch(() => {
      if (sourceRoot === mountToken) {
        showToast('源码编辑器加载失败');
      }
    });
}

function bindEvents(): void {
  app.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const action = el.dataset.action;
      if (action === 'new') void newDocument();
      if (action === 'open') void openDocument();
      if (action === 'toggle-menu') {
        setMenuOpen(!state.menuOpen);
      }
      if (action === 'toggle-focus') {
        state.focus = !state.focus;
        state.menuOpen = false;
        render();
      }
      if (action === 'toggle-ai') {
        toggleAiPanel();
      }
      if (action === 'toggle-theme') {
        setThemePreference(state.theme === 'dark' ? 'light' : 'dark');
        render();
      }
      if (action === 'open-settings') {
        state.settingsOpen = true;
        state.menuOpen = false;
        if (state.settingsTab === 'history') {
          void loadHistory().then(() => render());
        }
        render();
      }
      if (action === 'close-settings') {
        state.settingsOpen = false;
        render();
      }
      if (action === 'check-update') {
        void checkForUpdates();
      }
      if (action === 'close-history') {
        state.historyOpen = false;
        render();
      }
      if (action === 'save-editor-settings') {
        const font = app.querySelector<HTMLInputElement>('[data-setting-font]');
        const line = app.querySelector<HTMLInputElement>('[data-setting-line]');
        const snap = app.querySelector<HTMLInputElement>('[data-setting-snapshot]');
        const scale = app.querySelector<HTMLSelectElement>('[data-setting-ui-scale]');
        const lineWidth = app.querySelector<HTMLSelectElement>('[data-setting-line-width]');
        const defaultMode = app.querySelector<HTMLSelectElement>('[data-setting-default-mode]');
        const fontSize = Number(font?.value ?? state.fontSize);
        const lineHeight = Number(line?.value ?? state.lineHeight);
        const autoSnapshotMinutes = Number(snap?.value ?? state.autoSnapshotMinutes);
        const uiScale = Number(scale?.value ?? state.uiScale);
        if (fontSize >= 12 && fontSize <= 24) state.fontSize = fontSize;
        if (lineHeight >= 1.2 && lineHeight <= 2.4) {
          state.lineHeight = Math.round(lineHeight * 10) / 10;
        }
        if (autoSnapshotMinutes >= 0 && autoSnapshotMinutes <= 240) {
          state.autoSnapshotMinutes = Math.round(autoSnapshotMinutes);
        }
        if (uiScale >= 0.85 && uiScale <= 1.3) state.uiScale = uiScale;
        if (lineWidth?.value === 'narrow' || lineWidth?.value === 'standard' || lineWidth?.value === 'full') {
          state.lineWidth = lineWidth.value;
        }
        if (defaultMode?.value === 'src' || defaultMode?.value === 'split' || defaultMode?.value === 'rich') {
          state.defaultMode = defaultMode.value;
        }
        applyTheme();
        scheduleAutoSnapshot();
        void persistSettings()
          .then(() => showToast('编辑器设置已保存'))
          .catch(() => showToast('设置保存失败'));
        render();
      }
      if (action === 'toggle-auto-pair') {
        state.autoPairBrackets = !state.autoPairBrackets;
        void persistSettings();
        render();
      }
      if (action === 'toggle-expand-md') {
        state.expandMarkdownOnCaret = !state.expandMarkdownOnCaret;
        void persistSettings();
        render();
      }
      if (action === 'toggle-strip-paste') {
        state.stripPasteFormatting = !state.stripPasteFormatting;
        void persistSettings();
        render();
      }
      if (action === 'toggle-auto-space') {
        state.autoSpaceCjk = !state.autoSpaceCjk;
        void persistSettings();
        render();
      }
      if (action === 'close-search') {
        closeFindBar();
      }
      if (action === 'print-doc') {
        void printDocument();
      }
      if (action === 'save-ai') {
        const base = app.querySelector<HTMLInputElement>('[data-ai-base]');
        const model = app.querySelector<HTMLInputElement>('[data-ai-model]');
        const key = app.querySelector<HTMLInputElement>('[data-ai-key]');
        if (base) state.aiBaseUrl = base.value.trim() || state.aiBaseUrl;
        if (model) state.aiModel = model.value.trim() || state.aiModel;
        if (key && key.value && key.value !== '********') {
          state.aiApiKey = key.value.trim();
          state.hasAiKey = true;
        }
        void persistSettings()
          .then(() => {
            showToast('AI 配置已保存');
            return loadSettings();
          })
          .then(() => render())
          .catch(() => showToast('保存失败'));
      }
      if (action === 'ai-test') {
        void (async () => {
          try {
            const base = app.querySelector<HTMLInputElement>('[data-ai-base]');
            const model = app.querySelector<HTMLInputElement>('[data-ai-model]');
            const key = app.querySelector<HTMLInputElement>('[data-ai-key]');
            if (base) state.aiBaseUrl = base.value.trim() || state.aiBaseUrl;
            if (model) state.aiModel = model.value.trim() || state.aiModel;
            if (key && key.value && key.value !== '********') {
              state.aiApiKey = key.value.trim();
            }
            await persistSettings();
            const result = await sendBridgeRequest<{ content: string }>('ai:complete', {
              action: 'polish',
              text: '你好，世界。',
              context: ''
            });
            showToast(result.content ? `连接成功：${result.content.slice(0, 40)}…` : '连接成功');
          } catch (error) {
            showToast(error instanceof Error ? error.message : '测试失败');
          }
        })();
      }
      if (action === 'ai-polish') {
        void runAiAction('polish');
      }
      if (action === 'save-host') {
        void (async () => {
          collectHostFields();
          const cfg = hostConfig(state.defaultHost);
          if (state.defaultHost === 'github' || state.defaultHost === 'smms' || state.defaultHost === 'custom') {
            await persistSecret(state.defaultHost, 'secret', cfg.token ?? '');
          }
          if (state.defaultHost === 's3') {
            await persistSecret('s3', 'secret', cfg.secretKey ?? '');
            await persistSecret('s3', 'accessKey', cfg.accessKey ?? '');
          }
          await persistSettings();
          showToast('图床配置已保存');
        })();
      }
      if (action === 'test-host') {
        void (async () => {
          collectHostFields();
          const cfg = hostConfig(state.defaultHost);
          if (state.defaultHost === 'github' || state.defaultHost === 'smms' || state.defaultHost === 'custom') {
            await persistSecret(state.defaultHost, 'secret', cfg.token ?? '');
          }
          if (state.defaultHost === 's3') {
            await persistSecret('s3', 'secret', cfg.secretKey ?? '');
            await persistSecret('s3', 'accessKey', cfg.accessKey ?? '');
          }
          await persistSettings();
          try {
            const result = await sendBridgeRequest<{ ok: boolean; message: string }>('provider:testConnection', {
              hostId: state.defaultHost
            });
            const el = app.querySelector('[data-host-test]');
            if (el) {
              el.textContent = `${result.ok ? '✦' : '×'} ${result.message}`;
              (el as HTMLElement).style.color = result.ok ? 'var(--ok)' : 'var(--danger)';
            }
          } catch (error) {
            showToast(error instanceof Error ? error.message : '测试失败');
          }
        })();
      }
      if (action === 'toggle-paste-upload') {
        state.pasteUploadImages = !state.pasteUploadImages;
        void persistSettings();
        render();
      }
      if (action === 'toggle-keep-local') {
        state.keepLocalOnUploadFailure = !state.keepLocalOnUploadFailure;
        void persistSettings();
        render();
      }
      if (action === 'save-snapshot') {
        void saveHistorySnapshot('manual');
      }
      if (action === 'refresh-history') {
        void loadHistory().then(() => render());
      }
    });
  });

  function collectHostFields(): void {
    app.querySelectorAll<HTMLInputElement>('[data-host-field]').forEach((input) => {
      const key = input.dataset.hostField;
      if (key) {
        setHostField(state.defaultHost, key, input.value);
      }
    });
  }

  app.querySelectorAll<HTMLElement>('[data-mode]').forEach((el) => {
    el.addEventListener('click', () => {
      const mode = el.dataset.mode as EditorMode;
      setMode(mode);
    });
  });

  app.querySelectorAll<HTMLElement>('[data-open-recent]').forEach((el) => {
    el.addEventListener('click', () => {
      const path = el.dataset.openRecent;
      if (path) void openDocument(path);
    });
  });

  app.querySelectorAll<HTMLElement>('[data-settings-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      state.settingsTab = el.dataset.settingsTab as SettingsTab;
      if (state.settingsTab === 'history') {
        void loadHistory().then(() => render());
      } else {
        render();
      }
    });
  });

  app.querySelectorAll<HTMLElement>('[data-host]').forEach((el) => {
    el.addEventListener('click', () => {
      state.defaultHost = el.dataset.host ?? 'local';
      void persistSettings();
      render();
      showToast(`默认图床：${HOSTS.find((h) => h.id === state.defaultHost)?.title ?? state.defaultHost}`);
    });
  });

  const AI_PRESETS: Record<string, { baseUrl: string; model: string }> = {
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5' }
  };
  app.querySelectorAll<HTMLElement>('[data-ai-preset]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.aiPreset ?? '';
      const p = AI_PRESETS[id];
      if (!p) return;
      state.aiBaseUrl = p.baseUrl;
      state.aiModel = p.model;
      const base = app.querySelector<HTMLInputElement>('[data-ai-base]');
      const model = app.querySelector<HTMLInputElement>('[data-ai-model]');
      if (base) base.value = p.baseUrl;
      if (model) model.value = p.model;
      showToast(`已填入 ${id} 预设，请填写 Key 后保存`);
    });
  });

  app.querySelectorAll<HTMLElement>('[data-export]').forEach((el) => {
    el.addEventListener('click', () => {
      const format = el.dataset.export as 'html' | 'pdf' | 'word' | 'png';
      void exportDocument(format);
    });
  });

  app.querySelectorAll<HTMLElement>('[data-restore]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.restore;
      if (id) {
        void restoreSnapshot(id);
      }
    });
  });

  app.querySelectorAll<HTMLElement>('[data-history-diff]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.historyDiff;
      if (!id) return;
      void (async () => {
        try {
          const result = await sendBridgeRequest<{ markdown: string }>('history:load', { id });
          state.historyDiffId = id;
          state.historyDiffText = result.markdown ?? '';
          render();
        } catch (error) {
          showToast(error instanceof Error ? error.message : '读取快照失败');
        }
      })();
    });
  });



  // Split pane sync scroll
  const sourcePane = app.querySelector<HTMLElement>('.source-pane .cm-scroller, .source-pane textarea');
  const previewPane = app.querySelector<HTMLElement>('.preview-pane');
  if (sourcePane && previewPane && state.mode === 'split') {
    let syncing = false;
    const link = (from: HTMLElement, to: HTMLElement) => {
      from.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        const maxFrom = from.scrollHeight - from.clientHeight;
        const maxTo = to.scrollHeight - to.clientHeight;
        const ratio = maxFrom > 0 ? from.scrollTop / maxFrom : 0;
        to.scrollTop = ratio * Math.max(0, maxTo);
        syncing = false;
      });
    };
    // CodeMirror scroller
    const cmScroll = app.querySelector<HTMLElement>('.source-pane .cm-scroller');
    if (cmScroll) {
      link(cmScroll, previewPane);
      link(previewPane, cmScroll);
    }
  }

  const sourceTa = app.querySelector<HTMLTextAreaElement>('[data-source]');
  sourceTa?.addEventListener('keyup', () => trackCursorFromSource());
  sourceTa?.addEventListener('click', () => trackCursorFromSource());
  // CM cursor via poll on input already updates outline; track line from source editor if present
  document.addEventListener(
    'selectionchange',
    () => {
      if (state.mode === 'src' || state.mode === 'split') {
        trackCursorFromSource();
      }
    },
    { passive: true }
  );

  app.querySelector('[data-history-overlay]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      state.historyOpen = false;
      render();
    }
  });

  // Menu open/close uses setMenuOpen; re-bind if menu was included in full render.
  if (state.menuOpen) {
    bindMenuEvents();
  }

  app.querySelector('.outline')?.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-outline-line]');
    if (!btn) {
      return;
    }
    event.preventDefault();
    const line = Number(btn.dataset.outlineLine);
    const index = Number(btn.dataset.outlineIndex);
    if (!Number.isNaN(line)) {
      jumpToOutlineLine(line, Number.isNaN(index) ? undefined : index);
    }
  });

  app.querySelectorAll<HTMLElement>('[data-win]').forEach((el) => {
    el.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });
    el.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = el.dataset.win;
      if (action) {
        void handleWindowControl(action);
      }
    });
  });
  // Prevent accidental drag-start when clicking interactive titlebar controls.
  app.querySelectorAll<HTMLElement>('.titlebar button, .titlebar .seg, .titlebar .focus-toggle').forEach((el) => {
    el.addEventListener('pointerdown', (event) => event.stopPropagation());
  });

  const paletteInput = app.querySelector<HTMLInputElement>('[data-palette-input]');
  paletteInput?.addEventListener('input', () => {
    state.paletteQuery = paletteInput.value;
    render();
    const next = app.querySelector<HTMLInputElement>('[data-palette-input]');
    if (next) {
      next.focus();
      next.selectionStart = next.selectionEnd = next.value.length;
    }
  });

  app.querySelectorAll<HTMLElement>('[data-palette-run]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.paletteRun;
      const item = paletteItems().find((x) => x.id === id);
      state.paletteOpen = false;
      item?.run();
      if (id !== 'search' && id !== 'replace') {
        render();
      }
    });
  });

  app.querySelector('[data-palette]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      state.paletteOpen = false;
      render();
    }
  });

  app.querySelector('[data-settings-overlay]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      state.settingsOpen = false;
      render();
    }
  });

  const closeUpdate = () => {
    state.updateDialog = null;
    render();
  };
  app.querySelectorAll<HTMLElement>('[data-update-close]').forEach((el) => {
    el.addEventListener('click', closeUpdate);
  });
  app.querySelector('[data-update-overlay]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      closeUpdate();
    }
  });
  app.querySelectorAll<HTMLElement>('[data-update-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const url = el.dataset.updateOpen;
      if (url) {
        void openExternalUrl(url);
      }
    });
  });
}

function render(): void {
  applyTheme();
  app.innerHTML = state.view === 'welcome' ? renderWelcome() : renderEditor();
  bindEvents();
  bindRichEditor();
  bindSourceEditor();
  bindAiPanel();
  if (state.searchOpen) {
    ensureFindBar();
  }
  void applyWindowLayoutForView(state.view);
}

function onKeyDown(event: KeyboardEvent): void {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (event.key === 'F3') {
    event.preventDefault();
    event.stopPropagation();
    if (state.view !== 'editor') {
      return;
    }
    findStep(event.shiftKey ? -1 : 1);
    return;
  }
  if (mod && key === 'k') {
    event.preventDefault();
    state.paletteOpen = !state.paletteOpen;
    state.paletteQuery = '';
    closeFindBar();
    render();
    app.querySelector<HTMLInputElement>('[data-palette-input]')?.focus();
    return;
  }
  if (mod && event.shiftKey && key === 'f') {
    event.preventDefault();
    event.stopPropagation();
    openFindBar(false);
    return;
  }
  if (mod && event.shiftKey && key === 'h') {
    event.preventDefault();
    event.stopPropagation();
    state.menuOpen = false;
    state.historyOpen = true;
    void loadHistory().then(() => render());
    return;
  }
  if (mod && !event.shiftKey && key === 'f') {
    event.preventDefault();
    event.stopPropagation();
    openFindBar(false);
    return;
  }
  if (mod && !event.shiftKey && key === 'h') {
    event.preventDefault();
    event.stopPropagation();
    openFindBar(true);
    return;
  }
  if (mod && event.key.toLowerCase() === 'p') {
    event.preventDefault();
    void printDocument();
    return;
  }
  if (mod && event.key.toLowerCase() === 's') {
    event.preventDefault();
    event.stopPropagation();
    // Ignore key repeat while a save dialog / write is already running.
    if (event.repeat || saveInFlight) {
      return;
    }
    void saveDocument(event.shiftKey);
    return;
  }
  if (mod && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    void openDocument();
    return;
  }
  if (mod && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    void newDocument();
    return;
  }
  if (mod && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    state.focus = !state.focus;
    state.menuOpen = false;
    render();
    return;
  }
  if (mod && event.key === ',') {
    event.preventDefault();
    state.menuOpen = false;
    state.settingsOpen = true;
    render();
    return;
  }
  if (event.key === 'Escape') {
    if (state.menuOpen) {
      setMenuOpen(false);
    } else if (state.paletteOpen) {
      state.paletteOpen = false;
      render();
    } else if (state.searchOpen) {
      closeFindBar();
    } else if (state.historyOpen) {
      state.historyOpen = false;
      render();
    } else if (state.settingsOpen) {
      state.settingsOpen = false;
      render();
    } else if (state.focus) {
      state.focus = false;
      render();
    }
  }
}

declare global {
  interface Window {
    mahodown?: {
      getMarkdown: () => string;
      isDirty: () => boolean;
      checkDirty: () => boolean;
      applyRecovery: (markdown: string, filePath?: string | null) => void;
    };
  }
}

window.mahodown = {
  getMarkdown: () => normalizeMarkdown(getCurrentMarkdown()),
  isDirty: () => recomputeDirty(false),
  checkDirty: () => {
    const dirty = currentStorageMarkdown() !== lastSavedMarkdown;
    state.isDirty = dirty;
    updateSaveChrome();
    return dirty;
  },
  applyRecovery: (markdown, filePath) => {
    state.view = 'editor';
    state.filePath = filePath ?? undefined;
    clearAssetCache();
    state.markdown = markdown;
    // Recovery content is unsaved by definition.
    lastSavedMarkdown = normalizeMarkdown(markdown + '\0'); // force dirty
    state.isDirty = true;
    render();
    void sendBridgeRequest('app:setDirtyState', { isDirty: true }).catch(() => undefined);
  }
};

window.addEventListener('keydown', onKeyDown, true);

document.addEventListener('dragover', (event) => {
  // Allow HTML5 DnD (Milkdown block reorder + image files).
  // Only set copy dropEffect for external files; leave internal drags alone.
  const types = event.dataTransfer?.types;
  if (types && Array.from(types).includes('Files')) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }
});

document.addEventListener('drop', (event) => {
  const file = firstImageFile(event.dataTransfer?.files);
  if (!file) {
    return;
  }
  event.preventDefault();
  if (state.view !== 'editor') {
    return;
  }
  void insertImageFromFile(file);
});

// Capture phase so Milkdown / ProseMirror don't also insert a second image.
document.addEventListener(
  'paste',
  (event) => {
    if (state.view !== 'editor' || !state.pasteUploadImages) {
      return;
    }
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void insertImageFromFile(file);
        }
        break;
      }
    }
  },
  true
);

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.themePreference === 'system') {
    applyTheme();
  }
});

// Theme/mode from last session before any IPC — kills first-frame flash.
applyBootCache();
applyTheme();
scheduleAutoSnapshot();
// Keep the HTML splash until the first real frame; don't render() yet if we can
// jump straight into a launch document after one IPC.

/** Window is visible from native config; focus is enough. */
async function focusWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setFocus();
  } catch {
    // browser / no window API
  }
}

// Prefetch heavy editor chunks after first interactive frame.
function warmEditorChunks(): void {
  void import('./editor/rich');
  void import('./editor/source');
  void preloadHighlight();
}

function applyLaunchDocument(filePath: string, markdown: string): void {
  state.view = 'editor';
  state.filePath = filePath;
  clearAssetCache();
  state.markdown = markdown;
  lastSavedMarkdown = normalizeMarkdown(markdown);
  state.isDirty = false;
  // Native side already sized the window for editor — skip resize hop.
  lastLayoutView = 'editor';
}

void (async () => {
  void focusWindow();

  try {
    const ready = await sendBridgeRequest<{
      isReady?: boolean;
      captionInsetPx?: number;
      openPath?: string | null;
      markdown?: string | null;
      settings?: SettingsPayload;
      recent?: RecentItem[];
    }>('app:editorReady', { isReady: true });
    state.isReady = true;
    state.captionInset =
      typeof ready?.captionInsetPx === 'number' && ready.captionInsetPx > 0 ? ready.captionInsetPx : 0;

    if (ready?.settings) {
      // Launch doc: don't clobber mode mid-open unless welcome.
      applySettingsObject(ready.settings, { forceMode: !ready.openPath });
    }
    if (Array.isArray(ready?.recent)) {
      state.recent = ready.recent;
    }

    if (ready?.openPath && typeof ready.markdown === 'string') {
      applyLaunchDocument(ready.openPath, ready.markdown);
      applyTheme();
      render();
      warmEditorChunks();
      void sendBridgeRequest('app:setDirtyState', { isDirty: false }).catch(() => undefined);
      return;
    }

    if (ready?.openPath) {
      // Path without bytes (read failed earlier) — fall back to normal open.
      applyTheme();
      render();
      warmEditorChunks();
      await openDocument(ready.openPath).catch(() => undefined);
      return;
    }
  } catch {
    state.isReady = true;
    await loadSettings().catch(() => undefined);
  }

  // Welcome path: settings/recent already applied when ready succeeded.
  if (!state.recent.length) {
    await loadRecent().catch(() => undefined);
  }
  applyTheme();
  scheduleAutoSnapshot();
  render();
  warmEditorChunks();
  showToast('Ctrl+K 命令 · Ctrl+E 专注 · Ctrl+S 保存 · 可粘贴/拖入图片', 3600);
})();

void (async () => {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await refreshMaximizeIcon();
    await win.onResized(() => {
      void refreshMaximizeIcon();
    });
  } catch {
    // browser / no window API
  }
})();
