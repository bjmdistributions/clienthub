//! Deterministic parser for contact-form emails that arrive as `Label:` on one
//! line followed by the value on the next line (e.g. the Shopify contact-form
//! notification sent from `mailer@shopify.com`).
//!
//! This runs BEFORE the AI path in signup detection: if the body has a
//! recognizable `Label:\n<value>` structure we extract fields deterministically
//! (no AI, no cost, fully predictable). If it doesn't, callers fall back to AI.
//!
//! Example body:
//!   First Name:
//!   Lydia
//!   Last Name:
//!   Thompson
//!   Email:
//!   x@y.com
//!   Company:
//!   Sunkissed edit LLC
//!   Category 1:
//!   Jewelry
//!   ...

use serde::{Deserialize, Serialize};

/// Structured customer extracted from a contact-form email. Field names match the
/// preview / auto-create contract exactly so the front-end can bind to them.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExtractedCustomer {
    pub first_name: String,
    pub last_name: String,
    pub name: String,
    pub email: String,
    pub phone: String,
    pub company: String,
    pub title: String,
    pub address: String,
    pub city: String,
    pub state: String,
    pub zip: String,
    pub country: String,
    pub tax_id: String,
    /// Sales rep / representative named on the form. Defaults to the company name
    /// when the form didn't specify one (see `parse_form_email`).
    pub sales_rep: String,
    /// Values of any "Category *" / "Jewelry*"-style labels that had a value.
    pub categories: Vec<String>,
    /// Every other non-empty label:value pair, keyed by the original label.
    pub extra: std::collections::BTreeMap<String, String>,
}

/// Normalize a label for matching: lowercase, strip a trailing colon, collapse
/// whitespace, drop a trailing "*" (marks required fields on some forms).
fn norm_label(raw: &str) -> String {
    let s = raw.trim().trim_end_matches(':').trim();
    let s = s.trim_end_matches('*').trim();
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Split the body into `(label, value)` pairs. A line ending in `:` is a label;
/// the following non-empty line (up to the next label) is its value. Values may be
/// blank (label immediately followed by another label or end-of-body).
fn label_value_pairs(body: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = body.lines().collect();
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i].trim();
        // A label is a non-empty line that ends with ':' and has text before it.
        if line.ends_with(':') && line.len() > 1 {
            let label = line[..line.len() - 1].trim().to_string();
            // The value is the next non-empty line, unless that line is itself a
            // label (i.e. this field was left blank).
            let mut value = String::new();
            let mut j = i + 1;
            while j < lines.len() {
                let cand = lines[j].trim();
                if cand.is_empty() {
                    j += 1;
                    continue;
                }
                // Next label → this field is blank; don't consume the next label.
                if cand.ends_with(':') && cand.len() > 1 {
                    break;
                }
                value = cand.to_string();
                j += 1;
                break;
            }
            if !label.is_empty() {
                pairs.push((label, value));
            }
            i = j;
        } else {
            i += 1;
        }
    }
    pairs
}

/// Parse a form-style email body into an `ExtractedCustomer`. Returns `None` when
/// the body has no recognizable `Label:\n<value>` structure (fewer than two
/// label:value pairs), so the caller can fall back to AI extraction.
pub fn parse_form_email(body: &str) -> Option<ExtractedCustomer> {
    let pairs = label_value_pairs(body);
    // Require a couple of structured pairs before we treat this as a form email —
    // one stray "Note:" line in a freeform message shouldn't hijack the AI path.
    if pairs.len() < 2 {
        return None;
    }

    let mut c = ExtractedCustomer::default();
    let mut phone = String::new();
    let mut mobile = String::new();

    for (label, value) in &pairs {
        let key = norm_label(label);
        let val = value.trim().to_string();
        if val.is_empty() {
            continue;
        }
        // "Category *" / anything starting with "category" or "jewelry" → categories.
        if key.starts_with("category") || key.starts_with("jewelry") {
            c.categories.push(val);
            continue;
        }
        match key.as_str() {
            "first name" | "firstname" | "given name" => c.first_name = val,
            "last name" | "lastname" | "surname" | "family name" => c.last_name = val,
            "name" | "full name" | "contact name" | "your name" => c.name = val,
            "email" | "email address" | "e-mail" => c.email = val,
            "phone" | "phone number" | "telephone" | "tel" => phone = val,
            "mobile" | "cell" | "cell phone" | "mobile phone" => mobile = val,
            "company" | "company name" | "business" | "business name" | "organization" | "organisation" => c.company = val,
            "job title" | "title" | "role" => c.title = val,
            "sales rep" | "sales representative" | "rep" | "representative" | "sales person" | "salesperson" => c.sales_rep = val,
            "street address" | "address" | "address line 1" | "street" => c.address = val,
            "city" | "town" => c.city = val,
            "state" | "province" | "region" => c.state = val,
            "zip" | "zip code" | "postal code" | "postcode" => c.zip = val,
            "country" => c.country = val,
            "tax" | "tax id" | "tax number" | "vat" | "vat number" | "ein" | "resale certificate" => c.tax_id = val,
            _ => {
                // Preserve the original (trimmed) label so nothing is lost.
                c.extra.insert(label.trim().to_string(), val);
            }
        }
    }

    // Phone falls back to Mobile when Phone is empty.
    c.phone = if !phone.is_empty() { phone } else { mobile };

    // Derive a display name if the form only gave first/last (or neither).
    if c.name.is_empty() {
        let fl = format!("{} {}", c.first_name, c.last_name);
        let fl = fl.trim().to_string();
        if !fl.is_empty() {
            c.name = fl;
        }
    }

    // Sales rep defaults to the company name when the form didn't specify one.
    if c.sales_rep.trim().is_empty() && !c.company.trim().is_empty() {
        c.sales_rep = c.company.trim().to_string();
    }

    Some(c)
}
