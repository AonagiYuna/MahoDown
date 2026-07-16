using Amazon;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;

namespace MahoDown.Core.Images;

public sealed class S3ImageHostProvider : IImageHostProvider
{
    public string Id => "s3";
    public string DisplayName => "对象存储";

    public async Task<TestConnectionResult> TestConnectionAsync(ImageHostConfig config, CancellationToken cancellationToken)
    {
        try
        {
            using var client = CreateClient(config);
            var bucket = Require(config, "bucket");
            await client.GetBucketLocationAsync(bucket, cancellationToken);
            return TestConnectionResult.Success("对象存储连接正常。");
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
        var bucket = Require(config, "bucket");
        var prefix = (config.Get("prefix") ?? "img").Trim('/');
        var publicBase = (config.Get("publicBaseUrl") ?? string.Empty).TrimEnd('/');
        var fileName = Path.GetFileName(request.OriginalFileName);
        var objectKey = string.IsNullOrWhiteSpace(prefix)
            ? $"{DateTime.UtcNow:yyyy-MM}/{fileName}"
            : $"{prefix}/{DateTime.UtcNow:yyyy-MM}/{fileName}";

        using var client = CreateClient(config);
        await using var stream = File.OpenRead(request.SourcePath);
        var put = new PutObjectRequest
        {
            BucketName = bucket,
            Key = objectKey,
            InputStream = stream,
            ContentType = request.ContentType,
            AutoCloseStream = false
        };
        await client.PutObjectAsync(put, cancellationToken);

        var markdownUrl = string.IsNullOrWhiteSpace(publicBase)
            ? objectKey
            : $"{publicBase}/{objectKey}";

        return new ImageUploadResult(
            ProviderId: Id,
            ObjectPath: objectKey,
            MarkdownUrl: markdownUrl,
            ContentType: request.ContentType,
            Size: new FileInfo(request.SourcePath).Length,
            Sha256: null,
            Width: null,
            Height: null);
    }

    private static IAmazonS3 CreateClient(ImageHostConfig config)
    {
        var accessKey = Require(config, "accessKey");
        var secretKey = Require(config, "secretKey");
        var endpoint = config.Get("endpoint");
        var regionName = config.Get("region") ?? "us-east-1";

        var credentials = new BasicAWSCredentials(accessKey, secretKey);
        if (!string.IsNullOrWhiteSpace(endpoint))
        {
            var s3Config = new AmazonS3Config
            {
                ServiceURL = endpoint,
                ForcePathStyle = true
            };
            return new AmazonS3Client(credentials, s3Config);
        }

        return new AmazonS3Client(credentials, RegionEndpoint.GetBySystemName(regionName));
    }

    private static string Require(ImageHostConfig config, string key) =>
        config.Get(key) ?? throw new InvalidOperationException($"缺少配置项: {key}");
}
