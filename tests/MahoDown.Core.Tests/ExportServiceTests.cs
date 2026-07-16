using System.IO.Compression;
using System.Text;
using MahoDown.Core.Export;
using Xunit;

namespace MahoDown.Core.Tests;

public class ExportServiceTests
{
    [Fact]
    public async Task HtmlExport_Writes_Utf8_Document_With_Title_And_Heading()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mahodown-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "out.html");
        var service = new HtmlExportService();

        await service.ExportHtmlAsync(path, "演示标题", "# Hello\n\n段落 **粗体**\n", dark: false, CancellationToken.None);

        var bytes = await File.ReadAllBytesAsync(path);
        Assert.False(bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF);
        var html = Encoding.UTF8.GetString(bytes);
        Assert.Contains("<title>演示标题</title>", html);
        Assert.Contains("<h1>Hello</h1>", html);
        Assert.Contains("<strong>粗体</strong>", html);

        Directory.Delete(dir, recursive: true);
    }

    [Fact]
    public async Task HtmlExport_Renders_Table_OrderedList_And_Task()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mahodown-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "gfm.html");
        var service = new HtmlExportService();
        var md = """
            | A | B |
            | --- | --- |
            | 1 | 2 |

            1. one
            2. two

            - [x] done
            - [ ] todo

            ---
            """;

        await service.ExportHtmlAsync(path, "gfm", md, dark: false, CancellationToken.None);
        var html = await File.ReadAllTextAsync(path);

        Assert.Contains("<table>", html);
        Assert.Contains("<th>A</th>", html);
        Assert.Contains("<ol>", html);
        Assert.Contains("checked", html);
        Assert.Contains("<hr />", html);

        Directory.Delete(dir, recursive: true);
    }

    [Fact]
    public async Task WordExport_Creates_Valid_Docx_Zip_With_Document_Part()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mahodown-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "out.docx");
        var service = new WordExportService();

        await service.ExportDocxAsync(
            path,
            "导出文档",
            "# 标题\n\n正文内容\n\n- 列表项\n\n```\ncode\n```\n",
            CancellationToken.None);

        Assert.True(File.Exists(path));
        Assert.True(new FileInfo(path).Length > 200);

        using (var zip = ZipFile.OpenRead(path))
        {
            Assert.NotNull(zip.GetEntry("[Content_Types].xml"));
            Assert.NotNull(zip.GetEntry("word/document.xml"));
            Assert.NotNull(zip.GetEntry("word/styles.xml"));

            await using var stream = zip.GetEntry("word/document.xml")!.Open();
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var xml = await reader.ReadToEndAsync();
            Assert.Contains("标题", xml);
            Assert.Contains("正文内容", xml);
            Assert.Contains("列表项", xml);
            Assert.Contains("code", xml);
        }

        Directory.Delete(dir, recursive: true);
    }
}
