# TASK-GLOBE: 3D Client Globe View for ClientHub

A new "Globe" section in the ClientHub desktop app displaying all clients as glowing 3D pins on an interactive Earth globe. Uses real client address data geocoded to coordinates via a bundled US cities dataset. Built in two sequential phases — geocoding first, globe second.

**Protocol:** Plan first, wait for approval, then execute. Never write code without an approved plan. Push after every task.

---

## Phase 1: Client Geocoding

### Goal
Convert existing client city/state address data into lat/lng coordinates and cache them permanently in each client's metadata. This runs once silently in the background on app startup.

### 1A — Bundled US Cities Dataset

Download the free basic dataset from `https://simplemaps.com/data/us-cities` (uscities.csv). Place it at:
```
src-tauri/assets/uscities.csv
```

The CSV has columns including: `city`, `state_id`, `state_name`, `lat`, `lng`, `population`.

Include it in the Tauri bundle via `tauri.conf.json` resources array so it ships with the app.

**Plan required:** Show exact `tauri.conf.json` change to bundle the CSV as a resource.

### 1B — City Lookup Engine

New file: `src-tauri/src/geocode.rs`

```rust
// Parse uscities.csv at startup into a HashMap for O(1) lookup
// Key: normalized "city|state_id" e.g. "chicago|il"
// Value: (lat: f64, lng: f64)

pub struct CityLookup {
    map: HashMap<String, (f64, f64)>,
}

impl CityLookup {
    pub fn load() -> Result<Self, String>
    // Load CSV from bundled resource path
    // Parse into HashMap
    // Normalize keys: lowercase, trim whitespace

    pub fn lookup(&self, city: &str, state: &str) -> Option<(f64, f64)>
    // Try exact match first: "chicago|il"
    // Try state_name match if state_id fails: "chicago|illinois"
    // Return None if not found
}
```

Initialize once at app startup in `main.rs` using `OnceLock<CityLookup>`. Never re-parsed after first load.

**Plan required:** Show how the OnceLock is initialized and accessed from commands.

### 1C — Tauri Commands

Add to `src-tauri/src/commands.rs`:

```rust
// Geocode a single client by their city + state from metadata
// Reads client metadata, extracts city/state, looks up coordinates
// If found: writes lat + lng back to metadata via record_upsert
// Returns: { lat: f64, lng: f64 } or error string
#[tauri::command]
pub async fn geocode_client(client_id: String) -> Result<(f64, f64), String>

// Geocode ALL clients that have city/state but no lat/lng yet
// Runs silently — no return value, logs progress to console
// Non-blocking: spawns as background task
// Only processes clients where metadata.lat is null/missing
#[tauri::command]
pub async fn geocode_all_clients() -> Result<(), String>
```

**Critical:** `geocode_all_clients` must be non-blocking. Spawn it with `tauri::async_runtime::spawn` and return immediately. Do not await it in `main.rs`.

### 1D — Startup Integration

In `src-tauri/src/main.rs`, after the app is set up:
```rust
// Fire and forget — does not block app launch
tauri::async_runtime::spawn(async {
    if let Err(e) = commands::geocode_all_clients().await {
        eprintln!("geocode error: {}", e);
    }
});
```

Register both new commands in the `.invoke_handler()`.

### 1E — Frontend API

Add to `src/lib/api.ts`:
```typescript
export async function geocodeClient(clientId: string): Promise<{lat: number, lng: number}>
export async function geocodeAllClients(): Promise<void>
```

### 1F — Verification

After implementation, verify by:
1. Running `cargo tauri dev`
2. Opening ClientHub — geocoding should run silently in background
3. After 30 seconds, checking a client with a city/state — their metadata should now have `lat` and `lng` fields
4. Run this in the app's developer console to confirm: `invoke('get_client', { id: '[any-client-id]' })` and check metadata

**Files changing in Phase 1:**
| File | Change |
|------|--------|
| `src-tauri/assets/uscities.csv` | New — bundled city dataset |
| `tauri.conf.json` | Add CSV to resources |
| `src-tauri/src/geocode.rs` | New — city lookup engine |
| `src-tauri/src/commands.rs` | 2 new commands |
| `src-tauri/src/main.rs` | OnceLock init + startup spawn |
| `src-tauri/src/lib.rs` | Register mod geocode |
| `src/lib/api.ts` | 2 new API functions |

---

## Phase 2: 3D Globe View

**Do not start Phase 2 until Phase 1 is verified working and clients have lat/lng in their metadata.**

### Goal
A stunning interactive 3D globe visualization showing all geocoded clients as glowing pins on an Earth globe with rotating clouds and a deep space background. Lives as a new sidebar section in ClientHub.

### 2A — Dependencies

Load via CDN inside the component (no npm install, no build changes):
- Three.js: `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js`
- Globe.gl: `https://cdn.jsdelivr.net/npm/globe.gl@2.27.0/dist/globe.gl.min.js`

Use dynamic script injection in the React component's `useEffect` to load these only when the Globe tab is active. Unload/cleanup when navigating away.

### 2B — Sidebar Navigation

Add "Globe" to the sidebar in `src/App.tsx`:
- Position: after Analytics, before Settings
- Icon: use existing icon set — globe or map icon
- Label: "Globe"
- Tab key: `"globe"`

### 2C — GlobeView Component

New file: `src/components/GlobeView.tsx`

#### Layout
```
┌─────────────────────────────────────────────────┐
│  [canvas: starfield background — full panel]    │
│  ┌─────────────────────────────────────────┐   │
│  │  [WebGL: globe.gl canvas]               │   │
│  │                                         │   │
│  │         🌍 rotating globe               │   │
│  │         ✦ client dots                   │   │
│  │                                         │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│  [bottom-left: client count badge]              │
│  [top-right: "X clients mapped" label]          │
└─────────────────────────────────────────────────┘
```

#### Starfield Background
Full-panel 2D canvas element sitting behind the WebGL canvas (z-index: 0). The globe WebGL canvas sits on top (z-index: 1) with a transparent background.

```javascript
// Starfield implementation
const STAR_COUNT = 800;
// Each star has: x, y, size (0.5–2px), opacity, twinkle speed
// requestAnimationFrame loop:
//   - Clear canvas
//   - For each star: draw circle, update opacity with sin wave for twinkling
//   - Vary twinkle speed per star for natural look
// Stars are static positions, only opacity animates
```

#### Globe Initialization
```javascript
const globe = Globe()
  .globeImageUrl('//unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
  .bumpImageUrl('//unpkg.com/three-globe/example/img/earth-topology.png')
  .backgroundColor('rgba(0,0,0,0)')  // transparent — shows starfield
  .showAtmosphere(true)
  .atmosphereColor('#1a6dff')
  .atmosphereAltitude(0.15)
  (containerRef.current);
```

#### Cloud Layer
Inject after globe initializes using `globe.onGlobeReady()` callback:
```javascript
globe.onGlobeReady(() => {
  const CLOUDS_IMG_URL = '//unpkg.com/three-globe/example/img/fair_clouds_4k.png';
  const CLOUDS_ALT = 0.004;  // altitude above globe surface
  const CLOUDS_ROTATION_SPEED = -0.006;  // degrees per frame

  new THREE.TextureLoader().load(CLOUDS_IMG_URL, cloudsTexture => {
    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(
        globe.getGlobeRadius() * (1 + CLOUDS_ALT),
        75,
        75
      ),
      new THREE.MeshPhongMaterial({
        map: cloudsTexture,
        transparent: true,
        opacity: 0.7,
      })
    );
    globe.scene().add(clouds);

    // Independent cloud rotation loop
    (function rotateClouds() {
      clouds.rotation.y += CLOUDS_ROTATION_SPEED * Math.PI / 180;
      requestAnimationFrame(rotateClouds);
    })();
  });
});
```

**Note:** THREE must be accessed from globe.gl's bundled Three instance to avoid version conflicts: `const THREE = window.THREE` after globe.gl script loads.

#### Client Data Points
```javascript
// Fetch from existing list_clients Tauri command
const clients = await invoke('list_clients_filtered', { filter: {} });

// Parse metadata to extract lat/lng
const points = clients
  .map(c => {
    const meta = JSON.parse(c.metadata || '{}');
    return meta.lat && meta.lng ? {
      lat: meta.lat,
      lng: meta.lng,
      name: c.name,
      city: meta.city || '',
      state: meta.state || '',
      tier: c.tier || 'prospect',
      lastInvoice: c.total_revenue || 0,
      lastContact: c.last_contact_at || null,
      id: c.id,
    } : null;
  })
  .filter(Boolean);

globe
  .pointsData(points)
  .pointLat(d => d.lat)
  .pointLng(d => d.lng)
  .pointColor(() => '#00ffcc')
  .pointAltitude(0.05)
  .pointRadius(0.4)
  .pointsMerge(false)
  .pointLabel(d => `
    <div style="
      background: rgba(0,0,0,0.85);
      border: 1px solid #00ffcc;
      border-radius: 8px;
      padding: 8px 12px;
      color: white;
      font-family: system-ui;
      min-width: 160px;
    ">
      <div style="font-weight:600;font-size:14px">${d.name}</div>
      <div style="font-size:12px;color:#aaa">${d.city}, ${d.state}</div>
    </div>
  `);
```

#### Hover — Client Card
When hovering a point, show a floating card (styled like above label but with more detail). Use globe.gl's built-in `pointLabel` for simplicity — no custom overlay needed.

#### Click — Point Click
```javascript
globe.onPointClick(point => {
  // Stop auto-rotation
  globe.controls().autoRotate = false;

  // Fly camera to client location
  globe.pointOfView({
    lat: point.lat,
    lng: point.lng,
    altitude: 0.5,
  }, 1500); // 1.5 second flight

  // Show client detail panel (see 2D below)
  setSelectedClient(point);
});
```

#### Click — Globe Background Click
```javascript
globe.onGlobeClick(() => {
  // Fly to US overview
  globe.pointOfView({
    lat: 39.8,
    lng: -98.5,
    altitude: 0.8,
  }, 2000);

  // Clear selected client
  setSelectedClient(null);

  // Resume auto-rotation after 5 seconds
  setTimeout(() => {
    globe.controls().autoRotate = true;
  }, 5000);
});
```

#### Auto-rotation
```javascript
globe.controls().autoRotate = true;
globe.controls().autoRotateSpeed = 0.5;

// Stop on any user interaction
globe.controls().addEventListener('start', () => {
  globe.controls().autoRotate = false;
});
```

#### Selected Client Panel
When a client dot is clicked, show a slide-in panel from the right side of the globe view:

```
┌─────────────────────────────┐
│  ✕                          │
│  John Smith                 │
│  [B] Tier Badge             │
│                             │
│  📍 Chicago, IL             │
│  📅 Last contact: 3 days ago│
│  💰 Total revenue: $12,400  │
│                             │
│  [View Full Profile →]      │
└─────────────────────────────┘
```

Clicking "View Full Profile" navigates to the Clients section with that client pre-selected.

Clicking ✕ or clicking the globe background closes the panel.

#### Stats Badge
Bottom-left corner, always visible:
```
● 68 clients mapped
```
Small pill badge, dark background, teal accent color matching the dots.

### 2D — Styling

The globe container takes the full available panel area (same as other full-panel views like Analytics). No scrolling. The globe resizes with the window.

Color palette to match ClientHub's existing dark theme:
- Background: transparent (shows starfield)
- Stars: white with varying opacity
- Atmosphere: `#1a6dff` blue glow
- Client dots: `#00ffcc` neon teal
- Client card: dark background `rgba(0,0,0,0.85)` with teal border
- Selected panel: same dark card style as rest of app

### 2E — Performance Requirements

- Stars: 800 max — no performance impact
- Globe auto-rotation: smooth 60fps
- Cloud rotation: independent rAF, never blocks globe
- Client dots: up to 200 points with no lag (globe.gl handles this natively)
- Cleanup on unmount: cancel all rAF loops, destroy globe instance, remove event listeners

### 2F — Error States

- No clients with coordinates: show globe with no dots + message "No client locations found. Geocoding may still be running — check back in a moment."
- Globe textures fail to load: show error toast, globe still renders with fallback color
- Script CDN fails to load: show "Globe unavailable — check internet connection"

### 2G — Files Changing in Phase 2

| File | Change |
|------|--------|
| `src/App.tsx` | Add Globe tab to sidebar nav |
| `src/components/GlobeView.tsx` | New — full globe component |
| `src/index.css` | Globe-specific styles (starfield canvas, panel overlay, stats badge) |

---

## Build Sequence

**Phase 1 first — do not skip:**
1. Plan Phase 1A-1F → wait for approval → execute → verify geocoding works
2. Check that at least some clients now have lat/lng in their metadata
3. Only then proceed to Phase 2

**Phase 2:**
1. Plan Phase 2A-2G → wait for approval → execute
2. Test: globe renders, stars twinkle, clouds rotate, dots appear, click flies camera, panel shows
3. Verify performance: no frame drops during rotation

---

## Critical Notes for Agent

- `globe.onGlobeReady()` callback is MANDATORY for cloud injection — do not inject Three.js mesh before this fires or the scene won't exist yet
- THREE must come from globe.gl's bundled version (`window.THREE`) — do not import a separate Three.js that conflicts
- The starfield canvas must be a sibling element behind the WebGL canvas, not a parent or child — CSS `position: absolute` with correct z-index stacking
- `globe.controls()` returns the OrbitControls instance — autoRotate and event listeners go here
- Cleanup on React unmount: call `globe._destructor()` if available, cancel all `requestAnimationFrame` IDs stored in refs, remove CDN script tags
- Do not use `globe.gl` npm package — use CDN only to avoid build complexity
- The `list_clients_filtered` command already exists — use it with an empty filter to get all clients
- Metadata is a JSON string that must be parsed: `JSON.parse(client.metadata || '{}')`

---

## Start Instructions

Read this entire document before doing anything.

Generate a Phase 1 plan covering tasks 1A through 1F only.

The plan must list:
- Every file being created or modified
- The exact CSV columns being used from uscities.csv
- How the OnceLock is structured in main.rs
- How city/state is extracted from existing client metadata (show example metadata JSON)
- What happens when city is not found in the lookup (graceful skip, no error)

Wait for approval before writing any code.
