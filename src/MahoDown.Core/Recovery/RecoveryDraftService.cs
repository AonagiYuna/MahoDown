using System.Text.Json;

namespace MahoDown.Core.Recovery;

public sealed record RecoveryDraft(
    string DraftId,
    string? TargetFilePath,
    string Markdown,
    DateTimeOffset SavedAt,
    string AppVersion);

public sealed class RecoveryDraftService
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly string _directory;
    private readonly string _appVersion;

    public RecoveryDraftService(string directory, string appVersion = "1.0.0")
    {
        _directory = directory;
        _appVersion = appVersion;
    }

    public async Task SaveDraftAsync(string? targetFilePath, string markdown, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_directory);
        var draft = new RecoveryDraft(
            Guid.NewGuid().ToString("N"),
            targetFilePath,
            markdown,
            DateTimeOffset.Now,
            _appVersion);

        var path = Path.Combine(_directory, "latest.json");
        var temp = path + $".{Guid.NewGuid():N}.tmp";
        await using (var stream = File.Create(temp))
        {
            await JsonSerializer.SerializeAsync(stream, draft, Options, cancellationToken);
        }

        File.Copy(temp, path, overwrite: true);
        File.Delete(temp);
    }

    public async Task<RecoveryDraft?> LoadLatestDraftAsync(CancellationToken cancellationToken)
    {
        var path = Path.Combine(_directory, "latest.json");
        if (!File.Exists(path))
        {
            return null;
        }

        await using var stream = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<RecoveryDraft>(stream, Options, cancellationToken);
    }

    public Task DeleteAllDraftsAsync(CancellationToken cancellationToken)
    {
        if (!Directory.Exists(_directory))
        {
            return Task.CompletedTask;
        }

        foreach (var file in Directory.EnumerateFiles(_directory))
        {
            try
            {
                File.Delete(file);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        return Task.CompletedTask;
    }
}
