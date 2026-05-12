//! AI module: Ollama integration with retry, streaming, and structured output.
//!
//! Endpoints used:
//!   - POST /api/generate (one-shot)
//!   - POST /api/chat     (multi-turn for context-aware drafts)
//!   - GET  /api/tags     (list installed models for UI dropdown)

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

use crate::db::pool;

const DEFAULT_MODEL: &str = "llama3.1:8b";
const OLLAMA_BASE: &str = "http://localhost:11434";
const MAX_RETRIES: usize = 2;

fn current_model() -> String {
    let conn = match pool().get() {
        Ok(c) => c,
        Err(_) => return DEFAULT_MODEL.to_string(),
    };
    conn.query_row(
        "SELECT value FROM settings WHERE key='ai_model'",
        [],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_else(|_| DEFAULT_MODEL.to_string())
}

pub fn set_model(model: &str) -> Result<()> {
    let conn = pool().get()?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('ai_model', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [model],
    )?;
    Ok(())
}

fn http_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()?)
}

#[derive(Serialize)]
struct GenReq<'a> {
    model: &'a str,
    prompt: String,
    stream: bool,
    format: Option<&'a str>,
    options: Option<GenOptions>,
}

#[derive(Serialize)]
struct GenOptions {
    temperature: f32,
    num_ctx: u32,
}

#[derive(Deserialize)]
struct GenResp {
    response: String,
    #[serde(default)]
    #[allow(dead_code)]
    done: bool,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

#[derive(Serialize)]
struct ChatReq<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    format: Option<&'a str>,
    options: Option<GenOptions>,
}

#[derive(Deserialize)]
struct ChatResp {
    message: ChatMessage,
}

#[derive(Deserialize)]
struct TagsResp {
    models: Vec<TagModel>,
}
#[derive(Deserialize, Serialize)]
pub struct TagModel {
    pub name: String,
    pub size: Option<u64>,
}

pub async fn list_models() -> Result<Vec<TagModel>> {
    let client = http_client()?;
    let r = client
        .get(format!("{}/api/tags", OLLAMA_BASE))
        .send()
        .await
        .context("Ollama not reachable")?;
    let body: TagsResp = r.json().await?;
    Ok(body.models)
}

async fn generate(prompt: String, json_mode: bool, temperature: f32) -> Result<String> {
    let model = current_model();
    let client = http_client()?;
    let req = GenReq {
        model: &model,
        prompt,
        stream: false,
        format: if json_mode { Some("json") } else { None },
        options: Some(GenOptions {
            temperature,
            num_ctx: 8192,
        }),
    };

    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..=MAX_RETRIES {
        match client
            .post(format!("{}/api/generate", OLLAMA_BASE))
            .json(&req)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                let body: GenResp = r.json().await?;
                return Ok(body.response);
            }
            Ok(r) => {
                last_err = Some(anyhow!("Ollama HTTP {}: {}", r.status(), r.text().await.unwrap_or_default()));
            }
            Err(e) => {
                last_err = Some(e.into());
            }
        }
        if attempt < MAX_RETRIES {
            tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("ollama failed")))
}

async fn chat(messages: &[ChatMessage], json_mode: bool, temperature: f32) -> Result<String> {
    let model = current_model();
    let client = http_client()?;
    let req = ChatReq {
        model: &model,
        messages,
        stream: false,
        format: if json_mode { Some("json") } else { None },
        options: Some(GenOptions {
            temperature,
            num_ctx: 8192,
        }),
    };
    let r = client
        .post(format!("{}/api/chat", OLLAMA_BASE))
        .json(&req)
        .send()
        .await
        .context("Ollama not reachable")?;
    if !r.status().is_success() {
        return Err(anyhow!("Ollama HTTP {}", r.status()));
    }
    let body: ChatResp = r.json().await?;
    Ok(body.message.content)
}

// ---------- Public AI operations ----------

pub async fn draft_reply(email_body: &str, context: Option<&str>) -> Result<String> {
    draft_reply_with_tone(email_body, context, "neutral").await
}

pub async fn draft_reply_with_tone(email_body: &str, context: Option<&str>, tone: &str) -> Result<String> {
    let tone_instruction = match tone {
        "formal" => "Write in a formal, professional business tone.",
        "casual" => "Write in a casual, friendly tone.",
        _ => "Match the formality of the incoming email.",
    };
    let system = format!(
        "You are a professional business email assistant. Draft a concise, polite, \
         contextually appropriate reply. {}. Do not invent specifics. If you need \
         information you don't have, ask a clear follow-up question instead of guessing.",
        tone_instruction
    );

    let user_prompt = match context {
        Some(ctx) => format!(
            "Context about the client and our recent interactions:\n{}\n\nEmail to reply to:\n{}\n\nWrite the reply only, no preamble.",
            ctx, email_body
        ),
        None => format!(
            "Email to reply to:\n{}\n\nWrite the reply only, no preamble.",
            email_body
        ),
    };

    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: system.into(),
        },
        ChatMessage {
            role: "user".into(),
            content: user_prompt,
        },
    ];
    chat(&messages, false, 0.4).await
}

pub async fn extract_structured(email_body: &str) -> Result<Value> {
    let prompt = format!(
        r#"Extract structured data from this business email. Return ONLY valid JSON matching this schema:

{{
  "client_name": string|null,
  "client_email": string|null,
  "requested_services": [string],
  "billing_hours": number|null,
  "amounts_mentioned": [{{ "description": string, "amount": number, "currency": string }}],
  "dates_mentioned": [string],
  "action_required": string,
  "urgency": "low"|"medium"|"high",
  "sentiment": "positive"|"neutral"|"negative",
  "follow_up_needed": boolean
}}

Email:
{}"#,
        email_body
    );
    let raw = generate(prompt, true, 0.1).await?;
    let parsed: Value = serde_json::from_str(&raw)
        .with_context(|| format!("AI returned invalid JSON: {}", raw))?;
    Ok(parsed)
}

/// Summarize a thread of historical interactions for context-injection into draft_reply.
pub async fn summarize_history(interactions: &[String]) -> Result<String> {
    if interactions.is_empty() {
        return Ok("No prior history.".into());
    }
    let joined = interactions
        .iter()
        .enumerate()
        .map(|(i, s)| format!("[{}] {}", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    let prompt = format!(
        "Summarize this client interaction history in 3-5 bullet points covering: \
         outstanding asks, agreed deliverables, billing context. Be concise.\n\n{}",
        joined
    );
    generate(prompt, false, 0.3).await
}

/// Suggest line items for an invoice from a free-form description.
pub async fn suggest_invoice_items(description: &str) -> Result<Value> {
    let prompt = format!(
        r#"Generate invoice line items from this work description. Return ONLY valid JSON:

{{
  "items": [
    {{ "description": string, "qty": number, "rate": number, "amount": number }}
  ],
  "suggested_due_days": number
}}

Each item's `amount` must equal `qty * rate`. Use realistic professional rates if not given.

Work description:
{}"#,
        description
    );
    let raw = generate(prompt, true, 0.2).await?;
    Ok(serde_json::from_str(&raw)?)
}

pub async fn health_check() -> Result<bool> {
    let client = http_client()?;
    let r = client
        .get(format!("{}/api/tags", OLLAMA_BASE))
        .send()
        .await;
    Ok(matches!(r, Ok(resp) if resp.status().is_success()))
}

pub async fn draft_newsletter(prompt: &str, tone: &str) -> Result<String> {
    let tone_instruction = match tone {
        "formal" => "formal, professional",
        "casual" => "casual, friendly",
        _ => "neutral, professional",
    };
    let system = format!(
        "You are a professional business email writer for a wholesale distribution company. \
         Write a newsletter email in {} tone. \
         The email will be personalized — use {{{{first_name}}}} as a placeholder where the recipient's name should appear (usually in the greeting). \
         Write only the email body, no subject line. Keep it concise (150-250 words). \
         Do not include any explanation or metadata.",
        tone_instruction
    );
    let messages = vec![
        ChatMessage { role: "system".into(), content: system },
        ChatMessage { role: "user".into(), content: prompt.into() },
    ];
    chat(&messages, false, 0.5).await
}
