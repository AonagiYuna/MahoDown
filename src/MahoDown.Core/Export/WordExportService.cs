using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace MahoDown.Core.Export;

/// <summary>Minimal OOXML (.docx) writer — text-focused, no external OpenXML SDK.</summary>
public sealed class WordExportService
{
    public async Task ExportDocxAsync(string filePath, string title, string markdown, CancellationToken cancellationToken)
    {
        var dir = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrWhiteSpace(dir))
        {
            Directory.CreateDirectory(dir);
        }

        var body = BuildBodyXml(markdown);
        var documentXml = $$"""
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
              <w:body>
                {{body}}
                <w:sectPr>
                  <w:pgSz w:w="12240" w:h="15840"/>
                  <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
                </w:sectPr>
              </w:body>
            </w:document>
            """;

        await using var stream = new FileStream(filePath, FileMode.Create, FileAccess.Write, FileShare.None);
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: false))
        {
            WriteText(zip, "[Content_Types].xml", ContentTypesXml);
            WriteText(zip, "_rels/.rels", PackageRelsXml);
            WriteText(zip, "word/document.xml", documentXml);
            WriteText(zip, "word/_rels/document.xml.rels", DocumentRelsXml);
            WriteText(zip, "word/styles.xml", StylesXml(title));
        }

        await Task.CompletedTask;
        cancellationToken.ThrowIfCancellationRequested();
    }

    private static string BuildBodyXml(string markdown)
    {
        var sb = new StringBuilder();
        var lines = (markdown ?? string.Empty).Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        var inCode = false;
        var code = new StringBuilder();

        void FlushCode()
        {
            if (!inCode)
            {
                return;
            }

            var text = code.ToString().TrimEnd('\n');
            sb.Append(Paragraph(text, "Code"));
            code.Clear();
            inCode = false;
        }

        foreach (var raw in lines)
        {
            if (raw.StartsWith("```", StringComparison.Ordinal))
            {
                if (inCode)
                {
                    FlushCode();
                }
                else
                {
                    inCode = true;
                    code.Clear();
                }

                continue;
            }

            if (inCode)
            {
                code.AppendLine(raw);
                continue;
            }

            if (string.IsNullOrWhiteSpace(raw))
            {
                continue;
            }

            var heading = Regex.Match(raw, @"^(#{1,3})\s+(.+)$");
            if (heading.Success)
            {
                var level = heading.Groups[1].Value.Length;
                var style = level switch
                {
                    1 => "Heading1",
                    2 => "Heading2",
                    _ => "Heading3"
                };
                sb.Append(Paragraph(heading.Groups[2].Value.Trim(), style));
                continue;
            }

            if (raw.StartsWith("> ", StringComparison.Ordinal))
            {
                sb.Append(Paragraph(raw[2..].Trim(), "Quote"));
                continue;
            }

            if (Regex.IsMatch(raw, @"^[-*]\s+"))
            {
                sb.Append(Paragraph("• " + Regex.Replace(raw, @"^[-*]\s+", string.Empty).Trim(), "ListParagraph"));
                continue;
            }

            if (Regex.IsMatch(raw, @"^\d+\.\s+"))
            {
                sb.Append(Paragraph(Regex.Replace(raw, @"^\d+\.\s+", string.Empty).Trim(), "ListParagraph"));
                continue;
            }

            sb.Append(Paragraph(raw.Trim(), "Normal"));
        }

        FlushCode();

        if (sb.Length == 0)
        {
            sb.Append(Paragraph(string.Empty, "Normal"));
        }

        return sb.ToString();
    }

    private static string Paragraph(string text, string style) =>
        $"""
        <w:p>
          <w:pPr><w:pStyle w:val="{style}"/></w:pPr>
          <w:r><w:t xml:space="preserve">{Xml(text)}</w:t></w:r>
        </w:p>
        """;

    private static string Xml(string value) => WebUtility.HtmlEncode(value ?? string.Empty);

    private static void WriteText(ZipArchive zip, string entryName, string content)
    {
        var entry = zip.CreateEntry(entryName, CompressionLevel.Optimal);
        using var writer = new StreamWriter(entry.Open(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        writer.Write(content);
    }

    private const string ContentTypesXml =
        """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
          <Default Extension="xml" ContentType="application/xml"/>
          <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
          <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
        </Types>
        """;

    private const string PackageRelsXml =
        """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
        </Relationships>
        """;

    private const string DocumentRelsXml =
        """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
        </Relationships>
        """;

    private static string StylesXml(string title) =>
        $$"""
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:docDefaults>
            <w:rPrDefault><w:rPr>
              <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/>
              <w:sz w:val="22"/>
            </w:rPr></w:rPrDefault>
          </w:docDefaults>
          <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
            <w:name w:val="Normal"/>
            <w:qFormat/>
            <w:pPr><w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr>
          </w:style>
          <w:style w:type="paragraph" w:styleId="Heading1">
            <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>
            <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
            <w:rPr><w:b/><w:sz w:val="36"/></w:rPr>
          </w:style>
          <w:style w:type="paragraph" w:styleId="Heading2">
            <w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/>
            <w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr>
            <w:rPr><w:b/><w:sz w:val="28"/></w:rPr>
          </w:style>
          <w:style w:type="paragraph" w:styleId="Heading3">
            <w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/>
            <w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr>
            <w:rPr><w:b/><w:sz w:val="24"/></w:rPr>
          </w:style>
          <w:style w:type="paragraph" w:styleId="Quote">
            <w:name w:val="Quote"/><w:basedOn w:val="Normal"/>
            <w:pPr><w:ind w:left="420"/><w:spacing w:after="120"/></w:pPr>
            <w:rPr><w:i/><w:color w:val="666666"/></w:rPr>
          </w:style>
          <w:style w:type="paragraph" w:styleId="Code">
            <w:name w:val="Code"/><w:basedOn w:val="Normal"/>
            <w:pPr><w:spacing w:after="120"/></w:pPr>
            <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr>
          </w:style>
          <w:style w:type="paragraph" w:styleId="ListParagraph">
            <w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>
            <w:pPr><w:ind w:left="360"/><w:spacing w:after="60"/></w:pPr>
          </w:style>
          <!-- {{Xml(title)}} -->
        </w:styles>
        """;
}
