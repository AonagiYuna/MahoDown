using System.Net.Http.Headers;

namespace MahoDown.Core.Images;

public sealed class SmMsImageHostProvider : IImageHostProvider
{
    private static readonly HttpClient Http = new();

    public string Id => "smms";
    public string DisplayName => "SM.MS";

    public async Task<TestConnectionResult> TestConnectionAsync(ImageHostConfig config, CancellationToken cancellationToken)
    {
        var token = config.Get("token");
        if (string.IsNullOrWhiteSpace(token))
        {
            return TestConnectionResult.Failure("请填写 SM.MS Token。");
        }

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, "https://sm.ms/api/v2/profile");
            request.Headers.Authorization = new AuthenticationHeaderValue(token);
            using var response = await Http.SendAsync(request, cancellationToken);
            return response.IsSuccessStatusCode
                ? TestConnectionResult.Success("SM.MS 连接正常。")
                : TestConnectionResult.Failure($"SM.MS 连接失败: {(int)response.StatusCode}");
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
        var token = config.Get("token") ?? throw new InvalidOperationException("缺少 SM.MS Token。");
        await using var fileStream = File.OpenRead(request.SourcePath);
        using var content = new MultipartFormDataContent();
        var streamContent = new StreamContent(fileStream);
        streamContent.Headers.ContentType = new MediaTypeHeaderValue(request.ContentType);
        content.Add(streamContent, "smfile", request.OriginalFileName);

        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, "https://sm.ms/api/v2/upload");
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue(token);
        httpRequest.Content = content;

        using var response = await Http.SendAsync(httpRequest, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"SM.MS 上传失败: {(int)response.StatusCode} {body}");
        }

        using var doc = System.Text.Json.JsonDocument.Parse(body);
        var root = doc.RootElement;
        if (root.TryGetProperty("success", out var success) && success.ValueKind == System.Text.Json.JsonValueKind.False)
        {
            // duplicate image often returns success=false with images url
            if (root.TryGetProperty("images", out var images) && images.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                var dupUrl = images.GetString() ?? throw new InvalidOperationException("SM.MS 返回无效。");
                return Result(request, dupUrl, dupUrl);
            }

            var message = root.TryGetProperty("message", out var msg) ? msg.GetString() : "上传失败";
            throw new InvalidOperationException(message ?? "SM.MS 上传失败");
        }

        var data = root.GetProperty("data");
        var url = data.GetProperty("url").GetString()
            ?? throw new InvalidOperationException("SM.MS 未返回 URL。");
        var path = data.TryGetProperty("path", out var p) ? p.GetString() ?? url : url;
        return Result(request, path, url);
    }

    private ImageUploadResult Result(ImageUploadRequest request, string objectPath, string url) =>
        new(Id, objectPath, url, request.ContentType, new FileInfo(request.SourcePath).Length, null, null, null);
}
