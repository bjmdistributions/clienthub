# TASK-WHATSAPP: Inventory WhatsApp Sharing

A guided workflow that lets you share available inventory lots to WhatsApp groups with minimal manual steps. ClientHub handles all the formatting, file gathering, and preparation — you just pick the group and click Send.

**Protocol:** Plan first, wait for approval, then execute. Never write code without an approved plan. Push after every task.

---

## Overview

The feature has two phases. Complete Phase 1 before starting Phase 2.

**Phase 1 — Inventory Media Storage**
Lots can have photos and a manifest file attached. Files stored in the Syncthing sync folder so they automatically appear on all devices.

**Phase 2 — WhatsApp Share Workflow**
A split-panel UI inside ClientHub: WhatsApp Web on one side, share tools on the other. ClientHub auto-formats the message, auto-copies it, and shows files ready to drag in. You pick the group, paste, drag files, click Send.

---

## Phase 1: Inventory Media Storage

### Goal
Each inventory lot can store multiple photos and one manifest file (PDF or CSV). Files sync across all devices automatically via Syncthing because they're stored in the shared sync folder.

### Success Criteria
- [ ] Can add photos to a lot — thumbnails shown on lot card and in edit modal
- [ ] Can attach a manifest file (PDF or CSV) to a lot
- [ ] Files appear on MacBook and brother's Mac without any manual steps
- [ ] Removing a photo or manifest deletes the file from disk
- [ ] First photo shown as lot card cover image

### File Storage Strategy

Files stored inside the ClientHub sync folder — the same folder Syncthing already monitors:

**Windows:** `%APPDATA%\com.bjmdistributions.clienthub\media\inventory\{lot_id}\`
**Mac:** `~/Library/Application Support/com.bjmdistributions.clienthub/media/inventory/{lot_id}/`

Subdirectories:
```
media/inventory/{lot_id}/photos/photo_001.jpg
media/inventory/{lot_id}/photos/photo_002.jpg
media/inventory/{lot_id}/manifest.pdf  (or .csv)
```

Stored in database as relative paths from the sync folder root:
```json
photos_json: ["media/inventory/abc123/photos/photo_001.jpg"]
manifest_path: "media/inventory/abc123/manifest.pdf"
```

On read, the app resolves the full path by prepending the app data directory. This means the same relative path works on Windows and Mac without any changes.

### Database Migration (Migration 29)
```sql
ALTER TABLE inventory ADD COLUMN manifest_path TEXT;
```

`photos_json` column already exists — no change needed. Just update how paths are stored (relative instead of absolute).

### New Tauri Commands

```rust
// Add photos to a lot — copies files into sync folder, returns updated photos_json
add_lot_photos(lot_id: String, file_paths: Vec<String>) -> Result<Vec<String>, String>

// Remove a photo from a lot — deletes file from disk, updates photos_json
remove_lot_photo(lot_id: String, photo_path: String) -> Result<Vec<String>, String>

// Attach manifest to a lot — copies file into sync folder, returns relative path
attach_lot_manifest(lot_id: String, file_path: String) -> Result<String, String>

// Remove manifest from a lot — deletes file from disk, clears manifest_path
remove_lot_manifest(lot_id: String) -> Result<(), String>

// Resolve a relative media path to full absolute path for display
resolve_media_path(relative_path: String) -> Result<String, String>
```

### UI Changes

**Lot card (InventoryView.tsx):**
- If lot has photos: show first photo as card background/thumbnail
- Photo count badge: "3 photos" in corner
- Manifest badge: "📄 Manifest" if manifest attached

**Lot edit modal:**
- Photo section: grid of thumbnails, [+ Add Photos] button (multi-select file picker, images only), X button on each to remove, drag to reorder (first = cover)
- Manifest section: shows filename if attached, [Attach Manifest] button (PDF or CSV only), [Remove] if already attached

### Files Changing in Phase 1
| File | Change |
|------|--------|
| `src-tauri/src/db.rs` | Migration 29: manifest_path column |
| `src-tauri/src/commands.rs` | 5 new media commands |
| `src-tauri/src/main.rs` | Register new commands |
| `src/lib/api.ts` | New types + API methods |
| `src/components/InventoryView.tsx` | Photo thumbnails on cards, media section in edit modal |
| `src/index.css` | Photo grid styles, manifest badge styles |

---

## Phase 2: WhatsApp Share Workflow

**Do not start Phase 2 until Phase 1 is complete and verified.**

### Goal
A split-panel view inside ClientHub that shows WhatsApp Web alongside a share toolkit. ClientHub formats the message and gathers files automatically. You pick the group, paste, drag files, send.

### Success Criteria
- [ ] Select lots in inventory → click "Share to WhatsApp" → split panel opens
- [ ] Message is auto-formatted and auto-copied to clipboard on panel open
- [ ] WhatsApp Web loads in the right panel
- [ ] Files panel shows all photos and manifests from selected lots
- [ ] Clicking a file opens it so you can verify before sending
- [ ] Step-by-step instructions visible at all times
- [ ] Panel closes cleanly and returns to inventory

### UI Layout

Full-screen panel replaces the main content area when active:

```
┌─────────────────────────────────────────────────────────────────┐
│  [← Back to Inventory]                    Share to WhatsApp     │
├──────────────────────┬──────────────────────────────────────────┤
│  SHARE TOOLKIT       │                                          │
│  ─────────────────   │                                          │
│  📋 Message          │                                          │
│  ┌────────────────┐  │         WhatsApp Web                     │
│  │ BJM DIST...    │  │         (Tauri WebView)                  │
│  │ 1. Electronics │  │                                          │
│  │ 2. Clothing    │  │    web.whatsapp.com loads here           │
│  │ ...            │  │                                          │
│  └────────────────┘  │    User picks group, pastes,            │
│  [✓ Copied!]         │    drags files, clicks Send             │
│                      │                                          │
│  📎 Files (5)        │                                          │
│  photo_001.jpg  [👁]  │                                          │
│  photo_002.jpg  [👁]  │                                          │
│  photo_003.jpg  [👁]  │                                          │
│  manifest.pdf   [👁]  │                                          │
│                      │                                          │
│  📋 Steps            │                                          │
│  1. ✅ Message copied │                                          │
│  2. Open group chat  │                                          │
│  3. Paste (Ctrl+V)   │                                          │
│  4. Drag files in    │                                          │
│  5. Click Send       │                                          │
│                      │                                          │
│  [Copy Again]        │                                          │
│  [Regenerate]        │                                          │
└──────────────────────┴──────────────────────────────────────────┘
```

### Message Format

Auto-generated from selected lots. User can edit in the text area before copying:

```
📦 *BJM DISTRIBUTIONS — Available Inventory*

1️⃣ *Electronics Mixed Lot*
   📦 150 units
   💰 Asking: $3,800
   📂 Category: Electronics

2️⃣ *Clothing Lot*
   📦 200 units  
   💰 Asking: $1,200
   📂 Category: Clothing

3️⃣ *Shoe Lot*
   📦 50 units
   💰 Asking: $500
   📂 Category: Shoes

[whatsapp_footer setting — default: "💬 Reply to claim or for more info"]
📞 [company phone from settings]
```

WhatsApp renders `*bold*` formatting. The message is pre-formatted for WhatsApp's markdown.

### WhatsApp Web Panel

Use Tauri's `WebviewWindow` to embed `https://web.whatsapp.com` in the right panel. This is NOT automation — it's just a browser panel showing WhatsApp Web normally. The user operates WhatsApp Web manually.

**Important:** WhatsApp Web requires a QR scan on first use and periodically after. This is normal — the user scans it once and stays logged in for weeks.

### File Panel

Shows all media files from selected lots:
- Thumbnail for photos (small preview)
- Icon for PDF/CSV files
- File name and size
- 👁 Preview button — opens file in system default viewer
- Files are shown with their full absolute path visible on hover (for manual drag reference)

Instruction text below files:
> "Drag these files directly into the WhatsApp chat window to attach them"

### Settings Required

Add to settings table (read/write from SettingsView):
- `whatsapp_footer` — default: "💬 Reply to claim or for more info"

### New Tauri Commands for Phase 2

```rust
// Generate formatted WhatsApp message from lot IDs
generate_whatsapp_message(lot_ids: Vec<String>) -> Result<String, String>

// Get all media file paths for selected lots (absolute paths)
get_lot_media_files(lot_ids: Vec<String>) -> Result<LotMediaFiles, String>
// Returns: { photos: Vec<{path, lot_name}>, manifests: Vec<{path, lot_name}> }

// Save whatsapp_footer setting
save_whatsapp_footer(footer: String) -> Result<(), String>

// Get whatsapp_footer setting  
get_whatsapp_footer() -> Result<String, String>
```

### New Component: WhatsAppSharePanel.tsx

Full-screen panel component. Receives selected lot IDs as props.

State:
- `message: string` — editable formatted message
- `copied: boolean` — shows checkmark after copy
- `mediaFiles: LotMediaFiles` — all photos and manifests
- `webviewReady: boolean` — WhatsApp Web loaded

On mount:
1. Generate message via `generate_whatsapp_message(lotIds)`
2. Auto-copy to clipboard via Tauri clipboard plugin
3. Set `copied = true`
4. Load media files via `get_lot_media_files(lotIds)`

### Files Changing in Phase 2
| File | Change |
|------|--------|
| `src-tauri/src/commands.rs` | 4 new commands |
| `src-tauri/src/main.rs` | Register new commands |
| `src/lib/api.ts` | New types + API methods |
| `src/components/WhatsAppSharePanel.tsx` | New — full share panel |
| `src/components/InventoryView.tsx` | "Share to WhatsApp" button + lot selection checkboxes |
| `src/index.css` | Split panel layout, file grid, step indicator styles |
| `src/App.tsx` | Handle whatsapp share panel state (show/hide full panel) |

---

## Important Notes for Agent

**File path resolution:** Always use `app.path().app_data_dir()` to get the base path. Never hardcode paths. Relative paths in DB + runtime resolution = works on all platforms.

**Photo copy on add:** When user adds photos via file picker, COPY the files into the sync folder — do not move them. Original files stay where they are.

**Syncthing sync:** Because files are in the app data directory which Syncthing monitors, photos and manifests will automatically appear on all other devices within seconds of being added. No extra sync logic needed.

**WhatsApp Web panel:** This is a standard Tauri WebviewWindow pointing to web.whatsapp.com. No injection, no automation, no script injection into the WhatsApp page. Just a browser panel. This is safe and within WhatsApp's terms of service.

**Clipboard:** Use `@tauri-apps/plugin-clipboard-manager` for clipboard write. Already installed in the project.

**File drag and drop:** The file panel shows files but cannot programmatically drag them into the WhatsApp Web panel — that's a browser security boundary. The user drags manually. Make this clear in the UI with friendly instructions, not technical language.

---

## Start Instructions

Read this entire document before doing anything.

Generate a plan for **Phase 1 only** (Inventory Media Storage).

The plan must include:
- Exact file storage path on both Windows and Mac
- How relative paths are resolved at runtime
- How Syncthing picks up the new media folder automatically (it should since it's inside the existing sync folder)
- The photo reorder UX in the edit modal
- What happens when a lot is deleted — are the media files also deleted from disk?

State assumptions explicitly. Wait for approval before writing any code.
