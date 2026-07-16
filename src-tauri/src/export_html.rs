use std::fs;
use std::path::Path;

pub fn export_html(file_path: &Path, title: &str, markdown: &str, dark: bool) -> Result<(), String> {
    let html = to_html_document(title, markdown, dark);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(file_path, html).map_err(|e| e.to_string())
}

pub fn to_html_document(title: &str, markdown: &str, dark: bool) -> String {
    let body = render_body(markdown);
    let bg = if dark { "#16171b" } else { "#fbfaf8" };
    let fg = if dark { "#e6e7ea" } else { "#1f2023" };
    let muted = if dark { "#a3a6ae" } else { "#6d6c68" };
    let code_bg = if dark { "#111216" } else { "#f2f0ec" };
    format!(
        r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>{title}</title>
<style>
body{{margin:0;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:{bg};color:{fg}}}
main{{max-width:720px;margin:0 auto;padding:48px 24px 80px;line-height:1.9;font-size:15px}}
pre,code{{font-family:Consolas,monospace}}
pre{{background:{code_bg};border-radius:8px;padding:12px 14px;overflow:auto}}
code{{background:{code_bg};border-radius:4px;padding:0 4px}}
pre code{{background:transparent;padding:0}}
blockquote{{border-left:3px solid #9d8cf0;padding:4px 14px;color:{muted}}}
img{{max-width:100%}}
table{{border-collapse:collapse;width:100%;margin:16px 0}}
th,td{{border:1px solid rgba(127,127,127,.35);padding:8px 12px}}
hr{{border:none;border-top:1px solid rgba(127,127,127,.35);margin:24px 0}}
a{{color:#3f77c9}}
</style></head><body><main>{body}</main></body></html>"#,
        title = esc(title),
        bg = bg,
        fg = fg,
        muted = muted,
        code_bg = code_bg,
        body = body
    )
}

fn render_body(markdown: &str) -> String {
    let source = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::new();
    let mut in_code = false;
    let mut code = String::new();
    let mut list: Option<&str> = None;

    let flush_list = |out: &mut String, list: &mut Option<&str>| {
        if let Some(t) = list.take() {
            out.push_str(if t == "ul" { "</ul>" } else { "</ol>" });
        }
    };

    for line in source.lines() {
        if line.starts_with("```") {
            if in_code {
                flush_list(&mut out, &mut list);
                out.push_str(&format!("<pre><code>{}</code></pre>", esc(&code)));
                code.clear();
                in_code = false;
            } else {
                in_code = true;
            }
            continue;
        }
        if in_code {
            code.push_str(line);
            code.push('\n');
            continue;
        }
        if line.trim().is_empty() {
            flush_list(&mut out, &mut list);
            continue;
        }
        if let Some(rest) = heading(line) {
            flush_list(&mut out, &mut list);
            out.push_str(&format!("<h{0}>{1}</h{0}>", rest.0, inline(&rest.1)));
            continue;
        }
        if line.trim() == "---" || line.trim() == "***" {
            flush_list(&mut out, &mut list);
            out.push_str("<hr />");
            continue;
        }
        if let Some(q) = line.strip_prefix("> ") {
            flush_list(&mut out, &mut list);
            out.push_str(&format!("<blockquote><p>{}</p></blockquote>", inline(q)));
            continue;
        }
        if let Some(item) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            if list != Some("ul") {
                flush_list(&mut out, &mut list);
                out.push_str("<ul>");
                list = Some("ul");
            }
            out.push_str(&format!("<li>{}</li>", inline(item)));
            continue;
        }
        if let Some(pos) = line.find(". ") {
            if line[..pos].chars().all(|c| c.is_ascii_digit()) {
                if list != Some("ol") {
                    flush_list(&mut out, &mut list);
                    out.push_str("<ol>");
                    list = Some("ol");
                }
                out.push_str(&format!("<li>{}</li>", inline(&line[pos + 2..])));
                continue;
            }
        }
        flush_list(&mut out, &mut list);
        out.push_str(&format!("<p>{}</p>", inline(line)));
    }
    if in_code {
        out.push_str(&format!("<pre><code>{}</code></pre>", esc(&code)));
    }
    flush_list(&mut out, &mut list);
    out
}

fn heading(line: &str) -> Option<(usize, String)> {
    let mut level = 0usize;
    for c in line.chars() {
        if c == '#' {
            level += 1;
        } else {
            break;
        }
    }
    if level == 0 || level > 6 {
        return None;
    }
    let rest = line[level..].strip_prefix(' ')?;
    Some((level, rest.to_string()))
}

fn inline(text: &str) -> String {
    let mut s = esc(text);
    // images ![alt](url)
    s = replace_delim(&s, "![", "](", ")", |alt, url| {
        format!("<img src=\"{url}\" alt=\"{alt}\" />")
    });
    // links [text](url)
    s = replace_delim(&s, "[", "](", ")", |t, url| format!("<a href=\"{url}\">{t}</a>"));
    s = replace_wrap(&s, "**", "<strong>", "</strong>");
    s = replace_wrap(&s, "~~", "<del>", "</del>");
    s = replace_wrap(&s, "`", "<code>", "</code>");
    s
}

fn replace_wrap(input: &str, delim: &str, open: &str, close: &str) -> String {
    let mut out = input.to_string();
    loop {
        let Some(a) = out.find(delim) else { break };
        let rest = &out[a + delim.len()..];
        let Some(b) = rest.find(delim) else { break };
        let inner = &rest[..b];
        out = format!(
            "{}{}{}{}{}",
            &out[..a],
            open,
            inner,
            close,
            &rest[b + delim.len()..]
        );
    }
    out
}

fn replace_delim(
    input: &str,
    start: &str,
    mid: &str,
    end: &str,
    f: impl Fn(&str, &str) -> String,
) -> String {
    let mut out = input.to_string();
    loop {
        let Some(a) = out.find(start) else { break };
        let after = &out[a + start.len()..];
        let Some(m) = after.find(mid) else { break };
        let left = &after[..m];
        let after_mid = &after[m + mid.len()..];
        let Some(e) = after_mid.find(end) else { break };
        let right = &after_mid[..e];
        let replaced = f(left, right);
        out = format!(
            "{}{}{}",
            &out[..a],
            replaced,
            &after_mid[e + end.len()..]
        );
    }
    out
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
