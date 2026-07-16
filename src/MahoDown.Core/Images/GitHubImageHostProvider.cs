using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace MahoDown.Core.Images;

public sealed class GitHubImageHostProvider : IImageHostProvider
{
    private static readonly HttpClient Http = new();

    public string Id => "github";
    public string DisplayName => "GitHub";

    public async Task<TestConnectionResult> TestConnectionAsync(ImageHostConfig config, CancellationToken cancellationToken)
    {
        try
        {
            var (owner, repo) = ParseRepo(Require(config, "repo"));
            var token = Require(config, "token");
            using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{owner}/{repo}");
            request.Headers.UserAgent.ParseAdd("MahoDown");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var response = await Http.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                return TestConnectionResult.Failure($"GitHub 连接失败: {(int)response.StatusCode}");
            }

            return TestConnectionResult.Success("GitHub 连接正常。");
        }
        catch (Exception ex)
        {
            return TestConnectionResult.Failure(ex.Message);
        }
    }

    public async Task<ImageUploadResult> UploadAsync(
        ImageUploadRequest request,
        ImageHostConfig config,
        CancellationToken cancellationToken)
    {
        var (owner, repo) = ParseRepo(Require(config, "repo"));
        var branch = config.Get("branch") ?? "main";
        var token = Require(config, "token");
        var template = config.Get("pathTemplate") ?? "img/{year}-{month}/{filename}";
        var fileName = Path.GetFileName(request.OriginalFileName);
        var objectPath = template
            .Replace("{year}", DateTime.UtcNow.ToString("yyyy"), StringComparison.OrdinalIgnoreCase)
            .Replace("{month}", DateTime.UtcNow.ToString("MM"), StringComparison.OrdinalIgnoreCase)
            .Replace("{filename}", fileName, StringComparison.OrdinalIgnoreCase)
            .Replace('\\', '/');

        var bytes = await File.ReadAllBytesAsync(request.SourcePath, cancellationToken);
        var payload = JsonSerializer.Serialize(new
        {
            message = $"upload {fileName} via MahoDown",
            content = Convert.ToBase64String(bytes),
            branch
        });

        using var httpRequest = new HttpRequestMessage(
            HttpMethod.Put,
            $"https://api.github.com/repos/{owner}/{repo}/contents/{objectPath}");
        httpRequest.Headers.UserAgent.ParseAdd("MahoDown");
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        httpRequest.Content = new StringContent(payload, Encoding.UTF8, "application/json");

        using var response = await Http.SendAsync(httpRequest, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new InvalidOperationException($"GitHub 上传失败: {(int)response.StatusCode} {body}");
        }

        var cdnUrl = $"https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{objectPath}";
        return new ImageUploadResult(
            ProviderId: Id,
            ObjectPath: objectPath,
            MarkdownUrl: cdnUrl,
            ContentType: request.ContentType,
            Size: bytes.Length,
            Sha256: null,
            Width: null,
            Height: null);
    }

    private static (string Owner, string Repo) ParseRepo(string repo)
    {
        var parts = repo.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length != 2)
        {
            throw new InvalidOperationException("仓库格式应为 owner/repo。");
        }

        return (parts[0], parts[1]);
    }

    private static string Require(ImageHostConfig config, string key) =>
        config.Get(key) ?? throw new InvalidOperationException($"缺少配置项: {key}");
}
