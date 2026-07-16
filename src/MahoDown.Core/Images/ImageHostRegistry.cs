namespace MahoDown.Core.Images;

public sealed class ImageHostRegistry
{
    private readonly Dictionary<string, IImageHostProvider> _providers;

    public ImageHostRegistry(IEnumerable<IImageHostProvider>? providers = null)
    {
        _providers = (providers ?? DefaultProviders()).ToDictionary(p => p.Id, StringComparer.OrdinalIgnoreCase);
    }

    public IReadOnlyCollection<IImageHostProvider> All => _providers.Values;

    public IImageHostProvider Get(string id) =>
        _providers.TryGetValue(id, out var provider)
            ? provider
            : throw new InvalidOperationException($"未知图床: {id}");

    public static IEnumerable<IImageHostProvider> DefaultProviders() =>
    [
        new LocalAssetsImageHostProvider(),
        new GitHubImageHostProvider(),
        new PicGoImageHostProvider(),
        new S3ImageHostProvider(),
        new SmMsImageHostProvider(),
        new CustomApiImageHostProvider()
    ];
}
