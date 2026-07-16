using System.Security.Cryptography;
using System.Text;

namespace MahoDown.Core.Images;

public sealed class LocalAssetsImageHostProvider : IImageHostProvider
{
    public string Id => "local";
    public string DisplayName => "本地相对路径";

    public Task<TestConnectionResult> TestConnectionAsync(ImageHostConfig config, CancellationToken cancellationToken) =>
        Task.FromResult(TestConnectionResult.Success("本地图床可用。"));

    public async Task<ImageUploadResult> UploadAsync(
        ImageUploadRequest request,
        ImageHostConfig config,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.DocumentPath))
        {
            throw new InvalidOperationException("请先保存 Markdown 文件，再使用本地图床。");
        }

        var documentDirectory = Path.GetDirectoryName(request.DocumentPath)
            ?? throw new InvalidOperationException("文档路径无效。");

        var extension = Path.GetExtension(request.OriginalFileName);
        if (string.IsNullOrWhiteSpace(extension))
        {
            extension = ".bin";
        }

        var bytes = await File.ReadAllBytesAsync(request.SourcePath, cancellationToken);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var fileName = $"{hash[..16]}{extension.ToLowerInvariant()}";
        var relativeDirectory = "img";
        var targetDirectory = Path.Combine(documentDirectory, relativeDirectory);
        Directory.CreateDirectory(targetDirectory);
        var targetPath = Path.Combine(targetDirectory, fileName);
        await File.WriteAllBytesAsync(targetPath, bytes, cancellationToken);

        var objectPath = Path.Combine(relativeDirectory, fileName).Replace('\\', '/');
        return new ImageUploadResult(
            ProviderId: Id,
            ObjectPath: objectPath,
            MarkdownUrl: objectPath,
            ContentType: request.ContentType,
            Size: bytes.Length,
            Sha256: hash,
            Width: null,
            Height: null);
    }
}
