using System.Runtime.InteropServices.WindowsRuntime;
using System.Text.Json;
using MahoDown.Core.Bridge;
using MahoDown.Core.Documents;
using MahoDown.Core.Export;
using MahoDown.Core.History;
using MahoDown.Core.Images;
using MahoDown.Core.Recovery;
using MahoDown.Core.Settings;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using Windows.Graphics;
using Windows.Storage.Streams;

namespace MahoDown.App;

public sealed partial class MainWindow : Window
{
    private const string AppHostName = "app.mahodown.local";
    private const string DocHostName = "doc.mahodown.local";
    private const string AppOrigin = "https://app.mahodown.local";
    private static readonly Uri AppStartUri = new($"{AppOrigin}/index.html");
    private static readonly TimeSpan RecoveryDraftSaveDelay = TimeSpan.FromMilliseconds(500);
    private static readonly HashSet<string> AppAssetPrefixes = new(StringComparer.OrdinalIgnoreCase)
    {
        "index.html",
        "assets"
    };

    private readonly MarkdownDocumentService _documents = new();
    private readonly JsonSettingsStore _settingsStore;
    private readonly SecretStore _secretStore;
    private readonly RecoveryDraftService _recoveryDrafts;
    private readonly SnapshotService _snapshots;
    private readonly HtmlExportService _htmlExport = new();
    private readonly WordExportService _wordExport = new();
    private readonly BridgeDispatcher _dispatcher;
    private readonly ImageHostRegistry _imageHosts = new();

    private AppWindow? _appWindow;
    private string? _currentFilePath;
    private bool _isDirty;
    private bool _allowClose;
    private bool _hasCheckedRecoveryDrafts;
    private CancellationTokenSource? _recoveryDraftDebounceCancellation;

    public MainWindow()
    {
        InitializeComponent();

        var appData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MahoDown");
        _settingsStore = new JsonSettingsStore(Path.Combine(appData, "settings.json"));
        _secretStore = new SecretStore(Path.Combine(appData, "secrets"));
        _recoveryDrafts = new RecoveryDraftService(Path.Combine(appData, "RecoveryDrafts"));
        _snapshots = new SnapshotService(Path.Combine(appData, "Snapshots"));
        _dispatcher = new BridgeDispatcher(_documents, _settingsStore, _snapshots, _imageHosts, ResolveHostConfig);

        ExtendsContentIntoTitleBar = true;
        ConfigureCloseConfirmation();
        // No full-width SetTitleBar overlay: it blocks WebView clicks (hat/mode).
        // Drag empty strips only via SetDragRectangles (physical pixels).
        SizeChanged += (_, _) => UpdateTitleBarDragRegions();
        Activated += (_, _) => UpdateTitleBarDragRegions();
        RootGrid.Loaded += (_, _) => UpdateTitleBarDragRegions();
        _ = StartWebViewAsync();
    }

    private ImageHostConfig ResolveHostConfig(AppSettings settings, string hostId)
    {
        if (!settings.ImageHostConfigs.TryGetValue(hostId, out var map))
        {
            map = new Dictionary<string, string>();
        }

        var merged = new Dictionary<string, string>(map, StringComparer.OrdinalIgnoreCase);
        foreach (var key in new[] { "token", "secretKey", "accessKey", "secret" })
        {
            if (merged.TryGetValue(key, out var masked) && masked == "********")
            {
                merged.Remove(key);
            }
        }

        var secret = _secretStore.GetAsync($"{hostId}:secret", CancellationToken.None).GetAwaiter().GetResult();
        var accessKey = _secretStore.GetAsync($"{hostId}:accessKey", CancellationToken.None).GetAwaiter().GetResult();
        if (!string.IsNullOrWhiteSpace(secret))
        {
            if (hostId is "github" or "smms" or "custom")
            {
                merged["token"] = secret;
            }
            else if (hostId == "s3")
            {
                merged["secretKey"] = secret;
            }
        }

        if (hostId == "s3" && !string.IsNullOrWhiteSpace(accessKey))
        {
            merged["accessKey"] = accessKey;
        }

        return new ImageHostConfig(merged);
    }

    private async Task StartWebViewAsync()
    {
        try
        {
            await InitializeWebViewAsync();
        }
        catch (Exception)
        {
            EditorWebView.Visibility = Visibility.Collapsed;
            WebViewInitializationError.Visibility = Visibility.Visible;
        }
    }

    private async Task InitializeWebViewAsync()
    {
        await EditorWebView.EnsureCoreWebView2Async();
        var webRoot = Path.Combine(AppContext.BaseDirectory, "EditorWeb");
        EditorWebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            AppHostName,
            webRoot,
            CoreWebView2HostResourceAccessKind.DenyCors);
        RefreshDocumentHostMapping();
        EditorWebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
        EditorWebView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        EditorWebView.CoreWebView2.NavigationStarting += OnNavigationStarting;
        EditorWebView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        EditorWebView.CoreWebView2.AddWebResourceRequestedFilter(
            $"{AppOrigin}/*",
            CoreWebView2WebResourceContext.All);
        EditorWebView.CoreWebView2.AddWebResourceRequestedFilter(
            $"https://{DocHostName}/*",
            CoreWebView2WebResourceContext.All);
        EditorWebView.CoreWebView2.WebResourceRequested += OnWebResourceRequested;
        EditorWebView.Source = AppStartUri;
    }

    private void RefreshDocumentHostMapping()
    {
        var core = EditorWebView.CoreWebView2;
        if (core is null)
        {
            return;
        }

        string mapDir;
        if (!string.IsNullOrWhiteSpace(_currentFilePath))
        {
            mapDir = Path.GetDirectoryName(_currentFilePath) ?? Path.GetTempPath();
        }
        else
        {
            mapDir = Path.Combine(Path.GetTempPath(), "MahoDown", "empty-doc");
        }

        Directory.CreateDirectory(mapDir);
        core.SetVirtualHostNameToFolderMapping(
            DocHostName,
            mapDir,
            CoreWebView2HostResourceAccessKind.Allow);
    }

    private void OnWebResourceRequested(CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs args)
    {
        if (string.IsNullOrWhiteSpace(_currentFilePath))
        {
            return;
        }

        if (!Uri.TryCreate(args.Request.Uri, UriKind.Absolute, out var uri))
        {
            return;
        }

        var isAppHost = string.Equals(uri.Host, AppHostName, StringComparison.OrdinalIgnoreCase);
        var isDocHost = string.Equals(uri.Host, DocHostName, StringComparison.OrdinalIgnoreCase);
        if (!isAppHost && !isDocHost)
        {
            return;
        }

        var relative = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/'));
        if (string.IsNullOrWhiteSpace(relative))
        {
            return;
        }

        if (isAppHost)
        {
            var first = relative.Split('/', 2)[0];
            if (AppAssetPrefixes.Contains(first) || relative.Equals("favicon.ico", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
        }

        var docDir = Path.GetDirectoryName(_currentFilePath);
        if (string.IsNullOrWhiteSpace(docDir))
        {
            return;
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(Path.Combine(docDir, relative.Replace('/', Path.DirectorySeparatorChar)));
        }
        catch (Exception)
        {
            return;
        }

        var root = Path.GetFullPath(docDir)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        if (!fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))
        {
            return;
        }

        try
        {
            var bytes = File.ReadAllBytes(fullPath);
            var stream = new InMemoryRandomAccessStream();
            stream.WriteAsync(bytes.AsBuffer()).AsTask().GetAwaiter().GetResult();
            stream.Seek(0);
            args.Response = sender.Environment.CreateWebResourceResponse(
                stream,
                200,
                "OK",
                $"Content-Type: {GuessMime(fullPath)}\r\nCache-Control: no-cache");
        }
        catch (Exception)
        {
        }
    }

    private static string GuessMime(string path) =>
        Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".svg" => "image/svg+xml",
            ".bmp" => "image/bmp",
            ".md" => "text/markdown; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".js" => "text/javascript; charset=utf-8",
            ".json" => "application/json; charset=utf-8",
            _ => "application/octet-stream"
        };

    private void ConfigureCloseConfirmation()
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        var windowId = Microsoft.UI.Win32Interop.GetWindowIdFromWindow(hwnd);
        _appWindow = AppWindow.GetFromWindowId(windowId);
        _appWindow.Closing += OnAppWindowClosing;
        if (_appWindow.TitleBar is not null)
        {
            _appWindow.TitleBar.ExtendsContentIntoTitleBar = true;
        }

        UpdateTitleBarDragRegions();
    }

    private void UpdateTitleBarDragRegions()
    {
        if (_appWindow?.TitleBar is null)
        {
            return;
        }

        var scale = RootGrid.XamlRoot?.RasterizationScale
            ?? Content?.XamlRoot?.RasterizationScale
            ?? 1.0;
        // Layout sizes are DIP; SetDragRectangles wants physical pixels.
        var height = Math.Max(1, (int)Math.Round(38 * scale));
        var widthDip = RootGrid.XamlRoot?.Size.Width
            ?? Content?.XamlRoot?.Size.Width
            ?? _appWindow.Size.Width / scale;
        var width = Math.Max(1, (int)Math.Round(widthDip * scale));
        var rightInset = _appWindow.TitleBar.RightInset; // physical px

        // Interactive islands (DIP → physical), with a small gap so edges don't flicker.
        const int gapDip = 10;
        var leftEnd = (int)Math.Round((300 + gapDip) * scale);
        var centerHalf = (int)Math.Round((200 + gapDip) * scale);
        var centerLeft = Math.Max(leftEnd, width / 2 - centerHalf);
        var centerRight = Math.Min(width - rightInset, width / 2 + centerHalf);
        var dragRightEnd = width - rightInset;

        var rects = new List<RectInt32>();
        if (centerLeft - leftEnd > 8)
        {
            rects.Add(new RectInt32(leftEnd, 0, centerLeft - leftEnd, height));
        }

        if (dragRightEnd - centerRight > 8)
        {
            rects.Add(new RectInt32(centerRight, 0, dragRightEnd - centerRight, height));
        }

        if (rects.Count == 0 && dragRightEnd > leftEnd + 16)
        {
            var strip = Math.Min((int)Math.Round(56 * scale), dragRightEnd - leftEnd);
            rects.Add(new RectInt32(dragRightEnd - strip, 0, strip, height));
        }

        _appWindow.TitleBar.SetDragRectangles(rects.ToArray());
    }

    private void OnNavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs args)
    {
        if (!IsAllowedAppUri(args.Uri))
        {
            args.Cancel = true;
        }
    }

    private static bool IsAllowedAppUri(string? source) =>
        Uri.TryCreate(source, UriKind.Absolute, out var uri) && IsAllowedAppUri(uri);

    private static bool IsAllowedAppUri(Uri uri) =>
        uri.IsAbsoluteUri
        && string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
        && string.Equals(uri.Host, AppHostName, StringComparison.OrdinalIgnoreCase);

    private async void OnAppWindowClosing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (_allowClose)
        {
            return;
        }

        // Always ask the editor for the real dirty state (content vs last save).
        var dirty = await QueryWebDirtyAsync();
        _isDirty = dirty;
        if (!_isDirty)
        {
            return;
        }

        args.Cancel = true;
        if (await ShowConfirmationAsync("未保存的更改", "关闭文档而不保存？", "关闭"))
        {
            await _recoveryDrafts.DeleteAllDraftsAsync(CancellationToken.None);
            _allowClose = true;
            Close();
        }
    }

    private async Task<bool> QueryWebDirtyAsync()
    {
        try
        {
            var json = await ExecuteEditorScriptAsync(
                "(() => { try { return window.mahodown?.checkDirty?.() === true; } catch { return true; } })()");
            if (json is null || string.Equals(json, "null", StringComparison.Ordinal))
            {
                return _isDirty;
            }

            return string.Equals(json, "true", StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception)
        {
            return _isDirty;
        }
    }

    private async void OnWebMessageReceived(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (!IsAllowedAppUri(args.Source))
        {
            return;
        }

        var requestId = "unknown";
        BridgeResponse response;
        try
        {
            var request = JsonSerializer.Deserialize<BridgeRequest>(args.WebMessageAsJson, BridgeJson.Options);
            if (request is null || string.IsNullOrWhiteSpace(request.Id) || string.IsNullOrWhiteSpace(request.Command))
            {
                response = BridgeResponse.Failure("unknown", BridgeCommand.InvalidRequest, "Bridge request is invalid.");
            }
            else
            {
                requestId = request.Id;
                response = request.Command switch
                {
                    BridgeCommand.AppEditorReady => HandleEditorReady(request),
                    BridgeCommand.AppSetDirtyState => HandleDirtyState(request),
                    BridgeCommand.FileNew => await HandleFileNewAsync(request),
                    BridgeCommand.FileOpen => await HandleFileOpenAsync(request),
                    BridgeCommand.FileSave => await HandleFileSaveAsync(request),
                    BridgeCommand.FileSaveAs => await HandleFileSaveAsAsync(request),
                    BridgeCommand.AppGetRecentFiles => await HandleGetRecentFilesAsync(request),
                    BridgeCommand.AppSetSecret => await HandleSetSecretAsync(request),
                    BridgeCommand.ImageUpload => await HandleImageUploadAsync(request),
                    BridgeCommand.FileReadAsset => await HandleReadAssetAsync(request),
                    BridgeCommand.ExportFile => await HandleExportAsync(request),
                    _ => await _dispatcher.DispatchAsync(request, CancellationToken.None)
                };
            }
        }
        catch (JsonException)
        {
            response = BridgeResponse.Failure(requestId, BridgeCommand.InvalidRequest, "Bridge request is invalid.");
        }
        catch (Exception)
        {
            response = BridgeResponse.Failure(requestId, "bridge_exception", "Bridge request failed.");
        }

        try
        {
            sender.PostWebMessageAsJson(JsonSerializer.Serialize(response, BridgeJson.Options));
        }
        catch (Exception)
        {
        }
    }

    private BridgeResponse HandleEditorReady(BridgeRequest request)
    {
        QueueRecoveryDraftRestoreCheck();
        var captionInset = _appWindow?.TitleBar?.RightInset ?? 140;
        return BridgeResponse.Success(request.Id, new
        {
            isReady = true,
            captionInsetPx = captionInset
        });
    }

    private BridgeResponse HandleDirtyState(BridgeRequest request)
    {
        DirtyStatePayload? payload = null;
        try
        {
            payload = request.Payload.Deserialize<DirtyStatePayload>(BridgeJson.Options);
        }
        catch (JsonException)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Dirty state payload is invalid.");
        }

        _isDirty = payload?.IsDirty ?? false;
        UpdateTitle();
        if (_isDirty)
        {
            QueueRecoveryDraftSave();
        }

        return BridgeResponse.Success(request.Id, new { isDirty = _isDirty });
    }

    private async Task<BridgeResponse> HandleFileNewAsync(BridgeRequest request)
    {
        if (_isDirty && !await ShowConfirmationAsync("未保存的更改", "丢弃未保存的更改？", "丢弃"))
        {
            return BridgeResponse.Success(request.Id, new { cancelled = true });
        }

        _currentFilePath = null;
        _isDirty = false;
        UpdateTitle();
        RefreshDocumentHostMapping();
        await _recoveryDrafts.DeleteAllDraftsAsync(CancellationToken.None);
        return BridgeResponse.Success(request.Id, new
        {
            markdown = "# 未命名\n\n开始写作…\n",
            filePath = (string?)null,
            isDirty = false
        });
    }

    private async Task<BridgeResponse> HandleFileOpenAsync(BridgeRequest request)
    {
        if (_isDirty && !await ShowConfirmationAsync("未保存的更改", "丢弃未保存的更改？", "丢弃"))
        {
            return BridgeResponse.Success(request.Id, new { cancelled = true });
        }

        string? path = null;
        try
        {
            OpenPathPayload? payload = request.Payload.Deserialize<OpenPathPayload>(BridgeJson.Options);
            path = payload?.FilePath;
        }
        catch (JsonException)
        {
        }

        if (string.IsNullOrWhiteSpace(path))
        {
            var picker = new Windows.Storage.Pickers.FileOpenPicker();
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
            picker.FileTypeFilter.Add(".md");
            picker.FileTypeFilter.Add(".markdown");
            var file = await picker.PickSingleFileAsync();
            if (file is null)
            {
                return BridgeResponse.Success(request.Id, new { cancelled = true });
            }

            path = file.Path;
        }

        try
        {
            var state = await _documents.OpenAsync(path, CancellationToken.None);
            _currentFilePath = state.FilePath;
            _isDirty = false;
            UpdateTitle();
            RefreshDocumentHostMapping();
            await RememberRecentAsync(path);
            await _recoveryDrafts.DeleteAllDraftsAsync(CancellationToken.None);
            return BridgeResponse.Success(request.Id, new
            {
                markdown = state.Markdown,
                filePath = state.FilePath,
                isDirty = false
            });
        }
        catch (Exception)
        {
            return BridgeResponse.Failure(request.Id, "file_open_failed", "无法打开文件。");
        }
    }

    private async Task<BridgeResponse> HandleFileSaveAsync(BridgeRequest request)
    {
        if (string.IsNullOrWhiteSpace(_currentFilePath))
        {
            return await HandleFileSaveAsAsync(request);
        }

        return await SaveToPathAsync(request, _currentFilePath);
    }

    private async Task<BridgeResponse> HandleFileSaveAsAsync(BridgeRequest request)
    {
        var picker = new Windows.Storage.Pickers.FileSavePicker();
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        picker.FileTypeChoices.Add("Markdown", new List<string> { ".md" });
        picker.SuggestedFileName = string.IsNullOrWhiteSpace(_currentFilePath)
            ? "未命名"
            : Path.GetFileNameWithoutExtension(_currentFilePath);

        var file = await picker.PickSaveFileAsync();
        if (file is null)
        {
            return BridgeResponse.Success(request.Id, new { cancelled = true });
        }

        return await SaveToPathAsync(request, file.Path);
    }

    private async Task<BridgeResponse> SaveToPathAsync(BridgeRequest request, string filePath)
    {
        SaveMarkdownPayload? payload;
        try
        {
            payload = request.Payload.Deserialize<SaveMarkdownPayload>(BridgeJson.Options);
        }
        catch (JsonException)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Save payload is invalid.");
        }

        var markdown = payload?.Markdown ?? string.Empty;
        try
        {
            var state = DocumentState.NewUntitled().WithContent(markdown);
            var saved = await _documents.SaveAsync(state, filePath, CancellationToken.None);
            _currentFilePath = saved.FilePath;
            _isDirty = false;
            UpdateTitle();
            RefreshDocumentHostMapping();
            await RememberRecentAsync(filePath);
            await _recoveryDrafts.DeleteAllDraftsAsync(CancellationToken.None);
            try
            {
                await _snapshots.SaveAsync(filePath, markdown, "manual-save", CancellationToken.None);
            }
            catch (Exception)
            {
            }

            return BridgeResponse.Success(request.Id, new
            {
                filePath = saved.FilePath,
                isDirty = false,
                lastSavedAt = saved.LastSavedAt
            });
        }
        catch (Exception)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.FileSaveFailed, "文件保存失败。");
        }
    }

    private async Task<BridgeResponse> HandleSetSecretAsync(BridgeRequest request)
    {
        SecretPayload? payload;
        try
        {
            payload = request.Payload.Deserialize<SecretPayload>(BridgeJson.Options);
        }
        catch (JsonException)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Secret payload is invalid.");
        }

        if (payload is null || string.IsNullOrWhiteSpace(payload.HostId) || string.IsNullOrWhiteSpace(payload.Key))
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Secret payload is invalid.");
        }

        var storeKey = $"{payload.HostId}:{payload.Key}";
        if (string.IsNullOrEmpty(payload.Value))
        {
            await _secretStore.DeleteAsync(storeKey, CancellationToken.None);
        }
        else if (payload.Value != "********")
        {
            await _secretStore.SetAsync(storeKey, payload.Value, CancellationToken.None);
        }

        return BridgeResponse.Success(request.Id, new { saved = true });
    }

    private async Task<BridgeResponse> HandleExportAsync(BridgeRequest request)
    {
        ExportPayload? payload;
        try
        {
            payload = request.Payload.Deserialize<ExportPayload>(BridgeJson.Options);
        }
        catch (JsonException)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Export payload is invalid.");
        }

        if (payload is null || string.IsNullOrWhiteSpace(payload.Format))
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Export payload is invalid.");
        }

        var format = payload.Format.ToLowerInvariant();
        var picker = new Windows.Storage.Pickers.FileSavePicker();
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        var suggested = string.IsNullOrWhiteSpace(_currentFilePath)
            ? "导出"
            : Path.GetFileNameWithoutExtension(_currentFilePath);
        picker.SuggestedFileName = suggested;

        switch (format)
        {
            case "html":
                picker.FileTypeChoices.Add("HTML", new List<string> { ".html" });
                break;
            case "pdf":
                picker.FileTypeChoices.Add("PDF", new List<string> { ".pdf" });
                break;
            case "word":
                picker.FileTypeChoices.Add("Word 文档", new List<string> { ".docx" });
                break;
            case "png":
                picker.FileTypeChoices.Add("PNG 图片", new List<string> { ".png" });
                break;
            default:
                return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "不支持的导出格式。");
        }

        var file = await picker.PickSaveFileAsync();
        if (file is null)
        {
            return BridgeResponse.Success(request.Id, new { cancelled = true });
        }

        var markdown = payload.Markdown ?? string.Empty;
        var title = string.IsNullOrWhiteSpace(payload.Title) ? suggested : payload.Title!;
        try
        {
            if (format == "html")
            {
                await _htmlExport.ExportHtmlAsync(file.Path, title, markdown, payload.Dark, CancellationToken.None);
            }
            else if (format == "word")
            {
                await _wordExport.ExportDocxAsync(file.Path, title, markdown, CancellationToken.None);
            }
            else if (format == "pdf")
            {
                await ExportViaWebViewSnapshotAsync(
                    file.Path,
                    title,
                    markdown,
                    payload.Dark,
                    printPdf: true);
            }
            else
            {
                await ExportViaWebViewSnapshotAsync(
                    file.Path,
                    title,
                    markdown,
                    payload.Dark,
                    printPdf: false);
            }

            return BridgeResponse.Success(request.Id, new { filePath = file.Path, format });
        }
        catch (Exception)
        {
            return BridgeResponse.Failure(request.Id, "export_failed", "导出失败。");
        }
    }

    /// <summary>
    /// Renders offline HTML in WebView2, exports PDF (PrintToPdf) or full-page PNG (CDP), then restores editor.
    /// </summary>
    private async Task ExportViaWebViewSnapshotAsync(
        string targetPath,
        string title,
        string markdown,
        bool dark,
        bool printPdf)
    {
        if (EditorWebView.CoreWebView2 is null)
        {
            throw new InvalidOperationException("WebView2 is not ready.");
        }

        var restorePath = _currentFilePath;
        var restoreMarkdown = markdown;
        var restoreDirty = _isDirty;
        var tempHtml = Path.Combine(Path.GetTempPath(), "MahoDown", $"{Guid.NewGuid():N}.html");
        Directory.CreateDirectory(Path.GetDirectoryName(tempHtml)!);
        await _htmlExport.ExportHtmlAsync(tempHtml, title, markdown, dark, CancellationToken.None);

        try
        {
            var tcs = new TaskCompletionSource<bool>();
            void OnNav(CoreWebView2 s, CoreWebView2NavigationCompletedEventArgs e)
            {
                EditorWebView.CoreWebView2.NavigationCompleted -= OnNav;
                tcs.TrySetResult(e.IsSuccess);
            }

            EditorWebView.CoreWebView2.NavigationCompleted += OnNav;
            EditorWebView.CoreWebView2.Navigate(new Uri(tempHtml).AbsoluteUri);
            if (!await tcs.Task)
            {
                throw new InvalidOperationException("Export preview failed to load.");
            }

            // Let layout settle (fonts/images).
            await Task.Delay(200);

            if (printPdf)
            {
                await EditorWebView.CoreWebView2.PrintToPdfAsync(targetPath, null);
            }
            else
            {
                var json = await EditorWebView.CoreWebView2.CallDevToolsProtocolMethodAsync(
                    "Page.captureScreenshot",
                    """{"format":"png","captureBeyondViewport":true,"fromSurface":true}""");
                using var doc = JsonDocument.Parse(json);
                if (!doc.RootElement.TryGetProperty("data", out var dataProp)
                    || dataProp.GetString() is not { Length: > 0 } b64)
                {
                    throw new InvalidOperationException("PNG capture returned empty data.");
                }

                await File.WriteAllBytesAsync(targetPath, Convert.FromBase64String(b64));
            }
        }
        finally
        {
            var back = new TaskCompletionSource<bool>();
            void OnBack(CoreWebView2 s, CoreWebView2NavigationCompletedEventArgs e)
            {
                EditorWebView.CoreWebView2.NavigationCompleted -= OnBack;
                back.TrySetResult(e.IsSuccess);
            }

            EditorWebView.CoreWebView2.NavigationCompleted += OnBack;
            EditorWebView.Source = AppStartUri;
            await back.Task;
            await ExecuteEditorScriptAsync(
                $"window.mahodown?.applyRecovery?.({JsonSerializer.Serialize(restoreMarkdown)}, {JsonSerializer.Serialize(restorePath)})");
            _currentFilePath = restorePath;
            _isDirty = restoreDirty;
            UpdateTitle();
            try
            {
                File.Delete(tempHtml);
            }
            catch (Exception)
            {
            }
        }
    }

    private async Task<BridgeResponse> HandleGetRecentFilesAsync(BridgeRequest request)
    {
        var settings = await _settingsStore.LoadAsync(CancellationToken.None);
        var items = settings.RecentFiles
            .Where(File.Exists)
            .Select(path => new
            {
                filePath = path,
                fileName = Path.GetFileName(path),
                lastWriteTime = File.GetLastWriteTime(path)
            })
            .ToArray();
        return BridgeResponse.Success(request.Id, new { items });
    }

    private async Task<BridgeResponse> HandleReadAssetAsync(BridgeRequest request)
    {
        ReadAssetPayload? payload;
        try
        {
            payload = request.Payload.Deserialize<ReadAssetPayload>(BridgeJson.Options);
        }
        catch (JsonException)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Asset payload is invalid.");
        }

        if (payload is null
            || string.IsNullOrWhiteSpace(payload.RelativePath)
            || string.IsNullOrWhiteSpace(_currentFilePath))
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Asset payload is invalid.");
        }

        var docDir = Path.GetDirectoryName(_currentFilePath);
        if (string.IsNullOrWhiteSpace(docDir))
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Document path is invalid.");
        }

        var relative = payload.RelativePath
            .Replace('\\', '/')
            .TrimStart('/')
            .Replace("https://doc.mahodown.local/", string.Empty, StringComparison.OrdinalIgnoreCase)
            .Replace("https://app.mahodown.local/", string.Empty, StringComparison.OrdinalIgnoreCase);

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(Path.Combine(docDir, relative.Replace('/', Path.DirectorySeparatorChar)));
        }
        catch (Exception)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Asset path is invalid.");
        }

        var root = Path.GetFullPath(docDir)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        if (!fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))
        {
            return BridgeResponse.Failure(request.Id, "asset_not_found", "图片文件不存在。");
        }

        try
        {
            var bytes = await File.ReadAllBytesAsync(fullPath);
            var mime = GuessMime(fullPath);
            var dataUrl = $"data:{mime};base64,{Convert.ToBase64String(bytes)}";
            return BridgeResponse.Success(request.Id, new { dataUrl, relativePath = relative.Replace('\\', '/') });
        }
        catch (Exception)
        {
            return BridgeResponse.Failure(request.Id, "asset_read_failed", "读取图片失败。");
        }
    }

    private async Task<BridgeResponse> HandleImageUploadAsync(BridgeRequest request)
    {
        if (string.IsNullOrWhiteSpace(_currentFilePath))
        {
            return BridgeResponse.Failure(
                request.Id,
                BridgeCommand.ImageUploadFailed,
                "请先保存 Markdown 文件，再上传图片。");
        }

        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            foreach (var property in request.Payload.EnumerateObject())
            {
                if (string.Equals(property.Name, "documentPath", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                property.WriteTo(writer);
            }

            writer.WriteString("documentPath", _currentFilePath);
            writer.WriteEndObject();
        }

        using var document = JsonDocument.Parse(stream.ToArray());
        var patched = new BridgeRequest(request.Id, request.Command, document.RootElement.Clone());
        return await _dispatcher.DispatchAsync(patched, CancellationToken.None);
    }

    private async Task RememberRecentAsync(string filePath)
    {
        var settings = await _settingsStore.LoadAsync(CancellationToken.None);
        settings.RecentFiles = settings.RecentFiles
            .Where(p => !string.Equals(p, filePath, StringComparison.OrdinalIgnoreCase))
            .Prepend(filePath)
            .Take(20)
            .ToList();
        await _settingsStore.SaveAsync(settings, CancellationToken.None);
    }

    private void QueueRecoveryDraftRestoreCheck()
    {
        if (_hasCheckedRecoveryDrafts)
        {
            return;
        }

        _hasCheckedRecoveryDrafts = true;
        _ = RestoreLatestRecoveryDraftAsync();
    }

    private async Task RestoreLatestRecoveryDraftAsync()
    {
        try
        {
            var draft = await _recoveryDrafts.LoadLatestDraftAsync(CancellationToken.None);
            if (draft is null)
            {
                return;
            }

            if (!await ShowConfirmationAsync("恢复未保存内容", "发现恢复草稿，是否恢复？", "恢复"))
            {
                await _recoveryDrafts.DeleteAllDraftsAsync(CancellationToken.None);
                return;
            }

            _currentFilePath = string.IsNullOrWhiteSpace(draft.TargetFilePath) ? null : draft.TargetFilePath;
            _isDirty = true;
            UpdateTitle();
            await ExecuteEditorScriptAsync(
                $"window.mahodown?.applyRecovery?.({JsonSerializer.Serialize(draft.Markdown)}, {JsonSerializer.Serialize(_currentFilePath)})");
        }
        catch (Exception)
        {
        }
    }

    private void QueueRecoveryDraftSave()
    {
        var previous = _recoveryDraftDebounceCancellation;
        var next = new CancellationTokenSource();
        _recoveryDraftDebounceCancellation = next;
        previous?.Cancel();
        _ = SaveRecoveryDraftAfterDelayAsync(next);
    }

    private async Task SaveRecoveryDraftAfterDelayAsync(CancellationTokenSource cancellation)
    {
        try
        {
            await Task.Delay(RecoveryDraftSaveDelay, cancellation.Token);
            var json = await ExecuteEditorScriptAsync(
                "(() => { try { return window.mahodown?.getMarkdown?.() ?? null; } catch { return null; } })()");
            if (json is null || json == "null")
            {
                return;
            }

            var markdown = JsonSerializer.Deserialize<string>(json) ?? string.Empty;
            await _recoveryDrafts.SaveDraftAsync(_currentFilePath, markdown, cancellation.Token);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception)
        {
        }
        finally
        {
            if (ReferenceEquals(_recoveryDraftDebounceCancellation, cancellation))
            {
                _recoveryDraftDebounceCancellation = null;
            }

            cancellation.Dispose();
        }
    }

    private async Task<string?> ExecuteEditorScriptAsync(string script)
    {
        try
        {
            return await EditorWebView.CoreWebView2.ExecuteScriptAsync(script);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private void UpdateTitle()
    {
        var name = string.IsNullOrWhiteSpace(_currentFilePath)
            ? "未命名"
            : Path.GetFileName(_currentFilePath);
        Title = $"{(_isDirty ? "• " : string.Empty)}{name} — MahoDown";
    }

    private async Task<bool> ShowConfirmationAsync(string title, string message, string primaryButtonText)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = title,
            Content = message,
            PrimaryButtonText = primaryButtonText,
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Close
        };

        try
        {
            return await dialog.ShowAsync() == ContentDialogResult.Primary;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private sealed record DirtyStatePayload(bool IsDirty);
    private sealed record OpenPathPayload(string? FilePath);
    private sealed record SaveMarkdownPayload(string? Markdown);
    private sealed record SecretPayload(string? HostId, string? Key, string? Value);
    private sealed record ExportPayload(string? Format, string? Markdown, string? Title, bool Dark);
    private sealed record ReadAssetPayload(string? RelativePath);
}
