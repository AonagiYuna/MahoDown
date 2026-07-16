using System.Net.Http.Json;
using System.Text.Json;

namespace MahoDown.Core.Images;

public sealed class PicGoImageHostProvider : IImageHostProvider
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

    public string Id => "picgo";
    public string DisplayName => "PicGo";

    public async Task<TestConnectionResult> TestConnectionAsync(ImageHostConfig config, CancellationToken cancellationToken)
    {
        var endpoint = (config.Get("endpoint") ?? "http://127.0.0.1:36677").TrimEnd('/');
        try
        {
            using var response = await Http.GetAsync(endpoint, cancellationToken);
            return TestConnectionResult.Success($"PicGo 可达: {endpoint}");
        }
        catch (Exception ex)
        {
            return TestConnectionResult.Failure($"无法连接 PicGo（{endpoint}）: {ex.Message}");
        }
    }

    public async Task<ImageUploadResult> UploadAsync(
        ImageUploadRequest request,
        ImageHostConfig config,
        CancellationToken cancellationToken)
    {
        var endpoint = (config.Get("endpoint") ?? "http://127.0.0.1:36677").TrimEnd('/');
        var bytes = await File.ReadAllBytesAsync(request.SourcePath, cancellationToken);
        var payload = new
        {
            list = new[]
            {
                Convert.ToBase64String(bytes)
            }
        };

        using var response = await Http.PostAsJsonAsync($"{endpoint}/upload", payload, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"PicGo 上传失败: {(int)response.StatusCode} {body}");
        }

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        string? url = null;
        if (root.TryGetProperty("result", out var result) && result.ValueKind == JsonValueKind.Array && result.GetArrayLength() > 0)
        {
            url = result[0].GetString();
        }
        else if (root.TryGetProperty("success", out var success) && success.GetBoolean()
                 && root.TryGetProperty("result", out var result2) && result2.ValueKind == JsonValueKind.Array)
        {
            url = result2[0].GetString();
        }

        if (string.IsNullOrWhiteSpace(url))
        {
            throw new InvalidOperationException($"PicGo 未返回 URL: {body}");
        }

        return new ImageUploadResult(
            Id,
            url,
            url,
            request.ContentType,
            bytes.Length,
            null,
            null,
            null);
    }
}
