using System.Text.Json;
using MahoDown.Core.Documents;
using MahoDown.Core.Export;
using MahoDown.Core.History;
using MahoDown.Core.Images;
using MahoDown.Core.Settings;

namespace MahoDown.Core.Bridge;

public sealed class BridgeDispatcher
{
    private const int MaxPayloadCharacters = 20 * 1024 * 1024;
    private static readonly string IssuedTempDirectory = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "MahoDown"));

    private readonly MarkdownDocumentService _documentService;
    private readonly ImageHostRegistry _imageHosts;
    private readonly JsonSettingsStore _settingsStore;
    private readonly SnapshotService _snapshots;
    private readonly HtmlExportService _htmlExport = new();
    private readonly Func<AppSettings, string, ImageHostConfig> _resolveHostConfig;
    private readonly object _issuedTempFilesLock = new();
    private readonly HashSet<string> _issuedTempFiles = new(StringComparer.OrdinalIgnoreCase);

    public BridgeDispatcher(
        MarkdownDocumentService documentService,
        JsonSettingsStore settingsStore,
        SnapshotService snapshots,
        ImageHostRegistry? imageHosts = null,
        Func<AppSettings, string, ImageHostConfig>? resolveHostConfig = null)
    {
        _documentService = documentService;
        _settingsStore = settingsStore;
        _snapshots = snapshots;
        _imageHosts = imageHosts ?? new ImageHostRegistry();
        _resolveHostConfig = resolveHostConfig ?? ((settings, hostId) =>
        {
            if (settings.ImageHostConfigs.TryGetValue(hostId, out var map))
            {
                return new ImageHostConfig(map);
            }

            return ImageHostConfig.Empty;
        });
    }

    public async Task<BridgeResponse> DispatchAsync(BridgeRequest request, CancellationToken cancellationToken)
    {
        if (request.Payload.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidRequest, "Bridge payload is required.");
        }

        if (request.Payload.GetRawText().Length > MaxPayloadCharacters)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.PayloadTooLarge, "Bridge payload is too large.");
        }

        return request.Command switch
        {
            BridgeCommand.FileSave => await SaveAsync(request, cancellationToken),
            BridgeCommand.ImageUpload => await UploadImageAsync(request, cancellationToken),
            BridgeCommand.TempWriteFile => await WriteTempFileAsync(request, cancellationToken),
            BridgeCommand.ProviderTestConnection => await TestProviderAsync(request, cancellationToken),
            BridgeCommand.AppGetSettings => await GetSettingsAsync(request, cancellationToken),
            BridgeCommand.AppUpdateSettings => await UpdateSettingsAsync(request, cancellationToken),
            BridgeCommand.HistoryList => await HistoryListAsync(request, cancellationToken),
            BridgeCommand.HistorySave => await HistorySaveAsync(request, cancellationToken),
            BridgeCommand.HistoryLoad => await HistoryLoadAsync(request, cancellationToken),
            BridgeCommand.ExportFile => await ExportHtmlAsync(request, cancellationToken),
            _ => BridgeResponse.Failure(request.Id, BridgeCommand.UnknownCommand, "Unknown bridge command.")
        };
    }

    private async Task<BridgeResponse> GetSettingsAsync(BridgeRequest request, CancellationToken cancellationToken)
    {
        var settings = await _settingsStore.LoadAsync(cancellationToken);
        return BridgeResponse.Success(request.Id, SanitizeSettings(settings));
    }

    private async Task<BridgeResponse> UpdateSettingsAsync(BridgeRequest request, CancellationToken cancellationToken)
    {
        AppSettings? patch;
        try
        {
            patch = request.Payload.Deserialize<AppSettings>(BridgeJson.Options);
        }
        catch (JsonException)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Settings payload is invalid.");
        }

        if (patch is null)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Settings payload is invalid.");
        }

        var current = await _settingsStore.LoadAsync(cancellationToken);
        current.Theme = patch.Theme;
        current.DefaultMode = patch.DefaultMode;
        current.DefaultImageHost = patch.DefaultImageHost;
        current.FontSize = patch.FontSize;
        current.LineHeight = patch.LineHeight;
        current.LineWidth = patch.LineWidth;
        current.AutoPairBrackets = patch.AutoPairBrackets;
        current.ExpandMarkdownOnCaret = patch.ExpandMarkdownOnCaret;
        current.StripPasteFormatting = patch.StripPasteFormatting;
        current.AutoSpaceCjk = patch.AutoSpaceCjk;
        current.AutoSnapshotMinutes = patch.AutoSnapshotMinutes;
        current.FollowSystemAccent = patch.FollowSystemAccent;
        current.PasteUploadImages = patch.PasteUploadImages;
        current.KeepLocalOnUploadFailure = patch.KeepLocalOnUploadFailure;
        if (patch.ImageHostConfigs is not null)
        {
            current.ImageHostConfigs = MergeHostConfigs(current.ImageHostConfigs, patch.ImageHostConfigs);
        }

        await _settingsStore.SaveAsync(current, cancellationToken);
        return BridgeResponse.Success(request.Id, SanitizeSettings(current));
    }

    private static Dictionary<string, Dictionary<string, string>> MergeHostConfigs(
        Dictionary<string, Dictionary<string, string>> current,
        Dictionary<string, Dictionary<string, string>> patch)
    {
        var result = new Dictionary<string, Dictionary<string, string>>(current, StringComparer.OrdinalIgnoreCase);
        foreach (var (hostId, map) in patch)
        {
            if (!result.TryGetValue(hostId, out var existing))
            {
                existing = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                result[hostId] = existing;
            }

            foreach (var (key, value) in map)
            {
                if (key is "token" or "secretKey" or "secret" or "password" or "accessKey")
                {
                    // Secrets are stored via SecretStore; ignore masked placeholders here.
                    if (value is "********" or null)
                    {
                        continue;
                    }

                    // Non-empty secret-like values written into settings are stripped for safety.
                    continue;
                }

                existing[key] = value;
            }
        }

        return result;
    }

    private static AppSettings SanitizeSettings(AppSettings settings)
    {
        // Never return secret-looking fields to the web layer from configs.
        var copy = new AppSettings
        {
            Theme = settings.Theme,
            DefaultMode = settings.DefaultMode,
            DefaultImageHost = settings.DefaultImageHost,
            FontSize = settings.FontSize,
            LineHeight = settings.LineHeight,
            LineWidth = settings.LineWidth,
            AutoPairBrackets = settings.AutoPairBrackets,
            ExpandMarkdownOnCaret = settings.ExpandMarkdownOnCaret,
            StripPasteFormatting = settings.StripPasteFormatting,
            AutoSpaceCjk = settings.AutoSpaceCjk,
            AutoSnapshotMinutes = settings.AutoSnapshotMinutes,
            FollowSystemAccent = settings.FollowSystemAccent,
            PasteUploadImages = settings.PasteUploadImages,
            KeepLocalOnUploadFailure = settings.KeepLocalOnUploadFailure,
            RecentFiles = settings.RecentFiles.ToList(),
            ImageHostConfigs = new Dictionary<string, Dictionary<string, string>>()
        };

        foreach (var (hostId, map) in settings.ImageHostConfigs)
        {
            var safe = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (key, value) in map)
            {
                if (key is "token" or "secretKey" or "secret" or "password" or "accessKey")
                {
                    safe[key] = string.IsNullOrEmpty(value) ? string.Empty : "********";
                }
                else
                {
                    safe[key] = value;
                }
            }

            copy.ImageHostConfigs[hostId] = safe;
        }

        return copy;
    }

    private async Task<BridgeResponse> HistoryListAsync(BridgeRequest request, CancellationToken cancellationToken)
    {
        var payload = request.Payload.Deserialize<HistoryPathPayload>(BridgeJson.Options);
        var items = await _snapshots.ListAsync(payload?.FilePath, cancellationToken);
        return BridgeResponse.Success(request.Id, new { items });
    }

    private async Task<BridgeResponse> HistorySaveAsync(BridgeRequest request, CancellationToken cancellationToken)
    {
        var payload = request.Payload.Deserialize<HistorySavePayload>(BridgeJson.Options);
        if (payload is null || payload.Markdown is null)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "History payload is invalid.");
        }

        var info = await _snapshots.SaveAsync(
            payload.FilePath,
            payload.Markdown,
            string.IsNullOrWhiteSpace(payload.Kind) ? "manual" : payload.Kind,
            cancellationToken);
        return BridgeResponse.Success(request.Id, info);
    }

    private async Task<BridgeResponse> HistoryLoadAsync(BridgeRequest request, CancellationToken cancellationToken)
    {
        var payload = request.Payload.Deserialize<HistoryLoadPayload>(BridgeJson.Options);
        if (payload is null || string.IsNullOrWhiteSpace(payload.SnapshotId))
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "History payload is invalid.");
        }

        var markdown = await _snapshots.LoadContentAsync(payload.FilePath, payload.SnapshotId, cancellationToken);
        if (markdown is null)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "快照不存在。");
        }

        return BridgeResponse.Success(request.Id, new { markdown });
    }

    private async Task<BridgeResponse> ExportHtmlAsync(BridgeRequest request, CancellationToken cancellationToken)
    {
        var payload = request.Payload.Deserialize<ExportPayload>(BridgeJson.Options);
        if (payload is null
            || string.IsNullOrWhiteSpace(payload.FilePath)
            || string.IsNullOrWhiteSpace(payload.Format))
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Export payload is invalid.");
        }

        if (!string.Equals(payload.Format, "html", StringComparison.OrdinalIgnoreCase))
        {
            // PDF / Word / PNG handled by App layer when needed.
            return BridgeResponse.Failure(request.Id, BridgeCommand.NotImplemented, $"导出格式 {payload.Format} 由应用层处理。");
        }

        var title = string.IsNullOrWhiteSpace(payload.Title) ? "MahoDown" : payload.Title;
        await _htmlExport.ExportHtmlAsync(
            payload.FilePath,
            title,
            payload.Markdown ?? string.Empty,
            payload.Dark,
            cancellationToken);
        return BridgeResponse.Success(request.Id, new { filePath = payload.FilePath, format = "html" });
    }

    private async Task<BridgeResponse> SaveAsync(BridgeRequest request, CancellationToken cancellationToken)
    {
        FileSavePayload? payload;
        try
        {
            payload = request.Payload.Deserialize<FileSavePayload>(BridgeJson.Options);
        }
        catch (JsonException)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "File save payload is invalid.");
        }

        if (payload is null || string.IsNullOrWhiteSpace(payload.FilePath))
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "File path is required.");
        }

        try
        {
            var state = DocumentState.NewUntitled().WithContent(payload.Markdown ?? string.Empty);
            var saved = await _documentService.SaveAsync(state, payload.FilePath, cancellationToken);
            return BridgeResponse.Success(request.Id, new
            {
                filePath = saved.FilePath,
                isDirty = saved.IsDirty,
                lastSavedAt = saved.LastSavedAt
            });
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.FileSaveFailed, "文件保存失败。");
        }
    }

    private async Task<BridgeResponse> UploadImageAsync(BridgeRequest request, CancellationToken cancellationToken)
    {
        ImageUploadPayload? payload;
        try
        {
            payload = request.Payload.Deserialize<ImageUploadPayload>(BridgeJson.Options);
        }
        catch (JsonException)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Image upload payload is invalid.");
        }

        if (payload is null || string.IsNullOrWhiteSpace(payload.SourcePath))
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Image upload payload is invalid.");
        }

        if (!TryNormalizeIssuedTempSourcePath(payload.SourcePath, out var sourcePath) || !TryClaimIssuedTempFile(sourcePath))
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Image upload payload is invalid.");
        }

        try
        {
            var settings = await _settingsStore.LoadAsync(cancellationToken);
            var hostId = string.IsNullOrWhiteSpace(payload.HostId) ? settings.DefaultImageHost : payload.HostId;
            var provider = _imageHosts.Get(hostId);
            var config = _resolveHostConfig(settings, hostId);
            var result = await provider.UploadAsync(
                new ImageUploadRequest(
                    sourcePath,
                    string.IsNullOrWhiteSpace(payload.OriginalFileName) ? "image.bin" : payload.OriginalFileName,
                    string.IsNullOrWhiteSpace(payload.ContentType) ? "application/octet-stream" : payload.ContentType,
                    string.IsNullOrWhiteSpace(payload.DocumentPath) ? null : payload.DocumentPath),
                config,
                cancellationToken);
            return BridgeResponse.Success(request.Id, result);
        }
        catch (NotImplementedException ex)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.NotImplemented, ex.Message);
        }
        catch (Exception)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.ImageUploadFailed, "图片上传失败。");
        }
        finally
        {
            DeleteIssuedTempFileIfExists(sourcePath);
        }
    }

    private async Task<BridgeResponse> TestProviderAsync(BridgeRequest request, CancellationToken cancellationToken)
    {
        ProviderTestPayload? payload;
        try
        {
            payload = request.Payload.Deserialize<ProviderTestPayload>(BridgeJson.Options);
        }
        catch (JsonException)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Provider payload is invalid.");
        }

        if (payload is null || string.IsNullOrWhiteSpace(payload.HostId))
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Provider payload is invalid.");
        }

        var settings = await _settingsStore.LoadAsync(cancellationToken);
        var provider = _imageHosts.Get(payload.HostId);
        var config = _resolveHostConfig(settings, payload.HostId);
        var result = await provider.TestConnectionAsync(config, cancellationToken);
        return BridgeResponse.Success(request.Id, result);
    }

    private async Task<BridgeResponse> WriteTempFileAsync(BridgeRequest request, CancellationToken cancellationToken)
    {
        TempWriteFilePayload? payload;
        try
        {
            payload = request.Payload.Deserialize<TempWriteFilePayload>(BridgeJson.Options);
        }
        catch (JsonException)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Temporary file payload is invalid.");
        }

        if (payload is null || string.IsNullOrWhiteSpace(payload.OriginalFileName) || string.IsNullOrWhiteSpace(payload.Base64))
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Temporary file payload is invalid.");
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(payload.Base64);
        }
        catch (FormatException)
        {
            return BridgeResponse.Failure(request.Id, BridgeCommand.InvalidPayload, "Temporary file payload is invalid.");
        }

        Directory.CreateDirectory(IssuedTempDirectory);
        var extension = Path.GetExtension(payload.OriginalFileName);
        var tempPath = Path.GetFullPath(Path.Combine(IssuedTempDirectory, $"{Guid.NewGuid():N}{extension}"));
        await File.WriteAllBytesAsync(tempPath, bytes, cancellationToken);
        lock (_issuedTempFilesLock)
        {
            _issuedTempFiles.Add(tempPath);
        }

        return BridgeResponse.Success(request.Id, tempPath);
    }

    private bool TryClaimIssuedTempFile(string sourcePath)
    {
        lock (_issuedTempFilesLock)
        {
            return _issuedTempFiles.Remove(sourcePath);
        }
    }

    private static bool TryNormalizeIssuedTempSourcePath(string sourcePath, out string normalizedPath)
    {
        normalizedPath = string.Empty;
        try
        {
            normalizedPath = Path.GetFullPath(sourcePath);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }

        var directoryWithSeparator = IssuedTempDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        return normalizedPath.StartsWith(directoryWithSeparator, StringComparison.OrdinalIgnoreCase);
    }

    private static void DeleteIssuedTempFileIfExists(string sourcePath)
    {
        try
        {
            if (File.Exists(sourcePath))
            {
                File.Delete(sourcePath);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    private sealed record FileSavePayload(string? FilePath, string? Markdown);
    private sealed record ImageUploadPayload(string? SourcePath, string? OriginalFileName, string? ContentType, string? DocumentPath, string? HostId);
    private sealed record TempWriteFilePayload(string? OriginalFileName, string? Base64);
    private sealed record ProviderTestPayload(string? HostId);
    private sealed record HistoryPathPayload(string? FilePath);
    private sealed record HistorySavePayload(string? FilePath, string? Markdown, string? Kind);
    private sealed record HistoryLoadPayload(string? FilePath, string? SnapshotId);
    private sealed record ExportPayload(string? FilePath, string? Format, string? Markdown, string? Title, bool Dark);
}
