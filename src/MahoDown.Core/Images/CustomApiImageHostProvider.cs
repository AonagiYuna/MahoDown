using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace MahoDown.Core.Images;

public sealed class CustomApiImageHostProvider : IImageHostProvider
{
    private static readonly HttpClient Http = new();

    public string Id => "custom";
    public string DisplayName => "自定义 API";

    public Task<TestConnectionResult> TestConnectionAsync(ImageHostConfig config, CancellationToken cancellationToken)
    {
        var url = config.Get("url");
        if (string.IsNullOrWhiteSpace(url))
        {
            return Task.FromResult(TestConnectionResult.Failure("请填写自定义上传 URL。"));
        }

        return Task.FromResult(TestConnectionResult.Success("配置已填写。"));
    }

    public async Task<ImageUploadResult> UploadAsync(
        ImageUploadRequest request,
        ImageHostConfig config,
        CancellationToken cancellationToken)
    {
        var url = config.Get("url") ?? throw new InvalidOperationException("缺少自定义上传 URL。");
        var mode = (config.Get("mode") ?? "multipart").ToLowerInvariant();
        var jsonPath = config.Get("jsonPath") ?? "url";
        var token = config.Get("token");

        HttpResponseMessage response;
        if (mode == "json")
        {
            var bytes = await File.ReadAllBytesAsync(request.SourcePath, cancellationToken);
            var body = JsonSerializer.Serialize(new
            {
                fileName = request.OriginalFileName,
                contentType = request.ContentType,
                base64 = Convert.ToBase64String(bytes)
            });
            using var httpRequest = new HttpRequestMessage(HttpMethod.Post, url);
            if (!string.IsNullOrWhiteSpace(token))
            {
                httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            }

            httpRequest.Content = new StringContent(body, Encoding.UTF8, "application/json");
            response = await Http.SendAsync(httpRequest, cancellationToken);
        }
        else
        {
            await using var stream = File.OpenRead(request.SourcePath);
            using var content = new MultipartFormDataContent();
            var part = new StreamContent(stream);
            part.Headers.ContentType = new MediaTypeHeaderValue(request.ContentType);
            content.Add(part, "file", request.OriginalFileName);
            using var httpRequest = new HttpRequestMessage(HttpMethod.Post, url);
            if (!string.IsNullOrWhiteSpace(token))
            {
                httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            }

            httpRequest.Content = content;
            response = await Http.SendAsync(httpRequest, cancellationToken);
        }

        using (response)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"自定义 API 失败: {(int)response.StatusCode} {body}");
            }

            var markdownUrl = ExtractUrl(body, jsonPath)
                ?? throw new InvalidOperationException($"无法从响应提取 URL（路径: {jsonPath}）");

            return new ImageUploadResult(
                Id,
                markdownUrl,
                markdownUrl,
                request.ContentType,
                new FileInfo(request.SourcePath).Length,
                null,
                null,
                null);
        }
    }

    private static string? ExtractUrl(string body, string jsonPath)
    {
        body = body.Trim();
        if (body.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || body.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            return body.Trim().Trim('"');
        }

        try
        {
            using var doc = JsonDocument.Parse(body);
            var current = doc.RootElement;
            foreach (var segment in jsonPath.Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
                {
                    return null;
                }
            }

            return current.ValueKind == JsonValueKind.String ? current.GetString() : current.ToString();
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
