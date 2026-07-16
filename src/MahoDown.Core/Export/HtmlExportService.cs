using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace MahoDown.Core.Export;

public sealed class HtmlExportService
{
    public string ToHtmlDocument(string title, string markdown, bool dark = false)
    {
        var body = RenderBody(markdown);
        var bg = dark ? "#16171b" : "#fbfaf8";
        var fg = dark ? "#e6e7ea" : "#1f2023";
        var muted = dark ? "#a3a6ae" : "#6d6c68";
        var codeBg = dark ? "#111216" : "#f2f0ec";

        return $$"""
            <!doctype html>
            <html lang="zh-CN">
            <head>
              <meta charset="utf-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1" />
              <title>{{WebUtility.HtmlEncode(title)}}</title>
              <style>
                body{margin:0;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:{{bg}};color:{{fg}};}
                main{max-width:720px;margin:0 auto;padding:48px 24px 80px;line-height:1.9;font-size:15px;}
                h1,h2,h3,h4,h5,h6{font-family:"Noto Serif SC","Songti SC",serif;line-height:1.3}
                h1{font-size:28px} h2{font-size:22px;margin-top:1.4em} h3{font-size:18px}
                pre,code{font-family:"JetBrains Mono",Consolas,monospace}
                pre{background:{{codeBg}};border-radius:8px;padding:12px 14px;overflow:auto}
                code{background:{{codeBg}};border-radius:4px;padding:0 4px}
                pre code{background:transparent;padding:0}
                blockquote{margin:12px 0;padding:4px 14px;border-left:3px solid #9d8cf0;color:{{muted}}}
                img{max-width:100%;border-radius:8px}
                table{border-collapse:collapse;width:100%;margin:16px 0}
                th,td{border:1px solid rgba(127,127,127,.35);padding:8px 12px;text-align:left}
                th{background:rgba(157,140,240,.08)}
                hr{border:none;border-top:1px solid rgba(127,127,127,.35);margin:24px 0}
                li.task{list-style:none;margin-left:-1.2em}
                li.task input{margin-right:8px}
                a{color:#3f77c9}
                del{opacity:.75}
              </style>
            </head>
            <body><main>{{body}}</main></body>
            </html>
            """;
    }

    public async Task ExportHtmlAsync(string filePath, string title, string markdown, bool dark, CancellationToken cancellationToken)
    {
        var html = ToHtmlDocument(title, markdown, dark);
        var dir = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrWhiteSpace(dir))
        {
            Directory.CreateDirectory(dir);
        }

        var bytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(html);
        await File.WriteAllBytesAsync(filePath, bytes, cancellationToken);
    }

    private static string RenderBody(string markdown)
    {
        var source = (markdown ?? string.Empty).Replace("\r\n", "\n").Replace('\r', '\n');
        var codeBlocks = new List<string>();
        var withPlaceholders = Regex.Replace(source, "```(\\w*)\\n([\\s\\S]*?)```", m =>
        {
            var idx = codeBlocks.Count;
            codeBlocks.Add($"<pre data-lang=\"{WebUtility.HtmlEncode(m.Groups[1].Value)}\"><code>{WebUtility.HtmlEncode(m.Groups[2].Value)}</code></pre>");
            return $"\u0000CODE{idx}\u0000";
        });

        var lines = withPlaceholders.Split('\n');
        var sb = new StringBuilder();
        var i = 0;
        string? listType = null;

        void FlushList()
        {
            if (listType is null)
            {
                return;
            }

            sb.Append(listType == "ul" ? "</ul>" : "</ol>");
            listType = null;
        }

        void OpenList(string type)
        {
            if (listType != type)
            {
                FlushList();
                sb.Append(type == "ul" ? "<ul>" : "<ol>");
                listType = type;
            }
        }

        while (i < lines.Length)
        {
            var line = lines[i];
            var codeMatch = Regex.Match(line.Trim(), "^\\u0000CODE(\\d+)\\u0000$");
            if (codeMatch.Success)
            {
                FlushList();
                var idx = int.Parse(codeMatch.Groups[1].Value);
                if (idx >= 0 && idx < codeBlocks.Count)
                {
                    sb.Append(codeBlocks[idx]);
                }

                i++;
                continue;
            }

            if (line.Contains('|') && i + 1 < lines.Length && IsTableSeparator(lines[i + 1]))
            {
                FlushList();
                var header = SplitTableRow(line);
                i += 2;
                var rows = new List<string[]>();
                while (i < lines.Length && lines[i].Contains('|') && !string.IsNullOrWhiteSpace(lines[i]))
                {
                    if (IsTableSeparator(lines[i]))
                    {
                        i++;
                        continue;
                    }

                    rows.Add(SplitTableRow(lines[i]));
                    i++;
                }

                sb.Append("<table><thead><tr>");
                foreach (var cell in header)
                {
                    sb.Append($"<th>{Inline(cell)}</th>");
                }

                sb.Append("</tr></thead><tbody>");
                foreach (var row in rows)
                {
                    sb.Append("<tr>");
                    for (var c = 0; c < header.Length; c++)
                    {
                        var cell = c < row.Length ? row[c] : string.Empty;
                        sb.Append($"<td>{Inline(cell)}</td>");
                    }

                    sb.Append("</tr>");
                }

                sb.Append("</tbody></table>");
                continue;
            }

            var heading = Regex.Match(line, "^(#{1,6})\\s+(.+)$");
            if (heading.Success)
            {
                FlushList();
                var level = heading.Groups[1].Value.Length;
                sb.Append($"<h{level}>{Inline(heading.Groups[2].Value)}</h{level}>");
                i++;
                continue;
            }

            if (Regex.IsMatch(line, @"^\s*(---|\*\*\*|___)\s*$"))
            {
                FlushList();
                sb.Append("<hr />");
                i++;
                continue;
            }

            if (line.StartsWith("> ", StringComparison.Ordinal))
            {
                FlushList();
                sb.Append("<blockquote>");
                while (i < lines.Length && lines[i].StartsWith("> ", StringComparison.Ordinal))
                {
                    sb.Append($"<p>{Inline(lines[i][2..])}</p>");
                    i++;
                }

                sb.Append("</blockquote>");
                continue;
            }

            var task = Regex.Match(line, @"^[-*]\s+\[([ xX])\]\s+(.+)$");
            if (task.Success)
            {
                OpenList("ul");
                var check = char.ToLowerInvariant(task.Groups[1].Value[0]) == 'x' ? " checked" : string.Empty;
                sb.Append($"<li class=\"task\"><input type=\"checkbox\" disabled{check} /> {Inline(task.Groups[2].Value)}</li>");
                i++;
                continue;
            }

            if (Regex.IsMatch(line, @"^[-*]\s+"))
            {
                OpenList("ul");
                sb.Append($"<li>{Inline(Regex.Replace(line, @"^[-*]\s+", string.Empty))}</li>");
                i++;
                continue;
            }

            if (Regex.IsMatch(line, @"^\d+\.\s+"))
            {
                OpenList("ol");
                sb.Append($"<li>{Inline(Regex.Replace(line, @"^\d+\.\s+", string.Empty))}</li>");
                i++;
                continue;
            }

            if (string.IsNullOrWhiteSpace(line))
            {
                FlushList();
                i++;
                continue;
            }

            FlushList();
            sb.Append($"<p>{Inline(line)}</p>");
            i++;
        }

        FlushList();
        return sb.ToString();
    }

    private static bool IsTableSeparator(string line) =>
        Regex.IsMatch(line, @"^\s*\|?[\s:|-]+\|[\s:|-]+\|?\s*$") && line.Contains('|') && line.Contains('-');

    private static string[] SplitTableRow(string line)
    {
        var row = line.Trim();
        if (row.StartsWith('|'))
        {
            row = row[1..];
        }

        if (row.EndsWith('|'))
        {
            row = row[..^1];
        }

        return row.Split('|').Select(c => c.Trim()).ToArray();
    }

    private static string Inline(string text)
    {
        var escaped = WebUtility.HtmlEncode(text);
        escaped = Regex.Replace(escaped, @"!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)", "<img src=\"$2\" alt=\"$1\" />");
        escaped = Regex.Replace(escaped, @"\[([^\]]+)\]\(([^)]+)\)", "<a href=\"$2\">$1</a>");
        escaped = Regex.Replace(escaped, @"\*\*([^*]+)\*\*", "<strong>$1</strong>");
        escaped = Regex.Replace(escaped, @"__([^_]+)__", "<strong>$1</strong>");
        escaped = Regex.Replace(escaped, @"\*([^*]+)\*", "<em>$1</em>");
        escaped = Regex.Replace(escaped, @"_([^_]+)_", "<em>$1</em>");
        escaped = Regex.Replace(escaped, @"~~([^~]+)~~", "<del>$1</del>");
        escaped = Regex.Replace(escaped, @"`([^`]+)`", "<code>$1</code>");
        return escaped;
    }
}
