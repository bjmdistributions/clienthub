# WhatsApp Business API — Architecture Document

**Status:** Planning only — no implementation code written. This document locks the schema, API surface, and prerequisites so implementation can proceed when ready.

---

## 1. Data Model

```sql
-- Migration 33 (when this lands):
CREATE TABLE whatsapp_messages (
    id TEXT PRIMARY KEY,                        -- our internal UUID
    wa_message_id TEXT UNIQUE,                  -- WhatsApp's server-assigned ID
    client_id TEXT,                             -- FK to clients (nullable for unknown senders)
    phone_number TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    body TEXT NOT NULL,
    media_url TEXT,                             -- image/file URL from WhatsApp
    media_type TEXT,                            -- 'image','audio','video','document'
    status TEXT NOT NULL DEFAULT 'sent'         -- sent | delivered | read | failed | received
        CHECK(status IN ('sent','delivered','read','failed','received')),
    received_at TEXT,
    sent_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_wa_client ON whatsapp_messages(client_id);
CREATE INDEX idx_wa_phone ON whatsapp_messages(phone_number);
CREATE INDEX idx_wa_received ON whatsapp_messages(received_at);
```

### Additional schema extensions

```sql
-- Client opt-in status (required for WhatsApp's 24-hour conversation window rules)
-- Stored in clients.metadata JSON: whatsapp_opt_in: bool

-- Settings table keys for WhatsApp config:
--   wa_business_id          — WhatsApp Business Account ID
--   wa_phone_number_id      — Sender phone number ID (from Meta dashboard)
--   wa_webhook_verify_token — Token for one-time webhook verification
--   wa_webhook_secret       — Secret for webhook signature verification
--   wa_access_token         — Stored in OS keychain (not settings table)
--   wa_configured           — Boolean flag gating the UI tab
--   wa_approved_template_id — Pre-approved message template for out-of-window sends
```

---

## 2. Interaction Mapping

Every WhatsApp message is mirrored to the existing `interactions` table for the unified client-history timeline view (ClientDetailView).

| Field | Value |
|-------|-------|
| `kind` | `"whatsapp_in"` or `"whatsapp_out"` |
| `subject` | `""` (WhatsApp has no subject line) |
| `body` | `whatsapp_messages.body` |
| `created_at` | `received_at` (inbound) or `sent_at` (outbound) |

The `whatsapp_messages` table is the canonical store. `interactions` is a denormalized projection consumed by ClientDetailView.

---

## 3. UI Layout

New sidebar tab **"WhatsApp"** between Email and Brief, gated by `settings.wa_configured = true`:

```
┌─ WhatsApp Inbox ────────────────────────────────────────────────────────────┐
│ ┌── Conversations ────────────┐  ┌── Thread: Alice Co. (+15551234567) ────┐│
│ │ 🟢 Alice Co.    2 min ago    │  │ Hi, do you have any electronics       ││
│ │    "Hi, do you have…"        │  │ lots available?                       ││
│ │ ⚪ Bob Inc.     1 hr ago     │  │                            10:14 ✓✓   ││
│ │ ⚪ Carol LLC    yesterday    │  │                                        ││
│ │ ...                          │  │ Yes — we have a mixed retail lot      ││
│ │                              │  │ at $2,400. Want details?              ││
│ │  [+ Start new conv]          │  │                            10:18 ✓✓✓  ││
│ └──────────────────────────────┘  │                                        ││
│                                   │ [ Type a message…                   ] ││
│                                   │ [📎] [Send]                            ││
│                                   └────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
```

Tabs insertion in App.tsx:
```
{ id: "email",     label: "Newsletter", icon: Mail },
{ id: "whatsapp",  label: "WhatsApp",   icon: MessageCircle },  // NEW
{ id: "brief",     label: "Brief",      icon: FileText },
```

Rendered conditionally only when `wa_configured` is true.

---

## 4. Sending a Message

**New Tauri command:** `wa_send_message(client_id: String, body: String, media_path: Option<String>) -> Result<(), String>`

Flow:
1. Look up `client.phone` from the clients table (must be in E.164 format: `+15551234567`)
2. Read `wa_access_token` from OS keychain (via `keyring` crate, same pattern as email OAuth)
3. Read `wa_phone_number_id` from settings table
4. POST to Facebook Graph API:
   ```
   POST https://graph.facebook.com/v18.0/{wa_phone_number_id}/messages
   Authorization: Bearer {wa_access_token}
   Content-Type: application/json
   Body: {
     "messaging_product": "whatsapp",
     "to": "{phone_number}",
     "type": "text",
     "text": { "body": "{body}" }
   }
   ```
   (If media, use `type: "image"` / `type: "document"` with `link` or `id` field)
5. On success, parse the response for `messages[0].id` (WhatsApp message ID)
6. Insert a row into `whatsapp_messages` with `direction='outbound'`, `status='sent'`
7. Mirror an `interactions` row with `kind='whatsapp_out'`

**Error handling:** If the 24-hour conversation window has expired, the API returns an error. The command should detect this and retry using the `wa_approved_template_id` if configured.

---

## 5. Receiving Messages — Webhooks

WhatsApp delivers inbound messages and status updates via HTTP POST webhooks to a public URL.

### Pi endpoints

The Pi (`clienthub-api`) gets a new route module `routes/whatsapp.rs`:

```rust
// GET /api/whatsapp/webhook — one-time verification handshake
// WhatsApp sends ?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y
// Verify hub.verify_token matches wa_webhook_verify_token, return hub.challenge

// POST /api/whatsapp/webhook — inbound messages and status updates
// Body is a JSON array of webhook entries from WhatsApp
// Parse each entry:
//   - Extract message details (from, text/body, media, timestamp)
//   - Match phone_number to client (SELECT id FROM clients WHERE phone = ?1)
//   - Insert row into whatsapp_messages
//   - Write sync event via sync::record_upsert so desktop receives it
//   - Verify payload signature using X-Hub-Signature-256 header + wa_webhook_secret
```

### Signature verification

WhatsApp includes an `X-Hub-Signature-256` header: `sha256=<hash>`. Compute `HMAC-SHA256(body, wa_webhook_secret)` and compare. Reject if mismatch.

---

## 6. Prerequisites (Before Implementation Can Begin)

These are external to ClientHub and require manual setup:

1. **Facebook Business Verification** — legal entity, business website, certified bank info. Multi-day approval process.
2. **Meta App Creation** — in Meta Developer Dashboard, create a new app with WhatsApp Business product enabled.
3. **Phone Number Registration** — link a phone number that is NOT registered on personal WhatsApp. Receive verification code via SMS or voice call.
4. **Obtain Tokens** — from Meta dashboard, get `wa_access_token` (temporary, needs refresh logic or permanent token) and `wa_phone_number_id`.
5. **Webhook Configuration** — in Meta dashboard, set the callback URL to `https://{pi-url}/api/whatsapp/webhook` and set the verify token.
6. **Message Templates** — pre-approve templates in Meta dashboard for out-of-window outbound messages. Store the template ID in settings.

---

## 7. 24-Hour Conversation Window

WhatsApp restricts outbound messages outside an active 24-hour conversation window. Outside the window, messages must use a pre-approved Message Template.

**Plan:** The `wa_send_message` command first checks if a template is needed (last inbound message from this client older than 24 hours). If so, it sends using the `approved_template_id` setting. Templates can include variable parameters (e.g., `{{1}}` for client name).

---

## 8. Out of Scope

- No code is written today. This document is a planning artifact.
- No Pi webhook route code exists yet. The route signature and schema above are sufficient to wire it up later.
- No `whatsapp_messages` migration is applied yet (migration 33, to be applied when implementation begins).
- No UI components exist for the WhatsApp inbox.
- No `wa_send_message` Tauri command exists.
- The `reqwest` crate is already in Cargo.toml (used by Google Contacts + sheets sync).
- WhatsApp Business API access is required for any verification — not available in dev.
