using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace MahoDown.Core.History;

public sealed record SnapshotInfo(
    string Id,
    string? TargetFilePath,
    DateTimeOffset CreatedAt,
    int WordCount,
    string Kind);

public sealed class SnapshotService
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly string _root;

    public SnapshotService(string rootDirectory)
    {
        _root = rootDirectory;
    }

    public async Task<SnapshotInfo> SaveAsync(
        string? targetFilePath,
        string markdown,
        string kind,
        CancellationToken cancellationToken)
    {
        var folder = GetDocumentFolder(targetFilePath);
        Directory.CreateDirectory(folder);
        var id = $"{DateTimeOffset.Now:yyyyMMddHHmmss}-{Guid.NewGuid():N}"[..24];
        var dir = Path.Combine(folder, id);
        Directory.CreateDirectory(dir);

        var info = new SnapshotInfo(
            id,
            targetFilePath,
            DateTimeOffset.Now,
            CountWords(markdown),
            kind);

        await File.WriteAllTextAsync(Path.Combine(dir, "content.md"), markdown, Encoding.UTF8, cancellationToken);
        await using (var stream = File.Create(Path.Combine(dir, "meta.json")))
        {
            await JsonSerializer.SerializeAsync(stream, info, Options, cancellationToken);
        }

        await TrimOldAsync(folder, keep: 40, cancellationToken);
        return info;
    }

    public async Task<IReadOnlyList<SnapshotInfo>> ListAsync(string? targetFilePath, CancellationToken cancellationToken)
    {
        var folder = GetDocumentFolder(targetFilePath);
        if (!Directory.Exists(folder))
        {
            return Array.Empty<SnapshotInfo>();
        }

        var list = new List<SnapshotInfo>();
        foreach (var dir in Directory.EnumerateDirectories(folder))
        {
            var metaPath = Path.Combine(dir, "meta.json");
            if (!File.Exists(metaPath))
            {
                continue;
            }

            await using var stream = File.OpenRead(metaPath);
            var info = await JsonSerializer.DeserializeAsync<SnapshotInfo>(stream, Options, cancellationToken);
            if (info is not null)
            {
                list.Add(info);
            }
        }

        return list.OrderByDescending(x => x.CreatedAt).ToArray();
    }

    public async Task<string?> LoadContentAsync(string? targetFilePath, string snapshotId, CancellationToken cancellationToken)
    {
        var path = Path.Combine(GetDocumentFolder(targetFilePath), snapshotId, "content.md");
        if (!File.Exists(path))
        {
            return null;
        }

        return await File.ReadAllTextAsync(path, Encoding.UTF8, cancellationToken);
    }

    private async Task TrimOldAsync(string folder, int keep, CancellationToken cancellationToken)
    {
        var dirs = Directory.EnumerateDirectories(folder)
            .Select(d => new DirectoryInfo(d))
            .OrderByDescending(d => d.CreationTimeUtc)
            .Skip(keep)
            .ToArray();

        foreach (var dir in dirs)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                dir.Delete(recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }

            await Task.Yield();
        }
    }

    private string GetDocumentFolder(string? targetFilePath)
    {
        var key = string.IsNullOrWhiteSpace(targetFilePath) ? "untitled" : targetFilePath;
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..16].ToLowerInvariant();
        return Path.Combine(_root, hash);
    }

    private static int CountWords(string markdown)
    {
        if (string.IsNullOrWhiteSpace(markdown))
        {
            return 0;
        }

        var cjk = markdown.Count(ch => ch is >= '\u4e00' and <= '\u9fff');
        var withoutCjk = new string(markdown.Select(ch => ch is >= '\u4e00' and <= '\u9fff' ? ' ' : ch).ToArray());
        var latin = withoutCjk.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length;
        return cjk + latin;
    }
}
