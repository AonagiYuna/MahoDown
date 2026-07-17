use serde_json::{json, Value};
use std::collections::HashMap;

use crate::settings::{get_secret, load_settings, AppSettings};

/// OpenAI-compatible chat completion (DeepSeek / OpenAI / Ollama / 硅基流动 / Moonshot …).
pub fn complete(action: &str, text: &str, context: &str) -> Result<String, String> {
    let settings = load_settings();
    let base = settings
        .ai_base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    if base.is_empty() {
        return Err("请先在设置 → AI 中配置 API Base URL".into());
    }
    let model = if settings.ai_model.trim().is_empty() {
        "deepseek-chat".to_string()
    } else {
        settings.ai_model.trim().to_string()
    };
    let key = get_secret("ai", "token")
        .filter(|s| !s.is_empty())
        .ok_or("请先在设置 → AI 中填写 API Key")?;

    let (system, user) = build_messages(action, text, context)?;
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": if action == "continue" { 0.8 } else { 0.4 },
        "stream": false
    });

    let content = post_completion(&base, &key, &body)?;
    // Strip common markdown fences if model wraps entire answer
    Ok(strip_outer_fence(&content))
}

const DOC_START: &str = "<<<MAHODOWN_DOC>>>";
const DOC_END: &str = "<<<END>>>";

/// Multi-turn chat that can also edit the whole document. `messages` is the
/// panel's history (user/assistant). Returns `{ reply, document|null }`.
pub fn chat(messages: &[(String, String)], document: &str, model_override: &str) -> Result<Value, String> {
    let settings = load_settings();
    let base = settings.ai_base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("请先在设置 → AI 中配置 API Base URL".into());
    }
    let model = {
        let m = model_override.trim();
        if !m.is_empty() {
            m.to_string()
        } else if settings.ai_model.trim().is_empty() {
            "deepseek-chat".to_string()
        } else {
            settings.ai_model.trim().to_string()
        }
    };
    let key = get_secret("ai", "token")
        .filter(|s| !s.is_empty())
        .ok_or("请先在设置 → AI 中填写 API Key")?;

    let system = format!(
        "你是 MahoDown 的写作助手，嵌入在一个 Markdown 编辑器里。\n\
         - 正常问答时用简洁中文回复。\n\
         - 当用户希望你修改文档（润色、改写、增删、翻译、调整结构等）时：先用一两句话说明你改了什么，\
         然后输出【完整】的修改后 Markdown 文档，并严格用下面两行标记包裹（每个标记独占一行）：\n\
         {DOC_START}\n（这里放完整文档内容）\n{DOC_END}\n\
         只有确实修改文档时才输出这个块；纯问答不要输出。必须输出整篇文档（含未改动部分），不要用省略号省略。"
    );
    let doc_msg = format!("这是当前文档，全文如下：\n{DOC_START}\n{document}\n{DOC_END}");

    let mut msgs = vec![
        json!({ "role": "system", "content": system }),
        json!({ "role": "system", "content": doc_msg }),
    ];
    for (role, content) in messages {
        let r = if role == "assistant" { "assistant" } else { "user" };
        msgs.push(json!({ "role": r, "content": content }));
    }

    let body = json!({ "model": model, "messages": msgs, "temperature": 0.5, "stream": false });
    let content = post_completion(&base, &key, &body)?;
    let (reply, doc) = split_doc(&content);
    Ok(json!({ "reply": reply, "document": doc }))
}

/// Split an assistant reply into chat text + optional full-document block.
fn split_doc(content: &str) -> (String, Option<String>) {
    if let Some(start) = content.find(DOC_START) {
        let before = content[..start].trim().to_string();
        let after = &content[start + DOC_START.len()..];
        let doc = match after.find(DOC_END) {
            Some(end) => &after[..end],
            None => after, // start marker but truncated / no end marker
        };
        let doc = doc.trim_matches(|c: char| c == '\n' || c == '\r').to_string();
        let reply = if before.is_empty() {
            "已更新文档，请在下方查看改动。".to_string()
        } else {
            before
        };
        return (reply, Some(doc));
    }
    (content.trim().to_string(), None)
}

fn chat_url(base: &str) -> String {
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

/// Shared OpenAI-compatible POST → assistant message content.
fn post_completion(base: &str, key: &str, body: &Value) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(chat_url(base))
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .map_err(|e| format!("AI 请求失败: {e}"))?;

    let status = resp.status();
    let raw = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        let hint = serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| {
                v.pointer("/error/message")
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| raw.chars().take(200).collect());
        return Err(format!("AI 返回 {status}: {hint}"));
    }
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| format!("解析 AI 响应失败: {e}"))?;
    parsed
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "AI 未返回有效内容".to_string())
}

fn build_messages(action: &str, text: &str, context: &str) -> Result<(String, String), String> {
    let text = text.trim();
    let context = context.trim();
    match action {
        "polish" => {
            if text.is_empty() {
                return Err("请先选中要润色的文字".into());
            }
            Ok((
                "你是中文写作润色助手。保持原意、人称与 Markdown 结构（加粗/列表/标题等），\
                 让表达更通顺、准确、自然。只输出润色后的正文，不要解释、不加引号、不要前后缀。"
                    .into(),
                format!("请润色以下内容：\n\n{text}"),
            ))
        }
        "continue" => {
            let ctx = if !context.is_empty() {
                context
            } else if !text.is_empty() {
                text
            } else {
                return Err("没有可续写的上下文".into());
            };
            // Cap context size
            let ctx = if ctx.chars().count() > 3000 {
                let s: String = ctx.chars().rev().take(3000).collect::<String>().chars().rev().collect();
                s
            } else {
                ctx.to_string()
            };
            Ok((
                "你是中文写作助手。根据给定 Markdown 上下文自然续写下一段，保持语气与格式一致。\
                 只输出续写部分，不要重复原文，不要解释。"
                    .into(),
                format!("上下文：\n\n{ctx}\n\n请续写："),
            ))
        }
        "translate" => {
            if text.is_empty() {
                return Err("请先选中要翻译的文字".into());
            }
            let mostly_cjk = text.chars().filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c)).count()
                * 2
                > text.chars().filter(|c| !c.is_whitespace()).count();
            let direction = if mostly_cjk {
                "将以下中文翻译成地道英文"
            } else {
                "将以下英文翻译成通顺中文"
            };
            Ok((
                "你是翻译助手。保持 Markdown 结构。只输出译文，不要解释。"
                    .into(),
                format!("{direction}：\n\n{text}"),
            ))
        }
        other => Err(format!("未知 AI 动作: {other}")),
    }
}

fn strip_outer_fence(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        if let Some(nl) = rest.find('\n') {
            let body = &rest[nl + 1..];
            if let Some(end) = body.rfind("```") {
                return body[..end].trim().to_string();
            }
        }
    }
    t.to_string()
}

pub fn ai_settings_public(settings: &AppSettings) -> Value {
    let has_key = get_secret("ai", "token")
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    json!({
        "aiBaseUrl": settings.ai_base_url,
        "aiModel": settings.ai_model,
        "aiApiKey": if has_key { "********" } else { "" },
        "hasAiKey": has_key
    })
}

pub fn merge_ai_into_settings_json(mut value: Value, settings: &AppSettings) -> Value {
    if let Some(obj) = value.as_object_mut() {
        let pub_ai = ai_settings_public(settings);
        if let Some(map) = pub_ai.as_object() {
            for (k, v) in map {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    value
}

/// Preset catalog for UI (OpenAI-compatible endpoints).
pub fn presets() -> Vec<HashMap<&'static str, &'static str>> {
    vec![
        HashMap::from([
            ("id", "deepseek"),
            ("title", "DeepSeek"),
            ("baseUrl", "https://api.deepseek.com/v1"),
            ("model", "deepseek-chat"),
        ]),
        HashMap::from([
            ("id", "openai"),
            ("title", "OpenAI"),
            ("baseUrl", "https://api.openai.com/v1"),
            ("model", "gpt-4o-mini"),
        ]),
        HashMap::from([
            ("id", "moonshot"),
            ("title", "Moonshot / Kimi"),
            ("baseUrl", "https://api.moonshot.cn/v1"),
            ("model", "moonshot-v1-8k"),
        ]),
        HashMap::from([
            ("id", "siliconflow"),
            ("title", "硅基流动"),
            ("baseUrl", "https://api.siliconflow.cn/v1"),
            ("model", "deepseek-ai/DeepSeek-V3"),
        ]),
        HashMap::from([
            ("id", "ollama"),
            ("title", "Ollama 本地"),
            ("baseUrl", "http://127.0.0.1:11434/v1"),
            ("model", "qwen2.5"),
        ]),
    ]
}
