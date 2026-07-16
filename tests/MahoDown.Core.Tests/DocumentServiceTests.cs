using MahoDown.Core.Documents;
using Xunit;

namespace MahoDown.Core.Tests;

public class DocumentServiceTests
{
    [Fact]
    public async Task Save_And_Open_RoundTrip_Without_Bom()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mahodown-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "note.md");
        var service = new MarkdownDocumentService(() => DateTimeOffset.Parse("2026-07-16T12:00:00Z"));

        var saved = await service.SaveAsync(DocumentState.NewUntitled().WithContent("# hi\n"), path, CancellationToken.None);
        var bytes = await File.ReadAllBytesAsync(path);

        Assert.False(bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF);
        Assert.Equal(path, saved.FilePath);
        Assert.False(saved.IsDirty);

        var opened = await service.OpenAsync(path, CancellationToken.None);
        Assert.Equal("# hi\n", opened.Markdown);

        Directory.Delete(dir, recursive: true);
    }
}
