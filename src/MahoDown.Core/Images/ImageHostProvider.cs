namespace MahoDown.Core.Images;

public sealed record ImageHostConfig(IReadOnlyDictionary<string, string> Values)
{
    public static ImageHostConfig Empty { get; } = new(new Dictionary<string, string>());

    public string? Get(string key) =>
        Values.TryGetValue(key, out var value) ? value : null;
}

public sealed record ImageUploadRequest(
    string SourcePath,
    string OriginalFileName,
    string ContentType,
    string? DocumentPath);

public sealed record ImageUploadResult(
    string ProviderId,
    string ObjectPath,
    string MarkdownUrl,
    string ContentType,
    long Size,
    string? Sha256,
    int? Width,
    int? Height);

public sealed record TestConnectionResult(bool Ok, string Message)
{
    public static TestConnectionResult Success(string message) => new(true, message);
    public static TestConnectionResult Failure(string message) => new(false, message);
}

public interface IImageHostProvider
{
    string Id { get; }
    string DisplayName { get; }
    Task<TestConnectionResult> TestConnectionAsync(ImageHostConfig config, CancellationToken cancellationToken);
    Task<ImageUploadResult> UploadAsync(ImageUploadRequest request, ImageHostConfig config, CancellationToken cancellationToken);
}
