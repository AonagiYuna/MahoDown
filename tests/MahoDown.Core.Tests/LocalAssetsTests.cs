using MahoDown.Core.Images;
using Xunit;

namespace MahoDown.Core.Tests;

public class LocalAssetsTests
{
    [Fact]
    public async Task Upload_Writes_To_Img_Beside_Document()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mahodown-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var doc = Path.Combine(dir, "doc.md");
        await File.WriteAllTextAsync(doc, "# doc\n");
        var source = Path.Combine(dir, "raw.png");
        await File.WriteAllBytesAsync(source, new byte[] { 1, 2, 3, 4, 5 });

        var provider = new LocalAssetsImageHostProvider();
        var result = await provider.UploadAsync(
            new ImageUploadRequest(source, "shot.png", "image/png", doc),
            ImageHostConfig.Empty,
            CancellationToken.None);

        Assert.Equal("local", result.ProviderId);
        Assert.StartsWith("img/", result.MarkdownUrl);
        Assert.True(File.Exists(Path.Combine(dir, result.ObjectPath.Replace('/', Path.DirectorySeparatorChar))));

        Directory.Delete(dir, recursive: true);
    }
}
