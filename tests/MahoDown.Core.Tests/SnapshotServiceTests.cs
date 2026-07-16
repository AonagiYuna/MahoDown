using MahoDown.Core.History;
using Xunit;

namespace MahoDown.Core.Tests;

public class SnapshotServiceTests
{
    [Fact]
    public async Task Save_List_Load_RoundTrip()
    {
        var root = Path.Combine(Path.GetTempPath(), "mahodown-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var service = new SnapshotService(root);
        var docPath = Path.Combine(root, "note.md");

        var saved = await service.SaveAsync(docPath, "# snap\n\nhello\n", "manual", CancellationToken.None);
        Assert.False(string.IsNullOrWhiteSpace(saved.Id));
        Assert.Equal("manual", saved.Kind);
        Assert.True(saved.WordCount > 0);

        var list = await service.ListAsync(docPath, CancellationToken.None);
        Assert.Contains(list, item => item.Id == saved.Id);

        var markdown = await service.LoadContentAsync(docPath, saved.Id, CancellationToken.None);
        Assert.Equal("# snap\n\nhello\n", markdown);

        Directory.Delete(root, recursive: true);
    }
}
