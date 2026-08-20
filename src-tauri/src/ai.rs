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

/// Categorize a batch of bank transactions using the app's category vocabulary +
/// extract the counterparty. Input: JSON array of {id, description, direction}.
/// Returns {"results":[{"id","category","counterparty"}]}. Suggestions only.
pub async fn categorize_transactions(items: &Value) -> Result<Value> {
    let prompt = format!(
        r#"You categorize business bank transactions for a wholesale-brokerage. For each transaction pick ONE category value from EXACTLY this list:
- receipt (money IN from a buyer/customer for goods sold)
- service_income (money IN that is commission or a service fee you earned)
- shipping_income (money IN where freight was billed to the customer)
- interest_income (money IN as bank or account interest)
- other_income (money IN that isn't a product sale: rebates, misc)
- customer_refund (money OUT returned to a customer)
- sales_discount (a discount or allowance granted to a customer)
- chargeback (money OUT from a card dispute or chargeback)
- bad_debt (an uncollectible invoice written off)
- payment (money OUT to a supplier for goods)
- merchandise (inventory/stock purchases, general merchandise)
- shipping (postage/freight/carriers: Pirate Ship, USPS, UPS, FedEx)
- customs (customs duty, tariffs, import broker charges)
- packaging (boxes, pallets, labels, shipping supplies)
- storage (3PL, warehousing and pallet storage fees)
- supplier_refund (money IN returned by a supplier)
- purchase_discount (a rebate or early-payment discount from a supplier)
- meals (food, restaurants, coffee, entertainment)
- auto (fuel, gas, parking, rideshare, vehicle)
- travel (flights, hotels, lodging)
- office (office supplies, small office equipment)
- utilities (phone, internet, electric, water)
- rent (rent, warehouse, storage lease)
- repairs (repairs and maintenance)
- equipment (small tools and equipment)
- software (SaaS: Shopify, Google, Airtable, Anthropic, GoDaddy)
- advertising (ads, marketing)
- insurance (business insurance premiums)
- health_insurance (health or medical insurance premiums)
- professional (legal, accounting, professional/general services)
- payroll (wages, contractors, 1099s)
- commissions (sales commission or rep payout)
- retirement (SEP, IRA or 401k contributions)
- education (training, courses, books)
- gifts (client gifts)
- charity (charitable donations)
- fee (bank or wire fees)
- merchant_fees (card processing: Stripe, Square, PayPal, Shopify Payments)
- interest_expense (loan or credit card interest charged)
- other_expense (money OUT that fits nothing above)
- taxes (business or franchise tax payments)
- payroll_taxes (payroll tax deposits: EFTPS, state withholding)
- sales_tax_collected (money IN that is sales tax charged to a customer)
- sales_tax_remitted (money OUT paying sales tax to a state)
- licenses (business licences, permits, registrations, filing fees)
- estimated_tax (the owner's personal estimated income tax payment: IRS, state)
- internal_transfer (moving money between the owner's own accounts)
- card_payment (a payment made TO a credit card)
- owner_draw (owner's personal draw)
- owner_contribution (the owner putting personal money into the business)
- asset_purchase (a vehicle, machine or equipment expected to last years)
- cash_in (ATM or teller cash deposit)
- cash_out (ATM or teller cash withdrawal)
Also extract the counterparty (the other party's name) when present, else "".
Return ONLY valid JSON: {{"results":[{{"id":string,"category":string,"counterparty":string}}]}}

Transactions:
{}"#,
        serde_json::to_string(items).unwrap_or_default()
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

// ---------- Paste-to-load: parse a supplier load post into a structured lot ----------
// Uses Anthropic Claude Haiku (cloud) for reliable extraction from messy WhatsApp
// text and manifest photos. The API key lives in the local `settings` table
// (key `anthropic_api_key`) — device-local, never synced. Cost ~$0.001 per parse.

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const LOAD_MODEL: &str = "claude-haiku-4-5-20251001";

fn anthropic_key() -> Option<String> {
    let conn = pool().get().ok()?;
    conn.query_row("SELECT value FROM settings WHERE key='anthropic_api_key'", [], |r| r.get::<_, String>(0))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// True when an Anthropic key is configured — the UI uses this to prompt for setup.
pub fn has_load_ai_key() -> bool { anthropic_key().is_some() }

const LOAD_SCHEMA: &str = r#"{
  "title": "short buyer-facing product name for this load, e.g. 'Amazon Electronics Returns Pallet'",
  "description": "one to three sentences describing the load, brand mix, notable items",
  "category": "single best category e.g. Electronics, Apparel, General Merchandise, Home Goods, Health & Beauty, Tools & Hardware, Footwear, Toys & Games, Kitchenware, Seasonal",
  "quantity": "number of units, or 1 if it's a single pallet/truckload sold as a lot",
  "unit_price": "per-unit cost if stated, else null",
  "total_cost": "total cost / your buy price if stated, else null",
  "asking_price": "resale / asking price to the buyer if stated, else null",
  "condition": "e.g. new, customer returns, shelf-pulls, overstock, salvage, mixed — or null",
  "location": "city/state or warehouse location if stated, else null",
  "supplier": "supplier or source name if stated, else null",
  "notes": "anything else useful: MOQ, freight terms, manifest availability, pickup — or null"
}"#;


/// Parse a pasted supplier load message (+ optional manifest/screenshot image) into
/// structured lot fields. Returns JSON the UI maps onto the create-lot form.
pub async fn parse_load(text: &str, image_base64: Option<&str>, image_media_type: Option<&str>) -> Result<Value> {
    let key = anthropic_key().ok_or_else(|| anyhow!(
        "No AI key set. Add your Anthropic API key in Settings → Loads to enable paste-to-load."
    ))?;
    if text.trim().is_empty() && image_base64.is_none() {
        return Err(anyhow!("Paste a load message or attach an image first."));
    }

    let system = format!(
        "You extract structured data about a wholesale/liquidation LOAD (a pallet, truckload, \
         or lot of merchandise) from a supplier's message and/or a manifest photo. Return ONLY \
         valid JSON matching this schema — no markdown, no commentary. Use null for anything not \
         stated; never invent prices or quantities. Numbers must be plain numbers (no $ or commas).\n\nSchema:\n{}",
        LOAD_SCHEMA
    );

    // Build the user content: optional image block first, then the text.
    let mut content: Vec<Value> = Vec::new();
    if let (Some(b64), media) = (image_base64, image_media_type) {
        content.push(serde_json::json!({
            "type": "image",
            "source": { "type": "base64", "media_type": media.unwrap_or("image/jpeg"), "data": b64 }
        }));
    }
    let user_text = if text.trim().is_empty() {
        "Extract the load details from the attached image.".to_string()
    } else {
        format!("Supplier message:\n{}", text.trim())
    };
    content.push(serde_json::json!({ "type": "text", "text": user_text }));

    let body = serde_json::json!({
        "model": LOAD_MODEL,
        "max_tokens": 1024,
        "system": system,
        "messages": [{ "role": "user", "content": content }]
    });

    let client = http_client()?;
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..=MAX_RETRIES {
        let resp = client
            .post(ANTHROPIC_URL)
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => {
                let v: Value = r.json().await.context("Anthropic returned invalid JSON")?;
                // content is an array of blocks; take the first text block.
                let raw = v.get("content")
                    .and_then(|c| c.as_array())
                    .and_then(|arr| arr.iter().find_map(|b| b.get("text").and_then(|t| t.as_str())))
                    .ok_or_else(|| anyhow!("Unexpected AI response shape"))?;
                let cleaned = raw.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
                let parsed: Value = serde_json::from_str(cleaned)
                    .with_context(|| format!("AI returned non-JSON: {}", cleaned))?;
                return Ok(parsed);
            }
            Ok(r) => {
                let status = r.status();
                let txt = r.text().await.unwrap_or_default();
                // Auth/quota errors are not worth retrying — surface immediately.
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    return Err(anyhow!("AI key rejected ({}). Check your Anthropic API key in Settings.", status));
                }
                last_err = Some(anyhow!("AI HTTP {}: {}", status, txt));
            }
            Err(e) => last_err = Some(e.into()),
        }
        if attempt < MAX_RETRIES {
            tokio::time::sleep(Duration::from_millis(600 * (attempt as u64 + 1))).await;
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("AI request failed")))
}

/// Extract EVERY transaction from a bank or credit-card statement's raw text using
/// Claude (handles any layout — checking, debit, Chase/Amex cards). Returns
/// {"transactions":[{date,description,amount,direction,category,counterparty}],
///  "ending_balance":number|null}. amount is positive; direction "in"/"out".
pub async fn extract_statement(text: &str, year_hint: i32) -> Result<Value> {
    let key = anthropic_key().ok_or_else(|| anyhow!(
        "No AI key set. Add your Anthropic API key in Settings to enable smart statement import."
    ))?;
    if text.trim().is_empty() {
        return Err(anyhow!("This statement had no readable text to extract."));
    }
    let year_rule = format!(
        " This statement's transactions are from the year {yr}. Every date's year MUST be {yr}, \
except a December date on a January statement uses {prev}. NEVER output any other year.",
        yr = year_hint, prev = year_hint - 1
    );
    let system = "You extract EVERY money transaction from a bank or credit-card statement. \
Return ONLY valid JSON, no markdown: \
{\"transactions\":[{\"date\":\"YYYY-MM-DD\",\"description\":string,\"amount\":number,\"direction\":\"in\"|\"out\",\"category\":string,\"counterparty\":string}],\"ending_balance\":number|null}. \
Rules: amount is ALWAYS a positive plain number (no sign, no $, no commas). \
direction: for a checking/debit account, money leaving = \"out\" and money arriving = \"in\". \
For a CREDIT CARD, a purchase/charge = \"out\" and a payment or credit to the card = \"in\". \
category is exactly one of: receipt, other_income, interest_income, customer_refund, payment, merchandise, shipping, customs, supplier_refund, meals, auto, travel, office, utilities, rent, repairs, software, advertising, insurance, professional, payroll, fee, merchant_fees, interest_expense, taxes, other_expense, internal_transfer, card_payment, owner_draw, cash_in, cash_out. \
Use \"card_payment\" for a payment made TO a credit card, \"internal_transfer\" for a transfer between the owner's own accounts, \"interest_expense\" for interest charged, \"interest_income\" for interest earned, \"merchant_fees\" for card-processing charges, \"customer_refund\" for money returned to a customer, \"supplier_refund\" for money returned by a supplier, \"receipt\" for money in from a customer, \"payment\" for money out to a supplier, and \"other_expense\" when nothing else fits. \
counterparty is the merchant or other party's name, or \"\". \
Infer the 4-digit year from the statement period (rows may show only MM/DD). \
Include fees and interest as transactions. Do NOT emit running-balance, subtotal, 'new balance', 'minimum payment', 'previous balance', or any summary line — only real dated transactions. Never invent transactions.";
    let body = serde_json::json!({
        "model": LOAD_MODEL,
        "max_tokens": 8192,
        "system": format!("{}{}", system, year_rule),
        "messages": [{ "role": "user", "content": [{ "type": "text", "text": format!("Statement text:\n{}", text.trim()) }] }]
    });
    let client = http_client()?;
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..=MAX_RETRIES {
        let resp = client.post(ANTHROPIC_URL)
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body).send().await;
        match resp {
            Ok(r) if r.status().is_success() => {
                let v: Value = r.json().await.context("Anthropic returned invalid JSON")?;
                let raw = v.get("content").and_then(|c| c.as_array())
                    .and_then(|arr| arr.iter().find_map(|b| b.get("text").and_then(|t| t.as_str())))
                    .ok_or_else(|| anyhow!("Unexpected AI response shape"))?;
                let cleaned = raw.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
                let parsed: Value = serde_json::from_str(cleaned)
                    .with_context(|| format!("AI returned non-JSON: {}", cleaned))?;
                return Ok(parsed);
            }
            Ok(r) => {
                let status = r.status();
                let txt = r.text().await.unwrap_or_default();
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    return Err(anyhow!("AI key rejected ({}). Check your Anthropic API key in Settings.", status));
                }
                last_err = Some(anyhow!("AI HTTP {}: {}", status, txt));
            }
            Err(e) => last_err = Some(e.into()),
        }
        if attempt < MAX_RETRIES {
            tokio::time::sleep(Duration::from_millis(600 * (attempt as u64 + 1))).await;
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("AI request failed")))
}

/// One Claude call that must come back as a JSON object. Retries transient failures;
/// an auth/quota rejection surfaces immediately rather than being retried.
async fn claude_json(
    client: &reqwest::Client,
    key: &str,
    system: &str,
    user_text: &str,
    max_tokens: u32,
) -> Result<Value> {
    let body = serde_json::json!({
        "model": LOAD_MODEL,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{ "role": "user", "content": [{ "type": "text", "text": user_text }] }]
    });
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..=MAX_RETRIES {
        let resp = client.post(ANTHROPIC_URL)
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body).send().await;
        match resp {
            Ok(r) if r.status().is_success() => {
                let v: Value = r.json().await.context("Anthropic returned invalid JSON")?;
                let raw = v.get("content").and_then(|c| c.as_array())
                    .and_then(|arr| arr.iter().find_map(|b| b.get("text").and_then(|t| t.as_str())))
                    .ok_or_else(|| anyhow!("Unexpected AI response shape"))?;
                let cleaned = raw.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
                return serde_json::from_str(cleaned)
                    .with_context(|| format!("AI returned non-JSON: {}", cleaned));
            }
            Ok(r) => {
                let status = r.status();
                let txt = r.text().await.unwrap_or_default();
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    return Err(anyhow!("AI key rejected ({}). Check your Anthropic API key in Settings.", status));
                }
                last_err = Some(anyhow!("AI HTTP {}: {}", status, txt));
            }
            Err(e) => last_err = Some(e.into()),
        }
        if attempt < MAX_RETRIES {
            tokio::time::sleep(Duration::from_millis(600 * (attempt as u64 + 1))).await;
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("AI request failed")))
}

/// Characters of manifest text per request, and the ceiling on requests for one
/// document. A 2,000-line manifest does not fit in a single call, and an unbounded
/// loop over a huge PDF would be a surprise bill.
const MANIFEST_CHUNK_CHARS: usize = 12_000;
const MANIFEST_MAX_CHUNKS: usize = 20;

/// Extract every product line from a manifest's raw text — the fallback for a PDF
/// whose layout the deterministic parser can't hold. Returns (rows, truncated),
/// where each row is {description, quantity, price, category, brand} and
/// `truncated` means the document ran past the chunk ceiling, so the totals are
/// incomplete. The caller surfaces that; it is never applied silently.
pub async fn extract_manifest(text: &str) -> Result<(Vec<Value>, bool)> {
    let key = anthropic_key().ok_or_else(|| anyhow!(
        "Add your Anthropic API key in Settings → Loads to let Ecliptr read awkward PDF manifests."
    ))?;
    let text = text.trim();
    if text.is_empty() {
        return Err(anyhow!("This manifest had no readable text."));
    }

    let system = "You extract EVERY product line from a wholesale/liquidation MANIFEST. \
Return ONLY valid JSON, no markdown: \
{\"rows\":[{\"description\":string,\"quantity\":number,\"price\":number,\"category\":string|null,\"brand\":string|null}]}. \
Rules: one entry per product line. \
`price` is the PER-UNIT retail price as a plain number (no $ or commas); if the line gives only an extended/total amount, divide it by the quantity. \
`quantity` is the unit count on that line, or 1 when it is not stated. \
`category` and `brand` ONLY when the manifest states them for that line — otherwise null. Never infer a brand from the description. \
Skip page headers, repeated column headings, subtotals, grand totals and any summary line. \
Never invent lines, quantities or prices. If this text contains no product lines, return {\"rows\":[]}.";

    // Chunk on line boundaries so a row is never split across two requests.
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        if !cur.is_empty() && cur.len() + line.len() + 1 > MANIFEST_CHUNK_CHARS {
            chunks.push(std::mem::take(&mut cur));
        }
        cur.push_str(line);
        cur.push('\n');
    }
    if !cur.trim().is_empty() {
        chunks.push(cur);
    }

    let truncated = chunks.len() > MANIFEST_MAX_CHUNKS;
    if truncated {
        chunks.truncate(MANIFEST_MAX_CHUNKS);
    }

    let client = http_client()?;
    let mut rows: Vec<Value> = Vec::new();
    for chunk in &chunks {
        let v = claude_json(&client, &key, system, &format!("Manifest text:\n{}", chunk), 8192).await?;
        if let Some(arr) = v.get("rows").and_then(|r| r.as_array()) {
            rows.extend(arr.iter().cloned());
        }
    }
    Ok((rows, truncated))
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
