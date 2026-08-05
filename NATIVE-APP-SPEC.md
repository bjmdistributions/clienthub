# NATIVE APP SHELL SPEC (iOS + Android)

Spec only — no Capacitor project created, nothing deployed.

---

# Executable spec — Ecliptr native shell (iOS + Android)

**Status:** specification only. No file was created, modified, or deployed. Nothing was installed. Every path below is absolute.

---

## 0. Corrections that change the work, verified in this session

Read these before section 1; three of them invalidate assumptions in the surveys or the plan.

**0.1 — The deploy is not scp any more. It is CI rsync of the entire repo root.**
`C:/Users/Jack/Desktop/clienthub-api/.github/workflows/deploy.yml` (commit `c6eeec7`) runs on every push to `main` touching `src/**`, `www/**`, `Cargo.toml`, `Cargo.lock`, and does:

```
rsync -az --exclude target --exclude node_modules --exclude '.git' --exclude '*.wip-backup' \
  ./ root@161.35.106.143:/home/ecliptr/clienthub-api/
```

Three consequences:
- **Anything placed inside `clienthub-api/` is rsynced to the droplet.** An `ios/` folder (CocoaPods, DerivedData) or `android/` (Gradle caches) would be shipped to the server on the next push. This alone settles section 1: the Capacitor project goes in a **sibling directory**, not in this repo.
- **`src/plaid.rs` is deployed on every push.** The standing rule "never deploy `src/plaid.rs`" is not being honoured by this workflow. That is a pre-existing condition unrelated to this task, but it contradicts the brief I was given and **Jack must confirm which is true** before anyone touches server code for CORS. If the rule still stands, the CORS change cannot go out through this workflow as-is.
- There is no `--delete`, so files removed locally are not removed on the droplet.

**0.2 — The tab bar and the Search hub already shipped.** `C:/Users/Jack/Desktop/clienthub-api/www/index.html:131-152` is `Home · Clients · Inventory · Deals · Search`. Plan §3 "Before" is stale. Phase 3 of the plan is partly done.

**0.3 — In-app account deletion already has a UI**, at `www/app.js:1602` (button) and `:1626-1634` (handler). The plan lists it as unbuilt. The real defects are different and worse: the call is a bare `fetch('/api/account', {method:'DELETE'})` at `:1629` with **no credentials and a relative URL**, and the server refuses when the caller is the only admin (`src/employees.rs:2291-2296`). Both are fixed in section 6.

**0.4 — Verified good news.** `token_from_headers` (`src/employees.rs:955-969`) already accepts `Authorization: Bearer`; login already returns `token` in the body (`:1795-1798`); `POST /api/auth/employee/refresh` exists and is routed (`:2666`). `tower-http` already has the `cors` feature compiled (`Cargo.toml:14`). `POST /api/inventory/:id/photo/:name` is live and open to any authenticated org member (`src/routes/inventory.rs:34`). The camera feature needs **zero** server changes.

**0.5 — Verified: `www/privacy.html` and `www/terms.html` contain no pricing nav, no dollar figures, and no upgrade CTA.** They are safe to bundle. `www/guide.html:84` does link `/#pricing` and is **not** safe to bundle or link to.

---

## 1. Repository shape

### 1.1 Decision

**A sibling directory with its own git repo:** `C:/Users/Jack/Desktop/ecliptr-mobile/`.

Rejected alternatives and why:
- *Inside `clienthub-api/`* — the CI rsync (0.1) would push `ios/`, `android/`, Pods and Gradle output to the droplet. Also mixes a Node/Capacitor toolchain into a Rust repo whose only `package.json` (`C:/Users/Jack/Desktop/clienthub-api/package.json`) exists solely for icon generation (`@resvg/resvg-js`, `png2icons`).
- *Inside `clienthub-api/www/`* — worse: it would also trigger the deploy workflow on every mobile-only commit.
- *A monorepo* — a restructure of a working deploy pipeline for no gain.

### 1.2 The file relationship

`C:/Users/Jack/Desktop/clienthub-api/www/` **remains the single source of truth** for all web content. The mobile project never edits it. A sync script **copies a filtered subset** into `ecliptr-mobile/www-bundle/`, which is Capacitor's `webDir` and is gitignored (it is build output).

The browser PWA deploy is completely unaffected: `www/` still goes to the droplet through the existing workflow, `sw.js` still serves the browser, `manifest.json` still installs. Nothing in `clienthub-api` learns that a native shell exists, with two exceptions that are runtime-gated inside the shared files (`index.html` service-worker registration, and `app.js` `IS_NATIVE`). Both are additive and inert in a browser.

### 1.3 Directory tree

```
C:/Users/Jack/Desktop/
├── clienthub-api/                     ← unchanged, deploys as today
│   ├── src/                           ← CorsLayer edit lands in main.rs
│   └── www/                           ← SOURCE OF TRUTH (app.js, index.html, style.css, fonts/)
│
└── ecliptr-mobile/                    ← NEW. Own git repo. Never rsynced anywhere.
    ├── .gitignore                     ← www-bundle/, node_modules/, ios/App/Pods/,
    │                                     ios/App/build/, android/.gradle/, android/build/,
    │                                     android/app/build/, *.keystore, *.p8, *.mobileprovision,
    │                                     google-services.json, GoogleService-Info.plist
    ├── package.json
    ├── capacitor.config.ts            ← full contents in section 2
    ├── scripts/
    │   ├── sync-web.mjs               ← filtered copy www/ → www-bundle/  (section 1.4)
    │   └── check-bundle.mjs           ← compliance scrub gate (section 8.3) — exits non-zero
    ├── assets/                        ← icon/splash SOURCES (section 5)
    │   ├── icon.png                   ← 1024×1024, NO alpha
    │   ├── icon-foreground.png        ← 1024×1024, mark at ~60%, alpha
    │   ├── icon-background.png        ← 1024×1024, solid #0D0A09
    │   ├── splash.png                 ← 2732×2732
    │   └── splash-dark.png            ← 2732×2732
    ├── ios/                           ← generated by `cap add ios` (macOS only)
    │   └── App/App/
    │       ├── Info.plist             ← usage strings, section 4
    │       ├── PrivacyInfo.xcprivacy  ← section 6.5
    │       └── Assets.xcassets/
    ├── android/                       ← generated by `cap add android`
    │   └── app/src/main/AndroidManifest.xml
    ├── www-bundle/                    ← GENERATED, gitignored, = webDir
    └── README.md                      ← the runbook: sync, build, OTA, release
```

### 1.4 `scripts/sync-web.mjs` — the copy manifest

Reads from `process.env.ECLIPTR_WWW || '../clienthub-api/www'`. **Allowlist, never a blocklist** — a blocklist silently ships the next marketing page someone adds.

**Copy (allowlist):**

| Path | Why |
|---|---|
| `index.html` | app shell |
| `app.js` | the app |
| `style.css` | styles |
| `space.js` | lazy-loaded by `ensureSpace` (`app.js:204-210`) — must be local or that feature 404s |
| `fonts/Satoshi-400.woff2`, `-500`, `-700`, `-900` | referenced absolutely from `style.css:2-5`; they resolve inside the bundle, so this works unchanged |
| `ecliptr-mark.svg` | login card logo (`index.html:93`) |
| `favicon-32.png`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | referenced from `index.html`; cheap, avoids console 404s |
| `manifest.json` | inert natively, but `index.html:34` links it; including it avoids a 404 |
| `privacy.html`, `terms.html` | verified clean (0.5); bundling them lets Data & safety link locally, which works offline and avoids an external nav |

**Never copy (each one is a specific hazard):**

| Path | Hazard |
|---|---|
| `landing.html` | **`$39` / `$99` pricing table and "Start free, upgrade in-app →"** — a purchase surface inside the binary. Guideline 3.1.1. |
| `guide.html` | `:84` links `/#pricing`. Two taps from inside the app to the price list. |
| `register.html`, `signup.html`, `download.html` | signup/marketing funnels into a site whose nav exposes Pricing |
| `shop.html`, `staff.html`, `portal.html` | other products' surfaces, dead weight in the bundle |
| `forgot.html`, `reset.html`, `verify.html`, `sync-health.html` | server-rendered flows; must open in the system browser if ever needed |
| `sw.js` | must not be registrable inside the shell (section 4.6) |
| `og-image.png` | 65 KB of nothing |

**Two mutations to `index.html`, and only two.** The script must `throw` if either anchor string is not found, so an edit to `www/index.html` can never silently produce a broken bundle:

1. Insert, immediately after `<meta charset="UTF-8">`:
   `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: https://m.ecliptr.app; connect-src 'self' https://m.ecliptr.app; base-uri 'self'; object-src 'none'">`
   Without `https://m.ecliptr.app` in `connect-src` **and** `img-src`, every API call and every lot photo is blocked by CSP rather than by CORS — a different error with the same symptom.
2. Insert, immediately before `<script src="app.js?v=`:
   `<script>window.__ECLIPTR_BUILD__={id:"<bundleId>",sha:"<clienthub-api git sha>",at:"<ISO date>"};</script>`
   This is what replaces the hardcoded `const BUILD = 'm20 · 2026-07-05'` at `www/app.js:76` that currently renders a stale version string in Settings (audit E6).

The script also writes `www-bundle/build.json` with the same three fields, which the OTA channel (section 8) uses as its version identity.

---

## 2. `capacitor.config.ts`

Full file, `C:/Users/Jack/Desktop/ecliptr-mobile/capacitor.config.ts`:

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.ecliptr.mobile',
  appName: 'Ecliptr',

  // The bundle produced by scripts/sync-web.mjs. This directory is COPIED into
  // the .ipa / .aab at build time. Guideline 2.5.2: every screen ships here.
  webDir: 'www-bundle',

  server: {
    // Android serves the bundle from https://localhost so the webview origin is a
    // secure context (crypto.randomUUID, biometrics, Filesystem all require it).
    // iOS keeps the default capacitor://localhost.
    androidScheme: 'https',

    // NO `url` and NO `hostname` key. Setting server.url points the webview at the
    // live site and makes the app a remote-content shell — the exact Guideline
    // 2.5.2 rejection. Use it ONLY for local development (section 7.2), never in
    // a build that is archived or uploaded.

    // Nothing may navigate inside the webview. External destinations (privacy
    // policy on the web, storefront links, /guide) open in the system browser via
    // @capacitor/browser. An empty allowlist is what enforces that.
    allowNavigation: []
  },

  ios: {
    // Default 'capacitor' scheme → origin capacitor://localhost. Must be in the
    // server CorsLayer allowlist (section 3.1).
    scheme: 'Ecliptr',
    contentInset: 'always'

    // DO NOT set limitsNavigationsToAppBoundDomains. It forces WKAppBoundDomains
    // and restricts several WebKit APIs; it buys nothing here because auth is
    // Bearer, not cookies.
  },

  android: {
    allowMixedContent: false,
    captureInput: true
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 0,          // storyboard handles first paint; no artificial delay
      backgroundColor: '#0D0A09',     // matches manifest.json background_color
      showSpinner: false,
      androidSplashResourceName: 'splash'
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound']   // no 'alert': foreground pushes refresh
                                                // the bell badge, they do not cover the
                                                // screen the user is working in
    },
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true
    }
  }
};

export default config;
```

### The 2.5.2 bundle-vs-remote decision, stated plainly

Capacitor supports `server.url`, which makes the webview load `https://m.ecliptr.app` directly. That is a one-line path to a working app and it is **the single fastest way to get rejected**. Guideline 2.5.2 requires the app to be self-contained; a shell that fetches its screens at runtime is not. `webDir` is therefore non-negotiable for any build that leaves the machine. `server.url` may be used only for hot-reload during local development (`npx cap run ios --live-reload`), and `check-bundle.mjs` (section 8.3) must fail the build if `server.url` is present in the config at archive time.

---

## 3. The auth change — the thing most likely to block first boot

Today: session held in an `HttpOnly; SameSite=Strict` cookie (`src/employees.rs:509`), every call in `app.js` is root-relative with `credentials:'include'` (`www/app.js:162-201`). Inside the shell the document origin is `capacitor://localhost` (iOS) or `https://localhost` (Android). Three independent failures stack up: relative URLs 404 against the bundle; `SameSite=Strict` means the cookie is never sent and the login `Set-Cookie` is never stored; and `grep -rn "CorsLayer\|allow_origin" src/` returns **nothing**, so every preflight falls through to `fallback_service(ServeDir::new("www"))` (`src/main.rs:190`) and dies.

### 3.1 Server change — one layer, one file

**File: `C:/Users/Jack/Desktop/clienthub-api/src/main.rs`.** No dependency change (`Cargo.toml:14` already has the `cors` feature).

Add to the imports at the top (near `use tower_http::services::ServeDir;`, `main.rs:23`):

```rust
use tower_http::cors::{AllowOrigin, CorsLayer};
use axum::http::Method;
```

Build the layer just above `let app = Router::new()` (`main.rs:110`):

```rust
    // CORS for the native shells only. The webview document origin is
    // capacitor://localhost (iOS) / https://localhost (Android), so every API call
    // from the app is cross-origin. Explicit allowlist, never Any.
    //
    // allow_credentials is deliberately ABSENT: the shell authenticates with
    // `Authorization: Bearer`, not the session cookie. Adding credentials here
    // would also require dropping the wildcard-free guarantee and would let a
    // cross-site page ride the cookie.
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list([
            HeaderValue::from_static("capacitor://localhost"), // iOS
            HeaderValue::from_static("ionic://localhost"),     // legacy iOS scheme
            HeaderValue::from_static("http://localhost"),      // Android, http scheme
            HeaderValue::from_static("https://localhost"),     // Android, androidScheme https
        ]))
        .allow_methods([
            Method::GET, Method::POST, Method::PUT,
            Method::PATCH, Method::DELETE, Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .max_age(std::time::Duration::from_secs(86_400));
```

Apply it as the **last** `.layer()` in the chain — after `.layer(CatchPanicLayer::new())` at `main.rs:229` — because in Axum the last layer added is the outermost, and CORS must answer the `OPTIONS` preflight before routing can reject it:

```rust
        .layer(CatchPanicLayer::new())
        .layer(cors);
```

`AllowOrigin::list` with `HeaderValue::from_static` is required rather than the string-parsing helpers, because `capacitor://` and `ionic://` are not HTTP schemes and some helpers reject them.

**Verification, and this needs no Mac and no Apple account:**

```bash
curl -i -X OPTIONS https://m.ecliptr.app/api/clients \
  -H "Origin: capacitor://localhost" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization"
```
Expect `HTTP/2 200`, `access-control-allow-origin: capacitor://localhost`, `access-control-allow-headers: authorization,content-type`, `vary: origin`, and **no** `access-control-allow-credentials`. Repeat with `Origin: https://localhost`. Then confirm a browser request with no `Origin` header still works (the web PWA must be untouched).

**Deploy caveat:** this is a Rust change and needs the release rebuild + `systemctl restart ecliptr`. Per 0.1 the current workflow does that on push. If the "never deploy plaid.rs" rule is still live, this cannot go through that workflow and Jack must say what replaces it.

### 3.2 Client change — `C:/Users/Jack/Desktop/clienthub-api/www/app.js`

All of it guarded so the browser PWA keeps using the cookie and behaves identically. Add near the top of the IIFE, above `const FETCH_TIMEOUT = 15000;` (`:154`):

```js
  const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform
                       && window.Capacitor.isNativePlatform());
  const API_BASE  = IS_NATIVE ? 'https://m.ecliptr.app' : '';
  let   _token    = null;            // native only; loaded from secure storage at boot

  const apiUrl = u => (typeof u === 'string' && u.charAt(0) === '/') ? API_BASE + u : u;
  const authOpts = (o = {}) => IS_NATIVE
    ? { ...o, headers: { ...(o.headers || {}), ...(_token ? { Authorization: 'Bearer ' + _token } : {}) } }
    : { ...o, credentials: 'include' };
```

Then rewrite the five `api` methods (`:162-201`) to route through both helpers, and add a single refresh-once-on-401. Sketch for `get`; the other four follow the same shape:

```js
    async get(url) {
      let r = await fetchWithTimeout(apiUrl(url), authOpts());
      if (r.status === 401 && IS_NATIVE && await tryRefresh()) {
        r = await fetchWithTimeout(apiUrl(url), authOpts());
      }
      if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
      if (r.status === 403) throw new Error('forbidden');
      return r.json();
    },
```

```js
  async function tryRefresh() {
    if (!_token) return false;
    try {
      const r = await fetchWithTimeout(apiUrl('/api/auth/employee/refresh'),
        { method: 'POST', headers: { Authorization: 'Bearer ' + _token } });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.token) { await setToken(d.token); return true; }
    } catch (_) {}
    await setToken(null);
    return false;
  }
```

**Six call sites bypass the helper and must each be fixed individually:**

| `www/app.js` | Today | Change |
|---|---|---|
| `:666` | login `fetchWithTimeout('/api/auth/employee/login', …credentials)` | `apiUrl(...)`; on success **store `data.token`** into secure storage. Replace `location.reload()` at `:678` with `await setToken(data.token); checkAuth();` — a reload of a bundled `index.html` re-runs boot with no cookie to find |
| `:1629` | `fetch('/api/account', {method:'DELETE'})`, no credentials at all | route through `api.del('/api/account')`. **This is the Guideline 5.1.1(v) path — it is the first thing that silently breaks and the first thing a reviewer tests** |
| `:4469` | `window.open('/api/invoices/' + id + '/pdf', '_blank')` | `window.open` carries no `Authorization` header, so under the shell this opens the system browser with no session and renders a 401 blank page. Needs `fetch` → `blob` → `@capacitor/filesystem` write to `Directory.Cache` → `@capacitor/share` or `FileOpener`. A URL rewrite alone does not fix this |
| `:6818` | `DELETE /api/email/schedules/…` bare fetch | route through `api.del` |
| `:204-210` | `ensureSpace` loads `'/space.js?v=3'` | leave as-is — `space.js` is in the bundle allowlist, so the absolute path resolves locally and correctly |
| `:1238` | `<a class="list-item" href="/guide" target="_blank">Setup guides</a>` | remove on native (section 6.2). It is also the `/guide → /#pricing → $39/$99` chain |
| `:2609` | `const mediaUrl = p => … ? '/' + p : null` | **hoist out of `renderInventory` to module scope and prefix with `API_BASE`.** Without this, every lot photo resolves into the bundle and 404s — the flagship camera feature appears not to work the moment you take a picture |

**The security tradeoff, stated so Jack can veto it:** today the token is `HttpOnly` and unreachable from JavaScript, so an XSS cannot exfiltrate the session. Bearer puts a 7-day token (`JWT_EXPIRY_SECS`, `src/employees.rs:36`; 30-day refresh grace; 90-day cap) into JS reach. This is the standard, unavoidable tradeoff for a native shell — cookie auth from a `capacitor://` origin is blocked by WKWebView's ITP even with `SameSite=None; Secure`. It is also exactly why the token goes in the Keychain and not `localStorage` (section 4.2).

---

## 4. Native capabilities

Build order: **camera → biometric → offline → (deep links → push)**. Camera first because it is the only one a reviewer can watch happen in ninety seconds. Push last because it is the only one with server risk.

### 4.0 Install (all of it, once)

```bash
cd C:/Users/Jack/Desktop/ecliptr-mobile
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/app @capacitor/browser \
      @capacitor/camera @capacitor/filesystem @capacitor/share \
      @capacitor/push-notifications @capacitor/status-bar @capacitor/splash-screen \
      @capacitor/haptics
npm i @aparajita/capacitor-biometric-auth @aparajita/capacitor-secure-storage
npm i -D @capacitor/assets
npx cap init Ecliptr app.ecliptr.mobile --web-dir=www-bundle
node scripts/sync-web.mjs
npx cap add android          # works on Windows
npx cap add ios              # requires macOS + Xcode + CocoaPods
```

`npx cap add ios` and everything downstream of it **cannot be done or verified from this Windows machine.** Section 7 says exactly which steps that covers.

---

### 4.1 Camera capture → lot photos (flagship)

**Plugin:** `@capacitor/camera` (+ `@capacitor/filesystem` to read the captured file). **Zero server changes** — `POST /api/inventory/:id/photo/:name` is live (`src/routes/inventory.rs:34`) and `PUT /api/inventory/:id` already accepts `photos: Option<Vec<String>>`.

**iOS `Info.plist`** (`ecliptr-mobile/ios/App/App/Info.plist`) — exact strings, sentence case:

```xml
<key>NSCameraUsageDescription</key>
<string>Ecliptr uses the camera to photograph inventory lots and pallets so buyers can see what you are selling.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>Ecliptr accesses your photo library so you can attach existing lot photos and set your profile picture.</string>
```

Omit `NSPhotoLibraryAddUsageDescription` — nothing is written back to the camera roll. Vague purpose strings are a known rejection cause; keep these.

**Android `AndroidManifest.xml`:**

```xml
<uses-permission android:name="android.permission.CAMERA"/>
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES"/>
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32"/>
```

Verify the `FileProvider` `<provider>` block and `res/xml/file_paths.xml` survived from the Capacitor template — the plugin returns a `content://` URI and fails silently without them.

**Hook points in `www/app.js`:** lot detail footer `:2698-2706` (primary "Add photo" button), photo strip `:2665` (currently renders `allPhotos[0]` only), lot form `:3771` / `:3820` (create path), `mediaUrl` `:2609` (hoist + `API_BASE`).

**Sketch:**

```js
  async function capturePhotoForLot(lotId, lot) {
    const { Camera, CameraSource, CameraResultType } = window.Capacitor.Plugins;
    const shot = await Camera.getPhoto({ source: CameraSource.Prompt,
      resultType: CameraResultType.Uri, quality: 70, width: 2000, correctOrientation: true });
    const blob = await (await fetch(shot.webPath)).blob();

    // UUID filename: the v0.15.112 root cause was reusing photo_00N after a delete,
    // so the webview served the cached previous image. 41 chars, passes the server's
    // <=128 [A-Za-z0-9._-] filter.
    const name = crypto.randomUUID() + '.jpg';

    // RAW BYTES, not FormData. The route takes `body: Bytes` and magic-byte checks
    // it; a multipart body fails the check with 400 "only PNG, JPEG, or WEBP images".
    const up = await fetchWithTimeout(apiUrl(`/api/inventory/${lotId}/photo/${name}`),
      authOpts({ method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob }), 60000);
    if (!up.ok) { toast('Photo did not upload', true); return; }

    // MERGE-ON-WRITE. PUT /api/inventory/:id replaces photos_json wholesale
    // (src/routes/inventory.rs:348-357). Sending only the new photo deletes every
    // existing photo on the lot. This is the standing parity-audit rule.
    let existing = []; try { existing = JSON.parse(lot.photos_json || '[]'); } catch (_) {}
    await api.put(`/api/inventory/${lotId}`,
      { photos: existing.concat(`media/inventory/${lotId}/photos/${name}`) });
  }
```

Create path: photos cannot be attached before the lot exists (`inventory_in_org` gate). Hold captures in memory → `POST /api/inventory` (returns `{ok:true,id}`, `inventory.rs:203`) → upload → PUT. Partial failure is possible (lot saved, photo not) and the UI must say so rather than reporting success.

**Effort:** M. ~250 lines of `app.js`, one plugin, two plist keys, zero server work.

---

### 4.2 Biometric app lock (best credibility per hour in the whole project)

**Plugins:** `@aparajita/capacitor-biometric-auth` + `@aparajita/capacitor-secure-storage`.

**Correction to the plan, which matters:** it directs storing the bearer token in `@capacitor/preferences`. That is `UserDefaults` on iOS — not the Keychain, not encrypted, and included in unencrypted local backups. For a tool holding client financials and bank transactions that is wrong. Use the Keychain-backed plugin (Keychain on iOS, `EncryptedSharedPreferences` on Android) with accessibility `afterFirstUnlockThisDeviceOnly`, so the token never rides an iCloud backup to a different device. Do not use `@capacitor-community/native-biometric` — stale against Capacitor 7.

**iOS `Info.plist`** — **mandatory**; without it the app *crashes* the first time Face ID is invoked, and a reviewer-reproducible crash is an automatic rejection:

```xml
<key>NSFaceIDUsageDescription</key>
<string>Ecliptr uses Face ID to unlock your workspace, so your client and financial data stays private even if your phone is already unlocked.</string>
```

**Android:** `<uses-permission android:name="android.permission.USE_BIOMETRIC"/>`, and set `minSdkVersion 26` in `android/variables.gradle` (Capacitor 7 defaults to 23; 23–27 would drag in the deprecated `FingerprintManager` branch for no real-world gain in 2026).

**Privacy manifest: nothing. Nutrition label: nothing.** Matching happens in the Secure Enclave; no biometric data reaches the app or the server. Do not declare biometric data collection — over-declaring creates a label you cannot justify.

**Hook points:** boot / `showLogin` `:212`, the `/api/auth/employee/me` check `:635`, plus a new `App.addListener('appStateChange')` for re-lock, plus one Settings row.

**Sketch:**

```js
  async function nativeBoot() {
    _token = await getToken();                    // Keychain / EncryptedSharedPreferences
    if (!_token) return showLogin();
    if (await lockEnabled()) {
      const ok = await BiometricAuth.authenticate({
        reason: 'Unlock Ecliptr', cancelTitle: 'Cancel',
        allowDeviceCredential: true, iosFallbackTitle: 'Use passcode' });
      if (!ok) return showLockedScreen();         // never fall through into the app
    }
    checkAuth();
  }
  App.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) _bgAt = Date.now();
    else if (_bgAt && Date.now() - _bgAt > LOCK_AFTER_MS) nativeBoot();
  });
```

**Ship the lock and a longer session together.** A biometric gate on resume is what makes it safe to lengthen `JWT_EXPIRY_SECS`; shipping the lock alone is pure added friction on a session that still expires mid-warehouse.

**Effort:** S. ~80 lines, two plugins, one plist key.

---

### 4.3 Offline read cache

**Plugin:** `@capacitor/filesystem`, JSON snapshots in `Directory.Data`. Not Preferences (that is `UserDefaults`, wrong shape for hundreds of KB). Not `@capacitor-community/sqlite` — a second database on phones is precisely the divergence the parity audit exists to kill.

**Scope for v1: READ ONLY. No write queue.** Hard line. A write queue multiplies any save-corruption bug by every queued write, and the merge-on-write P0s in `C:/Users/Jack/Desktop/BUSINESS APP/PARITY-AUDIT-2026-07-26.md` are still open.

**Cache exactly four endpoints:** `/api/clients`, `/api/inventory`, `/api/invoices`, `/api/deal-flows`. Every cached money figure renders with a visible "as of 14:32" stamp and is never presented as live.

**Prerequisite:** the boot-cached globals `_clients` / `_suppliers` / `_payoutRecipients` (`www/app.js:101-105`) are already a stale-data source — the root cause behind "mobile stale data" in the deploy-23 notes. Fix that first, or you will have two stale layers arguing.

**Permissions: none on either platform.** `Directory.Data` is app-private scoped storage. Do **not** add `MANAGE_EXTERNAL_STORAGE`; Play flags it and it is unnecessary.

**Hook point:** `api.get` (`:163-168`) is the single choke point. Sketch:

```js
    async get(url) {
      const key = CACHEABLE[url];                        // the four list endpoints only
      try {
        const r = await fetchWithTimeout(apiUrl(url), authOpts());
        ...
        const data = await r.json();
        if (key && IS_NATIVE) await snapshotWrite(key, { data, fetchedAt: Date.now() });
        return data;
      } catch (e) {
        if (key && IS_NATIVE) {
          const snap = await snapshotRead(key);
          if (snap) { setStaleStamp(snap.fetchedAt); return snap.data; }
        }
        throw e;
      }
    },
```

Also: `FETCH_TIMEOUT` is 15s (`:156`), so on one bar of signal the user gets fifteen seconds of blank screen today. Cache-first-then-revalidate on those four turns that into an instant paint. `setContent` (`:240`) renders the "as of" bar; the offline banner (`:358-364`) changes from "you are offline" to "showing data from 14:32".

**Privacy manifest — this is where the required-reason declarations come from:** `NSPrivacyAccessedAPICategoryFileTimestamp` reason `C617.1`, `NSPrivacyAccessedAPICategoryUserDefaults` reason `CA92.1`, and `NSPrivacyAccessedAPICategoryDiskSpace` `E174.1` **only if** you check free space before writing. The `UserDefaults` declaration is required because **Capacitor core and the Preferences plugin use `UserDefaults` directly** — not, as the plan states, because of `localStorage`; `localStorage` in a `WKWebView` is WebKit's own store. Same outcome, but the manifest is machine-checked at upload and should be right for the right reason.

Also: exclude the cache directory from iCloud backup (`NSURLIsExcludedFromBackupKey`) and wipe it on both logout and account deletion (section 6.4).

**Effort:** M–L. ~200 lines plus the staleness UI, plus the globals fix as a hard prerequisite. The risk is not the code — it is showing a stale number as if it were live.

---

### 4.4 Push notifications (last, and the trigger list in the plan is wrong)

**Plugins:** `@capacitor/push-notifications` + `@capacitor/app`.

**The correction that matters:** the plan proposes *invoice paid, approval pending, refund recorded*. **Two of those three are not server-originated events.** `mark_invoice_paid` (`src/routes/invoices.rs:447`) and the refund paths are user actions performed from a device and synced through the oplog — a push there tells Jack about something he did thirty seconds ago on the machine in front of him. That is the notification people disable in week one.

**Verified server-originated triggers:**

| Event | Origin | Note |
|---|---|---|
| Buyer submits a storefront offer | `src/routes/storefront.rs:306`, public unauthenticated POST | The best trigger in the product. **But `www/app.js` has zero references to `offers`** — the push would land on a screen that does not exist. Build the mobile offer surface with the push |
| New pending approval | `src/routes/approvals.rs`, fed by signup / intake / forms / Shopify | In-app half already exists (bell, `/api/approvals/count`) |
| Stale-listing renewal request | `src/scheduler.rs:46` `flag_stale_listings`, 60s tick | Free |
| Newsletter job finished or failed | `src/scheduler.rs:319` | Closes the "sent 30 then stopped" loop |
| Sync push dead-lettered | v0.15.92 | A device that quietly stops syncing is invisible today |

**Server work, honestly:** `device_tokens` table + register/unregister (~80 lines); APNs sender (ES256 JWT via `jsonwebtoken`, already a dep) ~150 lines; FCM sender for Android (HTTP v1, service-account JWT → OAuth2 → POST), roughly doubling that; trigger wiring; retry + token invalidation on APNs 410 `Unregistered`.

**Blocker to budget for:** `Cargo.toml:28` is `reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }` and `Cargo.lock` contains **no `h2` crate** — HTTP/2 is not compiled in. **APNs is HTTP/2-only.** The fix is adding `"http2"` to the feature list: one line, but it pulls in the `h2` tree and forces a full server rebuild that touches every existing `reqwest` call site (Plaid, Facebook, Shopify, `bank_backup`). Given 0.1, agree the deploy mechanism before doing this.

**iOS:** no `Info.plist` string (permission goes through `UNUserNotificationCenter`). App ID capability **Push Notifications**; entitlement `aps-environment`. Token-based auth key (`.p8` + Team ID + Key ID), not certificates. **Do not add `UIBackgroundModes: [remote-notification]`** unless you send silent pushes — you do not need them for v1 and declaring it invites questions about what you do in the background.

**Android:** `<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>` (API 33+ runtime prompt), plus `google-services.json`, the `com.google.gms.google-services` Gradle plugin, and the plugin's `FirebaseMessagingService` entry.

**Hard dependency:** a push tap must open a specific screen, and `www/app.js` has **zero** uses of `pushState` / `popstate` / `hashchange` in 7,057 lines. Until a navigation stack exists, a tapped push can only dump the user on Home, which is worse than no push. **Do not start push before the navigation stack lands.**

Show a pre-permission screen before calling `requestPermissions()`, and the app must stay fully functional when permission is denied.

**Effort:** L. Client ~120 lines; server ~250 plus the `http2` rebuild plus a second sender.

---

### 4.5 Deep / universal links (infrastructure, not a 4.2 defense)

**Plugin:** none beyond `@capacitor/app` (`appUrlOpen`).

**Server:** serve two static files with correct `Content-Type` and no redirect — `https://ecliptr.app/.well-known/apple-app-site-association` (JSON, `application/json`, **no `.json` extension**) and `https://ecliptr.app/.well-known/assetlinks.json`. Both need the Apple Team ID and the final bundle ID, so they come after enrollment. In `src/main.rs` these need explicit routes; the `ServeDir` fallback will not set the right content type for an extensionless file.

**iOS:** Associated Domains entitlement `applinks:ecliptr.app`. **Android:** `<intent-filter android:autoVerify="true">`.

**Targets:** storefront `/i/:token`, client portal, invoice links, `/reset`, team invite links (`www/app.js:894`).

**Effort:** S–M client, S server. Blocked on enrollment and on the navigation stack.

---

### 4.6 Service worker — do not register it in the shell

`www/index.html:52` registers `/sw.js` unconditionally, and `:78-80` reloads the page on `controllerchange`. Inside a native app that is a visible hard reload with no purpose; on `capacitor://` iOS the registration simply fails. One edit, keeping a single `index.html` for both targets:

```js
  if ('serviceWorker' in navigator &&
      !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {
    /* existing registration block, unchanged */
  } else if ('serviceWorker' in navigator) {
    // Native: unregister anything a prior PWA install left behind, so a stale SW
    // cannot serve stale files into the shell.
    navigator.serviceWorker.getRegistrations()
      .then(rs => rs.forEach(r => r.unregister())).catch(() => {});
  }
```

`www/sw.js` itself stays untouched for the web PWA. (Separately, and outside this spec: its `SHELL = ['/', …]` and offline fallback `caches.match('/')` serve `landing.html` on any non-`m.` host per `root_handler` at `src/main.rs:413-423` — both should be `/app`. Phase 1 web work, not shell work.)

### 4.7 Haptics — take it, do not count it

`@capacitor/haptics`, ~20 lines, pairs with the "make every row press" work. A reviewer cannot distinguish it from nothing, so it is polish, not a 4.2 argument.

### 4.8 Rejected

**Share-sheet target** — a real iOS Share Extension is a separate binary target, App Group, and provisioning profile, with no official Capacitor plugin; reviewers rarely test it; and the manifest analyzer is deliberately desktop-only so the phone would receive a spreadsheet it cannot use. **Cheaper 80% substitute held in reserve:** register a document type handler (`CFBundleDocumentTypes` + `LSSupportsOpeningDocumentsInPlace` + `UTImportedTypeDeclarations`), Info.plist-only, files arrive through the same `appUrlOpen` listener, and POST to `POST /api/inventory/:id/manifest/:name` which already exists (`src/routes/inventory.rs:33`). Excellent "one more thing" if a reviewer pushes back on 4.2.

**Barcode scanning** — genuinely strong 4.2 material, but there is **no SKU, UPC or barcode field anywhere in the inventory schema** (`InventoryInput` / `InventoryUpdate`, `src/routes/inventory.rs:225-275`). A scanner would have nothing to match against. Add the field first; v1.1.

**Home-screen widget, geolocation, contacts import** — rejected: a separate Swift target, a Precise Location label for zero value, and a Contacts label users decline, respectively.

---

## 5. Icons and splash

**Source asset:** `C:/Users/Jack/Desktop/clienthub-api/www/ecliptr-mark.svg` (vector, 1,385 bytes). Render it at 1024 rather than upscaling `icon-512.png`. The repo already has the tooling — `@resvg/resvg-js` is in `clienthub-api/package.json` and `gen_icons.py` exists.

**Two live defects in the existing assets, both pre-existing:**
- `www/icon-maskable-512.png` is **byte-identical** to `icon-512.png` (both 138,942 bytes) but is declared `"purpose": "maskable"` in `manifest.json:16`. It has no safe-zone padding, so Android is cropping the mark on the installed PWA today, and the same source would crop the adaptive icon. **The missing ~20% padding must be added when generating `icon-foreground.png`.**
- `manifest.json:6` has `start_url: "/"`, which on the non-`m.` host serves `landing.html` (`src/main.rs:413-423`). Should be `/app`. Web-PWA fix, not shell.

**Sources to author in `ecliptr-mobile/assets/`:**

| File | Size | Requirements |
|---|---|---|
| `icon.png` | 1024×1024 | **No alpha channel, no transparency, no pre-rounded corners** — Apple applies the mask and rejects alpha. Flatten the mark onto solid `#0D0A09`. Verify: `magick identify -format "%[channels]" icon.png` must not report `rgba` |
| `icon-foreground.png` | 1024×1024 | Alpha. Mark occupying ~60% of the canvas — the Android adaptive canvas is 108dp with only the centre 72dp guaranteed visible |
| `icon-background.png` | 1024×1024 | Solid `#0D0A09` |
| `icon-monochrome.png` | 1024×1024 | Optional; single-colour silhouette for Android 13+ themed icons. Conspicuous by absence on modern launchers |
| `splash.png` | 2732×2732 | Mark centred in the middle ~30%; background `#0D0A09` |
| `splash-dark.png` | 2732×2732 | Same, or identical if the brand is dark-only |

**Generate:**

```bash
cd C:/Users/Jack/Desktop/ecliptr-mobile
npx @capacitor/assets generate --iconBackgroundColor '#0D0A09' \
    --iconBackgroundColorDark '#0D0A09' \
    --splashBackgroundColor '#0D0A09' --splashBackgroundColorDark '#0D0A09'
```

This writes the iOS `AppIcon` set (Xcode 15+ takes the single 1024), the Android mipmaps and adaptive layers, and the splash resources. **The Android half runs on Windows. The iOS half needs the `ios/` platform to exist, which needs macOS.**

**iOS launch screen must be a storyboard** — static launch PNGs have been rejected since iOS 14. Capacitor scaffolds `LaunchScreen.storyboard`; set its background to `#0D0A09` so first paint does not flash white against the app's dark shell.

**Store listing assets (separate from the app):**
- App Store: 1024×1024 icon (no alpha), plus screenshots for 6.7" and 6.5" iPhone at minimum.
- Play: 512×512 32-bit PNG icon (**with** alpha, unlike Apple's), 1024×500 feature graphic, and at least two phone screenshots.
- Android notification icon (once push ships): white-on-transparent silhouette. A colour icon renders as a white square.

`www/manifest.json` becomes inert inside the shell — no install prompt, and `orientation: portrait` does not govern. Orientation moves to `UISupportedInterfaceOrientations` (Info.plist) and `android:screenOrientation` (AndroidManifest). Keep serving the manifest unchanged for the web PWA.

---

## 6. Compliance fixes

### 6.1 Server strings — three one-line edits, deploy instantly, no app release

These **cannot** be gated client-side; they are toasted verbatim from server responses. `src/routes/inventory.rs:169` is reachable by a reviewer on the demo account **today** and is the single most probable way to fail 3.1.1.

| File:line | Today | Change to |
|---|---|---|
| `src/routes/inventory.rs:169` | `"You've reached your plan's limit of {} inventory items. Upgrade to add more."` | `"You've reached the limit of {} inventory items for this workspace."` |
| `src/routes/clients.rs:162` | `"…100-client limit on the Free plan. Paid plans with unlimited clients are coming soon."` | `"You've reached the 100-client limit for this workspace."` |
| `src/employees.rs:2167` | `"…team-member limit for the Free plan. Paid plans with more seats are coming soon."` | `"You've reached the team-member limit for this workspace."` |

Also raise the demo org's 10-item inventory cap (`src/employees.rs:764-766`) so a reviewer poking at Inventory — the tab you are promoting for the 4.2 defense — does not hit a limit at all.

### 6.2 Purchase surfaces to hide on native

One constant, no fork of `app.js` (a fork guarantees drift against the PWA). Using `IS_NATIVE` from section 3.2:

| `www/app.js` | Content | Action |
|---|---|---|
| `:6397` | "Paid plans with more storage and seats are coming soon." | **Remove entirely, both platforms.** Textbook 3.1.1 upsell copy, and "coming soon" separately trips 2.2 |
| `:6393` | `<div class="section-title">Your plan</div>` | Retitle to "Workspace" on native |
| `:6395` | renders `Free plan` / `Founder plan` / `Business plan` | Safe once `:6397` is gone (reflecting entitlement is allowed). Simplest: on native, render only the usage line |
| `:6396` | `Team members: n/limit · Clients: n/limit` | Safe. Keep |
| `:1187` | "Share your link — earn Business for life" | Hidden with the referrals row |
| `:1291`, `:1297`, `:1308`, `:1293` | Refer & earn screen: names the Business plan three times, and links `{base}/register?ref={code}` | **Hide the whole screen on native.** Drop `referrals` from the Utility group and from `TAB_PERM` |
| `:1238` | `<a href="/guide" target="_blank">Setup guides</a>` | **Remove on native.** `/guide` → `guide.html:84` `/#pricing` → `landing.html:662-715` `$39` / `$99` / "Start free, upgrade in-app". Two taps from inside the app to a price list |
| `:225-231` | five welcome-tour steps linking `/guide`, `/guide#inbox`, `/guide#import`, `/guide#sheets` | **Remove on native.** This auto-opens on first launch — the exact flow a reviewer sees |
| `www/index.html:101` | `<a href="https://ecliptr.app/register" target="_blank">Create a workspace</a>` | **Remove on native.** `register.html` has no prices, so it is not strictly 3.1.1, but it is an outbound link on the first screen a reviewer sees, into a site whose nav exposes Pricing. Replace with plain text: "Ask your workspace admin to invite you." |

**Explicitly safe, and say so in the review notes:** Settings → Payment methods (`:6448-6453`) and the mark-paid modal (`:4664-4691`) hold the *operator's own* bank/wire/Zelle labels that print on invoices to their wholesale buyers. Physical goods delivered outside the app are excluded from IAP under 3.1.3(e) / 3.1.5(a).

**Off-app but change with it:** `www/landing.html:694` says "Start free, upgrade in-app →". That asserts an in-app purchase path exists, contradicting the zero-purchase-surface position if a reviewer opens the site — which they routinely do for account-based apps. Change to "Start free, upgrade on the web →".

### 6.3 Account deletion — Settings → Data & safety

Four rows, each opening a full screen, nothing destructive inline. This replaces the current button at `www/app.js:1602`.

1. **Export my data** (admin only) → `GET /api/account/export` (exists, `src/employees.rs:2458`, routed `:2671`, no UI today) → share sheet with `ecliptr-export-<org>-<date>.json`. Subtitle: "A JSON copy of everything in this workspace." Free credibility on both privacy forms.
2. **Sign out** — moves here. And it must now **wipe local state**: `doLogout()` (`:1722-1726`) currently clears `window.ME` and nothing else. It must delete the Keychain token and the offline snapshots. With a stored Bearer token, not doing this is a real credential leak on a shared phone.
3. **Delete my account** — **always visible, never disabled.** A bottom sheet, not `confirm()`:
   - Title: "Delete your account"
   - Body: "Your Ecliptr login, profile and rep assignments are deleted immediately and you are signed out. Records you created for **{org_name}** — clients, invoices and deals — stay with the workspace. To delete those too, delete the workspace."
   - Require typing `DELETE`.
   - Call `api.del('/api/account')` — through the helper, with `API_BASE` and Bearer (this is the B4 fix from section 3.2).
   - On success: clear the Keychain token, wipe the offline cache, hard-reset to the login view.
   - **On the only-admin 400 (`src/employees.rs:2291-2296`), do not show a dead end.** This is the blocker: a sole admin — which includes the demo workspace and most real customers — currently taps Delete and gets an error telling them to go do something else, which is exactly what Apple rejects. Replace the error with a branch sheet offering (i) "Delete the whole workspace instead" → row 4, or (ii) "Make someone else an admin first" → deep-link into Team with the role picker open. Both complete inside the app. **Client-side only; no server change.**
4. **Delete workspace** (admin only) — closes the gap that `POST /api/account/delete-workspace` (`src/employees.rs:2388-2427`, password-confirmed, calls `purge_org_data` across 26 tables) has **zero** references anywhere in `www/`. Sheet: the full list of what is purged, "This cannot be undone and affects **{member_count}** people", type the workspace name, then a password field. Note `org_default` returns 403 (`:2397`) — catch it and show "This workspace can't be deleted from the app. Contact support." rather than the raw error. (This means Jack's own workspace will always hit the only-admin branch. Irrelevant to review, relevant to him.)

Sizing: ~180 lines in `app.js`, one new settings group, no server change.

Also add, in the same group: **Privacy policy** and **Terms** rows opening the bundled `privacy.html` / `terms.html`. Today **no privacy or terms link exists anywhere in `www/app.js`** — both stores require one.

### 6.4 Two static pages and two routes on the server

- **`www/delete-account.html`**, served at `/delete-account`. **Google Play requires a publicly reachable account-deletion URL in the Data Safety form, in addition to in-app deletion.** Ecliptr has none. The page explains the in-app path and gives an email request route for users who cannot sign in.
- **Explicit `/privacy` and `/terms` routes** in `src/main.rs` alongside `/guide` (`:154`). Today `privacy.html` is reachable only through the `ServeDir` fallback as `https://ecliptr.app/privacy.html`; both stores want stable URLs.

### 6.5 `PrivacyInfo.xcprivacy` — a hard upload gate, not a review round

Missing this means App Store Connect rejects the **upload**, before a human looks. Place at `ecliptr-mobile/ios/App/App/PrivacyInfo.xcprivacy` and add it to the app target. Every Capacitor plugin must carry its own manifest too — check after `cap sync`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSPrivacyTracking</key><false/>
  <key>NSPrivacyTrackingDomains</key><array/>

  <key>NSPrivacyCollectedDataTypes</key>
  <array>
    <dict>
      <key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeName</string>
      <key>NSPrivacyCollectedDataTypeLinked</key><true/>
      <key>NSPrivacyCollectedDataTypeTracking</key><false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <!-- repeat the same four keys for: EmailAddress, PhoneNumber, PhysicalAddress,
         UserID, OtherFinancialInfo, PhotosorVideos, EmailsorTextMessages,
         OtherUserContent, OtherDataTypes, and DeviceID (only once push ships) -->
  </array>

  <key>NSPrivacyAccessedAPITypes</key>
  <array>
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
      <key>NSPrivacyAccessedAPITypeReasons</key><array><string>CA92.1</string></array>
    </dict>
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
      <key>NSPrivacyAccessedAPITypeReasons</key><array><string>C617.1</string></array>
    </dict>
    <!-- DiskSpace / E174.1 ONLY if the offline cache checks free space before writing -->
  </array>
</dict>
</plist>
```

### 6.6 The privacy answers

**Apple nutrition label** — every row: Collected · Linked to the user · **Not** used for tracking · Purpose: **App Functionality** only. No Analytics, no Product Personalization.

| Category | Declare | Contents |
|---|---|---|
| Contact Info — Name, Email, Phone, Physical Address | Yes | user profile + every client and supplier record |
| User Content — Other User Content, Photos or Videos, Emails or Text Messages | Yes | notes, interactions, lot photos, avatar, newsletter bodies |
| Identifiers — User ID | Yes | account id, org id |
| Identifiers — Device ID | **Only when push ships** | APNs/FCM token. Most commonly forgotten; declare it the moment push ships, or the label stops matching the binary |
| Financial Info — Other Financial Info | Yes | invoices, payments, payouts, margins. **Not** "Payment Info" — no card or bank-account number is ever entered in the app |
| Other Data | Yes | SMTP app password, company tax ID |
| Usage Data, Diagnostics, Location, Contacts, Health, Search History, Purchases, Sensitive Info | **No** | verified absent |

Contacts is No because clients are typed, not read from the device address book. If a contacts picker is ever added, this flips and the label must be updated before that build ships.

**Google Play Data Safety:** Personal info (Name, Email, Phone, Address, User IDs) → collected, **not shared**, required, App functionality + Account management. Financial info → "Other financial info", collected, not shared. Photos and videos → Photos, collected. Messages → "Other in-app messages", collected. App activity / App info and performance → **No**. Security: encrypted in transit **yes** (HTTPS + HSTS, `src/main.rs:199-202`); users can request deletion **yes**; data can be deleted **yes**. Plus the account-deletion URL from 6.4.

**Do not add an analytics or crash SDK before first submission.** Grep confirms zero third-party SDKs in `www/` — no posthog, sentry, gtag, mixpanel, firebase, segment. Both forms can honestly say "no data shared with third parties" and "Data used to track you: No". Adding one changes both labels and adds required-reason declarations.

Also set `ITSAppUsesNonExemptEncryption = false` in `Info.plist` — HTTPS only, no proprietary crypto. Without it, **every** upload prompts for export-compliance answers.

### 6.7 Quality items a reviewer will notice

- **24 `confirm()` and one `prompt()`** render as `capacitor://localhost says…` system dialogs. `www/app.js:3711` is a `prompt()` for the credit-limit field — the single most website-looking element in the product. Two sit on screens a reviewer is guaranteed to visit: `:1627` (delete account) and `:1723` (sign out). A correct bottom sheet already exists in the codebase and is used in one place.
- **Orphan screens with no way back:** Approvals, Checkup, **My account** (the delete-account screen), Payout config, Team member profile, Categories are rendered via `setContent()` with no tab assignment. A pull-to-refresh ejects you. A reviewer who lands in My account and cannot get out reads the app as unfinished. The navigation stack is not optional before submission — and push tap-routing is blocked on it too.
- **Stale build string** `m20 · 2026-07-05` at `www/app.js:76`, rendered in Settings at `:6455`, while the product is at v0.15.122. Wire it to `window.__ECLIPTR_BUILD__` (section 1.4).
- **Placeholder copy** `https://yoursite.com/thank-you` (`:2298`) and `yoursite.com/contact` (`:2307`) are deliberate instructional mockups; rename to `yourcompany.com` so a skimming reviewer does not read them as unfinished.
- **Keep "beta", "trial", "coming soon" and "test" out of the App Store description, subtitle, screenshots and What's New.** The word "beta" appears only in `landing.html:668` and `terms.html:63`, which is fine — Apple objects to it in the app and its metadata.
- **PASS, no work needed:** Sign in with Apple is not required (4.8) — email/password only, no third-party OAuth login.

### 6.8 The demo account

`DEMO_ORG_ID = "org_8903289cfd67492595c13868929ea789"` (`src/scheduler.rs:10-15`). Newsletter and email sends are simulated for this org and never delivered (`scheduler.rs:396-397, 507-521`; `newsletters.rs:317-318`) — a reviewer can press Send safely. Four things to settle:

1. Confirm or reset the password; make it stable and non-expiring; check the login rate limiter (`src/employees.rs:1311-1347`, 5 attempts) will not lock a reviewer out after a typo.
2. Raise the demo inventory cap (6.1).
3. **The demo account must survive being deleted.** The reviewer *will* test 5.1.1(v). Seed the demo org with **two** admins and hand over the non-sole one so deletion genuinely completes, then re-seed between rounds. Alternative: mint a fresh disposable reviewer account per submission. **Decide before writing the review notes.**
4. Consider a read-only demo role — a demo admin can currently type into the SMTP fields (`www/app.js:6370-6371`). Harmless but untidy.

### 6.9 The 4.2 paragraph for the review notes

Draft this before submitting; a prepared, specific answer usually resolves a 4.2 question in one round. Every clause is a shipped capability, and every one is demonstrable in the demo workspace within two minutes.

> Ecliptr is a field tool for wholesale liquidation brokers who work in warehouses, on loading docks, and in trucks. The app uses the device camera to photograph pallets and truckloads directly into an inventory record at the point of intake — the core workflow, and one that cannot be done from a desk. It keeps an encrypted on-device cache so clients, inventory, invoices and deals are readable in warehouses with no cellular signal, with every figure timestamped so cached money is never shown as live. It requires Face ID to unlock, because it holds client financial records and bank transaction data. It receives push notifications when a buyer submits an offer on a listing, when a new client signs up and needs approval, and when a listing goes stale — events that happen while the user is away from any computer. Account deletion is available in-app under Settings → Data and safety and permanently deletes the account and its data.

Plus, in the notes: the demo credentials; "Ecliptr is free during beta, there is nothing to purchase in this app and no purchase surface anywhere in it"; the Payment methods explanation from 6.2; the literal tap path to account deletion; and what triggers each permission prompt.

---

## 7. Build and release

### 7.1 What can be done from this Windows machine, and what cannot

**Can, today, with no Apple account:** create `ecliptr-mobile/`, write `capacitor.config.ts`, write both scripts, run `cap init`, run `cap add android`, generate all Android icons and splashes, build and run a debug Android APK on a device or emulator, and **verify the entire section 3 auth change end to end** (CORS preflight via `curl`, then Bearer login inside the Android webview). All the risky plumbing is provable on Android without Apple.

**Cannot, from Windows, ever:** `npx cap add ios`, CocoaPods, opening `App.xcworkspace`, the iOS simulator, `xcodebuild archive`, code signing, TestFlight upload, and any verification of `Info.plist` strings, the launch storyboard, `PrivacyInfo.xcprivacy` acceptance, Face ID, or APNs. **Every iOS step below requires a Mac with Xcode.** The plan says CI already runs on Mac machines; if that is a GitHub-hosted macOS runner it can do the archive and upload, but the first `cap add ios` and the signing setup are far easier done once on a real Mac.

### 7.2 Day-to-day

```bash
cd C:/Users/Jack/Desktop/ecliptr-mobile
node scripts/sync-web.mjs        # www/ → www-bundle/, filtered
node scripts/check-bundle.mjs    # compliance gate; non-zero exit blocks the build
npx cap sync                     # copies www-bundle into both platforms + updates plugins
npx cap open android             # Android Studio
npx cap open ios                 # Xcode (macOS only)
```

Live reload while iterating (development only — `server.url` must never reach an archive):

```bash
npx cap run android --live-reload --host <your LAN IP>
```

### 7.3 iOS release (macOS only)

1. Enroll in the Apple Developer Program. Register the App ID `app.ecliptr.mobile` with capabilities **Push Notifications** and **Associated Domains**.
2. Xcode → Signing & Capabilities → team, automatic signing. Set version and build number; the build number must increase on every upload.
3. Confirm `PrivacyInfo.xcprivacy` is in the target's Copy Bundle Resources.
4. Product → Archive → Distribute App → App Store Connect → Upload. Or `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Release -archivePath build/App.xcarchive archive` then `xcodebuild -exportArchive …`.
5. TestFlight: internal testers install within minutes; external testers need one light review. **TestFlight is a fully viable permanent channel** — up to 10,000 people, and dramatically less 4.2 pressure than a public listing.
6. App Store: complete the nutrition label, screenshots, description, review notes (6.9), export compliance, then submit. Budget 2–3 rounds.

### 7.4 Android release

1. `keytool -genkey -v -keystore ecliptr-release.keystore -alias ecliptr -keyalg RSA -keysize 2048 -validity 10000`. **Back this up somewhere permanent** — losing it means you can never update the listing under that package name.
2. `android/app/build.gradle`: `targetSdk 35` (Play requirement), `minSdk 26` (section 4.2), signing config from `keystore.properties` (gitignored).
3. `cd android && ./gradlew bundleRelease` → `app/build/outputs/bundle/release/app-release.aab`.
4. Play Console → Internal testing → upload → install by link. Then closed testing, then production.
5. **If the developer account is personal rather than an organization, Play requires 12 testers running a closed test for 14 continuous days before production.** That is the long pole on the Android side and it is decided by plan decision 10.

---

## 8. Live JavaScript updates

### 8.1 Why it must be configured before first submission

Today `www/app.js` reaches every phone the moment it lands on `main`. After launch the same change waits 24–48 hours for Apple, and the store version falls behind the web version within a week. Worse, retrofitting an OTA channel later is itself a store submission, so you would be stuck at review latency during exactly the period when you most need to fix things.

### 8.2 The mechanism

`@capgo/capacitor-updater` (or Ionic Appflow Live Updates). It downloads a zipped `www/` bundle over HTTPS and swaps it at the next cold launch. Apple permits this: Guideline 2.5.2 requires the app to ship complete and self-contained, and Developer Agreement 3.3.2 allows downloading interpreted code **provided it does not change the app's primary purpose, add new features, or alter functionality from what was reviewed**.

Constraints that belong in the process, not just the config:

- The bundle inside the `.ipa` must be a **complete, working `www-bundle/`**. OTA is a replacement path, never the delivery path. Shipping a stub that pulls screens at runtime is the 2.5.2 rejection.
- An OTA payload may **never** add a purchase surface, add a native capability, or repurpose the app.
- **OTA bundles must be pinned to a native shell version.** A `www` that calls a plugin absent from the installed shell crashes devices that have not taken the store update. `build.json` (section 1.4) plus a `minShellVersion` field is the mechanism.
- Any change touching native code — new plugin, new permission, new entitlement — is a store submission regardless.
- **Runbook consequence:** publishing a mobile change becomes two acts, not one — push to `main` (web PWA, unchanged) **and** cut an OTA bundle. If only one happens, web and app diverge within days. This belongs in `ecliptr-mobile/README.md`, and it is a change to how Jack ships, not just an added tool.

### 8.3 The guardrail — `scripts/check-bundle.mjs`

Decision 9 (zero purchase surface) has to hold in **every** OTA build, which means it needs a build-time check, not a code-review habit. This script runs before `cap sync` and before every OTA cut, and exits non-zero on any hit:

1. Any file in `www-bundle/` outside the allowlist in section 1.4 → fail.
2. `/\$\s?39|\$\s?99|\/pricing|upgrade in-app|Paid plans|coming soon/i` anywhere in `www-bundle/` → fail.
3. `href="/guide"`, `ecliptr.app/register`, or any `landing.html` reference in `www-bundle/index.html` or `app.js` → fail.
4. `server.url` or `server.hostname` present in `capacitor.config.ts` → fail.
5. `www-bundle/index.html` missing the CSP meta or the build stamp → fail.
6. `www-bundle/build.json` missing `minShellVersion` → fail.

---

## 9. Order of work

Each phase ends in something runnable with a check that can actually be performed.

**N0 — Server unblock.** CorsLayer in `src/main.rs` (3.1) plus the three server strings (6.1) plus the demo inventory cap.
*Verify:* the `curl -X OPTIONS` in 3.1 returns `access-control-allow-origin: capacitor://localhost` and no `allow-credentials`; a browser request with no `Origin` still works; the web PWA is unchanged. **No Mac, no Apple account needed.**

**N1 — Client dual-mode auth.** `IS_NATIVE`, `API_BASE`, `authOpts`, the five `api` methods, `tryRefresh`, the six bypass sites, `mediaUrl` hoist, the service-worker gate (4.6).
*Verify:* the browser PWA behaves identically (`IS_NATIVE === false` everywhere, cookies still used) — this is the regression that matters most, because 100% of today's users are on that path.

**N2 — The shell exists.** `ecliptr-mobile/` created, `sync-web.mjs` + `check-bundle.mjs` written, `cap init`, `cap add android`.
*Verify:* debug APK on a real Android phone signs in against `https://m.ecliptr.app`, lists clients, opens an invoice, and **renders a lot photo** (that last one proves the `mediaUrl` fix). `check-bundle.mjs` exits 0. **This is the first-boot milestone and it is fully provable from Windows.**

**N3 — Camera.** Section 4.1, both create and edit paths, with the merge-on-write rule.
*Verify:* photograph a lot on Android, confirm the file lands in `{CLIENTHUB_MEDIA_PATH}/inventory/<id>/photos/<uuid>.jpg`, confirm `photos_json` gained one entry and **lost none**, confirm the photo renders on the lot card and on the public storefront.

**N4 — Compliance.** Purchase-surface gating (6.2), the Data and safety group with the four rows including the only-admin branch (6.3), the `confirm()` replacements on the deletion and sign-out paths, `delete-account.html` + `/privacy` + `/terms` routes (6.4), build-string fix.
*Verify:* on a sole-admin test workspace, Delete my account completes inside the app via the workspace branch, and the token and cache are gone afterwards. Grep the bundle for `$39`, `$99`, `/pricing`, `/guide`, `upgrade` → zero hits.

**N5 — Biometric + secure storage.** Section 4.2, and lengthen the session in the same release.
*Verify (Android only from Windows):* fingerprint gate on cold start and after the background timeout; a failed auth shows the locked screen and never falls through; the token is in `EncryptedSharedPreferences`, not `localStorage`.

**N6 — iOS platform.** *Requires a Mac.* `cap add ios`, icons and storyboard (section 5), Info.plist strings, `PrivacyInfo.xcprivacy`, `ITSAppUsesNonExemptEncryption`.
*Verify:* runs on the simulator; Face ID prompt appears with the correct purpose string and does not crash; archive uploads to App Store Connect without a privacy-manifest error.

**N7 — Offline read cache.** Section 4.3, **after** the `_clients` / `_suppliers` globals fix.
*Verify:* airplane mode → the four tabs paint from disk with a visible "as of HH:MM" stamp; no money figure is ever rendered without one; logout wipes the snapshots.

**N8 — Navigation stack.** Prerequisite for both push and deep links; also fixes the orphan screens (6.7). Roughly 120 lines per the plan.
*Verify:* Android hardware back walks the stack instead of quitting; every orphan screen has a way back; scroll position survives.

**N9 — OTA channel.** Section 8, wired and tested **before** first submission.
*Verify:* cut a bundle, confirm an installed build takes it at next cold launch, and confirm `check-bundle.mjs` blocks a deliberately non-compliant bundle.

**N10 — Deep links, then push.** Sections 4.5 then 4.4, including the `reqwest` `http2` rebuild and the mobile offers surface that the best push trigger depends on.

**N11 — TestFlight.** Screenshots, store copy, labels, review notes (6.9), demo account settled (6.8), submit.

Phases N0–N2 are the critical path and none of them need the Apple account, so they run in parallel with enrollment. N6 and everything after it on iOS are gated on the Mac and on enrollment.

---

## 10. What I still need from Jack

**Blocking, and pure waiting — start today:**

1. **Apple Developer Program enrollment**, $99/yr. As an individual it is often same-day; as **BJM Distributions LLC** it needs a **D-U-N-S number** and takes 1–3 weeks of pure waiting. Recommendation from the plan is the LLC. This gates the Team ID, the App ID, push keys, the associated-domains files, and every iOS build.
2. **Google Play Developer account**, $25 one-time. **Organization or personal?** A personal account forces 12 testers × 14 continuous days of closed testing before production. This is the long pole on Android.
3. **A Mac with Xcode** (or confirmation that the existing Mac CI can run `xcodebuild archive` and upload). Everything iOS is blocked on this and cannot be verified from Windows.

**Decisions only he can make:**

4. **Bundle ID.** I have specified `app.ecliptr.mobile` throughout. It is permanent and unchangeable after first submission. Confirm or replace.
5. **Deploy reality (0.1).** Is `.github/workflows/deploy.yml` the live mechanism, or is the rule "never deploy `src/plaid.rs`" still in force? The CORS change needs an agreed deploy path before anyone writes it.
6. **The demo account (6.8.3)** — two admins in the demo org, or a fresh disposable reviewer account per submission?
7. **TestFlight as the destination, or the public listing?** (Plan decision 8.) TestFlight is a fully viable permanent channel with far less 4.2 pressure. This changes how much of section 4 is mandatory.
8. **Android — yes or no?** (Plan decision 12.) It roughly doubles the push work and adds the closed-testing wait, but N2 recommends building Android first regardless because it is the only way to verify the auth change from Windows.
9. **Approval to lengthen the session** alongside the biometric lock (4.2). It is safe only if shipped together.
10. **Approval of the security tradeoff in 3.2** — moving from an `HttpOnly` cookie to a JS-reachable Bearer token. Unavoidable for a native shell, but it is a real regression and he should hear it before, not after.

**Assets and URLs:**

11. **Support URL** (required by both stores). `https://ecliptr.app/support` does not exist today.
12. **Marketing URL** (optional; `https://ecliptr.app` works).
13. **Privacy policy URL** — `www/privacy.html` exists but has no explicit route (6.4).
14. **Account deletion URL** for the Play form — does not exist; needs `www/delete-account.html` (6.4).
15. **App Store category and subtitle** (recommendation: Business; subtitle without "beta").
16. **The 1024×1024 icon decision** — confirm the mark on solid `#0D0A09`, or supply a different treatment. It cannot carry alpha.
17. **Screenshots** — 6.7" and 6.5" iPhone plus two Android phone shots, taken from the redesigned screens with realistic-looking demo data. These should come after N3 so the camera flow is visible in them.
18. **App Store Connect and Play Console access**, once the accounts exist.

**Honest limits of this document:** everything in sections 1–3 and 6.1–6.4 is verified against the code in this session and can be executed and tested from Windows. Everything in sections 4 (iOS half), 5 (iOS half), and 7.3 is written from the documented requirements and **cannot be verified here** — no Mac, no Apple account, no device. Treat the iOS specifics as correct-by-documentation, to be confirmed on first archive.

---

# APPENDIX — PWA vs NATIVE (auth, manifest, SW, storage)

## TASK 1 — PWA today vs native shell requirements

Evidence base: `www/index.html` (157 lines), `www/sw.js` (43), `www/manifest.json` (18), `www/app.js` (7,057 — note the plan says 6,759; it has grown), `src/main.rs`, `src/auth.rs`, `src/employees.rs`, `src/routes/inventory.rs`, `Cargo.toml`.

**Three corrections to MOBILE-REDESIGN-PLAN.md before anything else** — these change downstream work:

1. **Plan §2 "Account deletion … already exists as a real endpoint with a full data purge" is wrong on two counts.** `handle_delete_account` (`src/employees.rs:2268-2311`) deletes the `staff_accounts` row and one `deal_reps` row — it does **not** purge org data (`purge_org_data` at `:2332` is only reached by `handle_delete_workspace` `:2382` and the superadmin path `:2420`). Worse for Apple: it **hard-refuses when the caller is the org's only admin** (`:2295-2301`, "You're the only admin"). Jack is a sole admin, so the single most likely reviewer test — "delete the demo account you gave me" — fails with an error unless the demo workspace has a second admin, or the mobile UI also exposes `POST /api/account/delete-workspace` (password-confirmed, `:2670`). The mobile UI **does** already have the button (`www/app.js:1602`, handler `:1627-1634`), which the plan misses.
2. **The Phase 3 tab bar already shipped.** `index.html:131-152` is now `Home · Clients · Inventory · Deals · Search` (decision 11's recommendation), not the `Home · Clients · Invoices · Flows · More` the plan documents at line 74.
3. Plan §7 lists "compression" as the top Phase 1 item — confirmed still absent: `Cargo.toml:16` enables `tower-http` features `cors, fs, set-header, catch-panic`, no `compression-*`, and no `CompressionLayer` in `main.rs`.

---

## (a) AUTH — how it works, and everything that breaks in a WebView

### What holds the session today

**An HttpOnly cookie. The client never sees a token.**

- `POST /api/auth/employee/login` → `issue_session_at` (`src/employees.rs:1784-1800`) → `with_cookie(resp, set_cookie_value(&token, JWT_EXPIRY_SECS))`.
- Cookie string, `src/employees.rs:501-510`:
  ```rust
  format!("{COOKIE_NAME}={token}; HttpOnly; Path=/; Max-Age={max_age}; SameSite=Strict{secure}")
  ```
  `COOKIE_NAME = "clienthub_emp"` (`:35`), `JWT_EXPIRY_SECS = 86_400 * 7` (`:36`), `; Secure` appended only when `CLIENTHUB_SECURE_COOKIES=1` (`:504`).
- Every client call is root-relative with `credentials: 'include'` — the whole `api` helper, `www/app.js:162-202` (`get:164`, `post:171`, `put:181`, `patch:190`, `del:198`), each returning `showLogin()` on 401.
- Boot: `checkAuth()` `www/app.js:633-651` → `api.get('/api/auth/employee/me')`; failure → `showLogin()`.
- Login: `www/app.js:653-683` — raw fetch to `/api/auth/employee/login`, then **`location.reload()` (`:678`)** with the comment "Session cookie is set — reload into the app (the proven path)". The token in the response body is discarded.
- Logout: `doLogout()` `www/app.js:1722-1726` → `POST /api/auth/employee/logout` → `set_cookie_value("", 0)` (`src/employees.rs:1824-1827`). It clears `window.ME` and **nothing local**.
- `grep -n "Authorization\|Bearer" www/app.js` → **zero hits.** No token is ever stored or sent by the mobile client.

### The good news: the server is already Bearer-capable end to end

```rust
// src/employees.rs:955-969
/// Token from either the session cookie (web portal) or an `Authorization: Bearer`
/// header (desktop / API clients that can't rely on cross-site cookies).
fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    if let Some(cookie_header) = headers.get("cookie")... { ... }
    if let Some(auth) = headers.get(header::AUTHORIZATION)... {
        if let Some(t) = auth.strip_prefix("Bearer ") { return Some(t.trim().to_string()); }
    }
    None
}
```
This feeds `current_user` (`:971`) → `require_user` / `guard` (`:1005`) / `session_permissions_opt` (`:1029`), and the mobile API gate itself calls `session_permissions_opt` (`src/auth.rs:415`). So **every route the mobile app uses already accepts Bearer**. And the login response already hands the token over (`src/employees.rs:1795-1798`):
```rust
json!({ "ok": true, "user": user_json(&user), "token": token })
```
Refresh exists too: `POST /api/auth/employee/refresh` (`:1807-1822`, registered `:2666`), Bearer-capable, with `REFRESH_GRACE_SECS = 30d` (`:649`) and `MAX_SESSION_SECS = 90d` (`:654`).

### What breaks inside Capacitor — four failures, in the order they hit

**1. Every request 404s against the bundle, before auth is even reached.** All API calls are root-relative (`/api/...`). Under `capacitor://localhost` (iOS default) or `http://localhost` (Android default) those resolve to the local bundle. Nothing reaches the server. This forces an absolute `API_BASE`, which in turn makes every call cross-origin — that is what triggers failures 2 and 3.

**2. `SameSite=Strict` guarantees the cookie is never sent.** Once the document origin is `capacitor://localhost` and the API is `https://m.ecliptr.app`, *every* request is cross-site. `Strict` means the browser attaches `clienthub_emp` to none of them — and the `Set-Cookie` on the login response is itself a cross-site set and is dropped, so login can never even establish a session. Relaxing to `SameSite=None; Secure` is **not a sufficient fix**: WKWebView applies ITP third-party-cookie blocking by default, so cookie auth from a `capacitor://` origin is unreliable even when correctly attributed. Cookie auth is a dead end in the shell; Bearer is the answer, and it already works.

**3. There is no CORS layer at all.** `grep -rni "cors" src/` → **zero hits**, despite `tower-http = { features = [..., "cors", ...] }` at `Cargo.toml:16`. The server sends no `Access-Control-Allow-Origin` and handles no preflight. Every JSON `POST`/`PUT`/`PATCH` (the `Content-Type: application/json` header at `www/app.js:172/183/192` is enough to make the request non-simple) and every `DELETE` sends an `OPTIONS` preflight first, which falls through to `fallback_service(ServeDir::new("www"))` (`src/main.rs:190`) and dies. **Reads would fail and writes would fail.**

**4. `credentials: 'include'` is incompatible with a wildcard.** If CORS is added as `allow_origin(Any)` while the client still sends `credentials: 'include'`, the browser rejects every response. The clean combination is: drop `credentials`, send Bearer, and configure CORS **without** `allow_credentials`.

### Exact server change required

Add a `CorsLayer` at the **outermost** position in `src/main.rs` (alongside the `SetResponseHeaderLayer` stack, `:193-229`, applied to the full `app` router so it intercepts `OPTIONS` before routing) with an explicit origin allowlist — never `Any`:

- `capacitor://localhost` (iOS), `ionic://localhost` (legacy iOS scheme), `http://localhost`, `https://localhost` (Android `androidScheme`), plus the existing web origins.
- `allow_methods`: GET, POST, PUT, PATCH, DELETE, OPTIONS.
- `allow_headers`: `authorization`, `content-type`.
- **No** `allow_credentials` (paired with dropping `credentials:'include'` on the client).
- Note `capacitor://` and `ionic://` are non-HTTP schemes — they must go through `AllowOrigin::list` with `HeaderValue::from_static`, since some origin-parsing helpers reject non-HTTP schemes.

`src/main.rs:218-229` also sets `connect-src 'self'` in the CSP. That header governs documents this server serves; inside the shell the document comes from the bundle, so it stops applying — **but** if a `<meta http-equiv="Content-Security-Policy">` is added to `index.html` (advisable for review), it must name the API origin in `connect-src`, or every call is blocked by CSP instead of CORS.

### Exact client changes required (all in `www/app.js`, guarded so the web PWA is unaffected)

- Introduce `API_BASE` (empty string on web, `https://m.ecliptr.app` natively) and prefix it in the five `api` methods (`:162-202`).
- Replace `credentials:'include'` with `Authorization: Bearer <token>`.
- Login (`:653-683`): store `data.token` instead of `location.reload()` at `:678` — a reload of a bundled `index.html` also discards nothing useful, but the cookie it relies on will not exist.
- On 401, attempt `POST /api/auth/employee/refresh` once before `showLogin()`.
- **Four call sites bypass the `api` helper and must be fixed individually:**
  - `www/app.js:666` — login fetch.
  - `www/app.js:1629` — `fetch('/api/account', { method: 'DELETE' })`, the account-deletion call. Note it does **not** pass `credentials`, so it works today only because same-origin is the fetch default. Cross-origin it will send no credential at all. **This is the Guideline 5.1.1(v) path — it silently breaks first.**
  - `www/app.js:6818` — `DELETE /api/email/schedules/…`.
  - `www/app.js:4469` — `window.open('/api/invoices/' + id + '/pdf', '_blank')`. Needs an absolute URL *and* an auth strategy, since `window.open` carries no `Authorization` header — this one needs a signed short-lived URL or a fetch-to-blob, not a URL rewrite.
- Also absolute-ising: `href="/guide"` (`:1238`), and photo URLs at `:2609` — `const mediaUrl = p => ... ? '/' + p : null` — which currently produce `/media/inventory/<id>/photos/<name>`. Under the shell **every inventory photo resolves into the bundle and 404s.** `www/style.css:2-5` (`url('/fonts/Satoshi-*.woff2')`) is fine, because those files ship in the bundle.

### One security tradeoff to state to Jack explicitly

Today the session token is `HttpOnly` and unreachable from JavaScript — XSS cannot exfiltrate it. Moving to Bearer puts a 7-day token (30-day refresh grace, 90-day absolute cap) into JS reach. That is an accepted, standard tradeoff for native shells, but it is a real regression, and it is the reason the token must land in Keychain/Keystore rather than `localStorage` (see (d)).

---

## (b) PWA MANIFEST + ICONS

**Present.** `www/manifest.json` exists (18 lines), linked at `index.html:34`: `id`/`start_url`/`scope` = `/`, `display: standalone`, `orientation: portrait`, `background_color`/`theme_color` `#0D0A09`.

Icon assets actually in `www/` (dimensions read from the PNG headers):

| File | Actual size | Bytes |
|---|---|---|
| `apple-touch-icon.png` | 180×180 | 30,035 |
| `icon-192.png` | 192×192 | 33,050 |
| `icon-512.png` | 512×512 | 138,942 |
| `icon-maskable-512.png` | 512×512 | **138,942 — byte-identical to `icon-512.png`** |
| `favicon-32.png` | 32×32 | 2,107 |
| `og-image.png` | 1200×630 | 65,563 |

**Two live defects, both pre-existing:**

- **The maskable icon is not maskable.** `icon-maskable-512.png` is the same file as `icon-512.png` (identical byte count) but declared `"purpose": "maskable"` at `manifest.json:16`. A maskable icon needs the mark inside a ~40% radius safe zone (roughly 20% padding all round). Android is cropping the logo edges on the installed PWA today, and the same source will do it in the adaptive icon.
- **`start_url: "/"` is wrong for the non-`m.` host.** `root_handler` (`src/main.rs:413-423`) serves `index.html` only when `Host` starts with `m.`/`mobile.`, otherwise `landing.html`. So an install from `ecliptr.app` launches the marketing page. `start_url` should be `/app` (`src/main.rs:131`).

**What iOS/Android additionally require (none of it satisfied by the above):**

- **iOS app icon:** one 1024×1024 PNG, **no alpha channel, no transparency, no pre-rounded corners** — Apple applies the mask. The largest asset today is 512×512 and PWA icons routinely carry alpha, so this is a new export, not a resize. Xcode 15+ takes the single 1024 into the AppIcon set.
- **iOS launch screen:** must be a storyboard (static launch PNGs have been rejected since iOS 14). Capacitor scaffolds one; it needs a source mark and must match `background_color` so first paint doesn't flash.
- **Android adaptive icon:** two layers — `ic_launcher_background` (colour or drawable) and `ic_launcher_foreground` on a 108×108dp canvas with only the centre 72dp guaranteed visible. Ship 432×432 xxxhdpi foreground. This is where the missing 20% padding must finally be added.
- **Android 13+ themed icon:** a monochrome layer. Optional but conspicuous by absence on modern launchers.
- **Play Store listing assets:** 512×512 32-bit PNG icon (with alpha, unlike Apple's) + 1024×500 feature graphic.
- **Notification icon (Android):** a white-on-transparent silhouette, once push exists (Phase 4). Colour icons render as a white square.
- **`manifest.json` becomes inert inside the shell** — no install prompt, and `orientation: portrait` does not govern. Orientation moves to `Info.plist` (`UISupportedInterfaceOrientations`) and `AndroidManifest.xml` (`android:screenOrientation`). Keep serving the manifest unchanged for the web PWA.

---

## (c) SERVICE WORKER

**Today.** `www/sw.js`: `CACHE = 'ecliptr-v94'` (`:4`), `SHELL = ['/', '/app.js', '/style.css']` (`:5`), `skipWaiting()` on install (`:10`), old caches purged + `clients.claim()` on activate (`:18-25`), and a **network-first** fetch handler (`:27-42`) that skips non-GET (`:29`), skips `/api/` entirely (`:30`, "never cache API — always live data"), writes successful same-origin responses through to cache (`:34-37`), and falls back to cache **only when the network rejects outright** (`:40`). Registration + the update banner live in `index.html:49-83`, including a `controllerchange` → `window.location.reload()` (`:78-80`).

Two defects worth noting while it is being touched: `SHELL` caches `'/'`, which on a non-`m.` host is `landing.html` (per `root_handler`), and the offline fallback `caches.match('/')` (`:40`) therefore serves the marketing page instead of the app. Both should be `/app`. And network-first is exactly the "one bar of signal stalls for 30s showing nothing" failure the plan calls out at line 246.

**What it should do inside the native shell: nothing — do not register it.**

- The WebView loads `index.html` from the bundle. There is no network fetch to intercept for app files, so network-first has no meaning.
- Service workers are **not supported on the `capacitor://` scheme on iOS**; the registration at `index.html:54` will simply fail there. On Android (`http://localhost`) it may register and then usefully intercept nothing.
- The real hazard is `index.html:78-80`: a `controllerchange` triggers `window.location.reload()` on the shell — a visible hard reload with no purpose inside a native app.

**Spec:** gate registration on platform, keeping one `index.html` for both targets. In `index.html:52`, change
`if ('serviceWorker' in navigator) {` to
`if ('serviceWorker' in navigator && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {`
— and, in the same edit, add an unregister sweep for the native case so a device that used the PWA before installing the app doesn't carry a stale SW into the shell. Leave `sw.js` itself untouched for the web PWA (fixing `'/'` → `'/app'` and cache-first-with-revalidate is separate Phase 1 work).

**How JS updates ship without an App Store review.**

Apple permits it — Guideline 2.5.2 requires the app to ship complete and self-contained, and 3.3.2 of the Developer Agreement allows downloading interpreted code **provided it does not change the app's primary purpose, add new features, or alter functionality from what was reviewed**. The standard mechanism for Capacitor is an OTA bundle channel (`@capgo/capacitor-updater`, or Ionic Appflow Live Updates) that fetches a zipped `www/` and swaps it at next cold launch.

Constraints that must be written into the process, not just the config:
- The bundle in the `.ipa` must be a **complete, working `www/`** — OTA is a replacement path, never the delivery path. Shipping a stub that pulls screens at runtime is the 2.5.2 rejection.
- An OTA payload may **never** add a purchase surface, add a native capability, or repurpose the app. Given decision 9 (zero purchase surface), the pricing/upgrade scrub has to hold in every OTA build, which means it needs a build-time check, not a code review habit.
- OTA bundles must be pinned to a native shell version — a `www` that calls a Capacitor plugin absent from the installed shell crashes on devices that haven't taken the store update.
- Any change that touches native code (new plugin, new permission, new entitlement) is a store submission regardless.
- The plan is right that this must be wired **before** first submission (decision 14). Practical consequence for deploy hygiene: today `scp www/app.js` publishes instantly; after launch the same change has to be published to the web *and* cut as an OTA bundle, or the two diverge within a week. That is a change to the deploy runbook, not just an added tool.

---

## (d) STORAGE — what exists, what must move

**Everything the app persists today, exhaustively.**

`localStorage` — 15 call sites, **all UI preference, zero business data, zero credentials**:

| Key | Purpose | Sites |
|---|---|---|
| `clienthub_dark` | light/dark | `app.js:120`, read pre-paint `index.html:19` |
| `clienthub_matte` | monochrome | `app.js:126`, `index.html:23` |
| `clienthub_accent` | accent colour | `app.js:142,151`, `index.html:24` |
| `ec_welcome_v1` | welcome tour seen | `app.js:234,238` |
| `ec_onboard_done` | onboarding dismissed | `app.js:3043-3044` |
| `ec_dash_range` | dashboard `mtd`/`all` | `app.js:3299,3332` |
| `ec_brief_days` | weekly-brief window | `app.js:5906,5907,5913,5920,5940` |

Everything else:
- **Session:** the `clienthub_emp` HttpOnly cookie. Not reachable by JS by design — `grep "document.cookie" www/app.js` → 0 hits.
- **IndexedDB: 0 hits. `sessionStorage`: 0 hits.** (`grep -n "indexedDB\|sessionStorage\|caches\." www/app.js` returns nothing.)
- **Cache Storage:** app shell only, written by the SW; `/api/` explicitly excluded (`sw.js:30`). No business data is cached anywhere on the device today.
- **In-memory only, lost on reload:** `window.ME` (`app.js:637`), `_clients`, `_suppliers`, `_payoutRecipients` (`app.js:101-105`).

**What must move to secure native storage: exactly one thing — the session token, and only once auth becomes Bearer.**

- Destination: iOS Keychain / Android Keystore-backed EncryptedSharedPreferences. **`@capacitor/preferences` is not adequate** — it is plain `UserDefaults` / `SharedPreferences`, readable on a jailbroken or rooted device and (on iOS) included in unencrypted local backups. Use a Keychain-backed plugin, with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` so the token never travels in an iCloud backup to another device.
- Face ID / biometric lock (Phase 4) gates *reading* that keychain item — it is not a separate credential store.

**What may stay where it is.** All seven `localStorage` keys are non-sensitive display preferences; leave them. WebView `localStorage` lives in the app sandbox and is fine for this.

**Three storage obligations the current code does not meet, which the shell makes mandatory:**

1. **Logout must wipe local state.** `doLogout()` (`app.js:1722-1726`) clears `window.ME` and calls the server; it clears no local storage. With a stored Bearer token that becomes a real credential leak across users on a shared phone. It must delete the keychain item, and later the offline cache.
2. **Account deletion must wipe local state too.** `app.js:1627-1634` does `location.href = '/'` — inside the shell that navigates to the bundled root, and the token, prefs and any cache survive. Apple checks that deletion is real from the user's side.
3. **The Phase 5 offline read cache is where this gets serious.** Once clients, invoices, deals and money figures are cached locally, that store must be app-sandbox, excluded from iCloud backup (`NSURLIsExcludedFromBackupKey`), wiped on both logout and account deletion, and declared accurately in the App Privacy nutrition labels and `PrivacyInfo.xcprivacy`. The plan already flags the offline queue as its highest-risk item; the storage classification is the part that also carries review consequences, not just data-integrity ones.

---

# APPENDIX — GUIDELINE 4.2 CAPABILITY SET

# TASK 2 — THE GUIDELINE 4.2 CAPABILITY SET

## Part 0 — Verification of the claims I was told to check

| Claim | Verdict | Evidence |
|---|---|---|
| `POST /api/inventory/:id/photo/:name` already exists | **TRUE** | `C:/Users/Jack/Desktop/clienthub-api/src/routes/inventory.rs:32` (route), handler `upload_inventory_photo` :44. Any authenticated org member; org-scoped via `inventory_in_org`; path-sanitized (`[A-Za-z0-9._-]`, ≤128 chars, no `..`); magic-byte checked PNG/JPEG/WEBP; 12 MB cap; writes to `{CLIENTHUB_MEDIA_PATH}/inventory/<id>/photos/<name>` |
| Mobile never calls it | **TRUE** | Zero matches for `photo/` or `manifest/` in `www/app.js`. `showInventoryForm` (`www/app.js:3771`) has 11 fields and no file input. The only `accept="image/*"` in the whole app is the account avatar at `www/app.js:1590` |
| The server has no push sender | **TRUE, and worse than "no code"** | Zero matches for `apns`/`fcm`/`firebase`/`device_token`/`vapid` across `src/`. **And `Cargo.lock` contains no `h2` crate** — `reqwest` is declared `default-features = false` with only `json`+`rustls-tls`, so **HTTP/2 is not compiled in**. APNs is HTTP/2-only. The plan's claim that "reqwest with rustls does HTTP/2" is wrong for *this* Cargo.toml |
| **Bonus (not asked, but it decides the camera design)** | | `PUT /api/inventory/:id` already accepts `photos: Option<Vec<String>>` and writes `photos_json` + syncs it (`inventory.rs:348-357`). `POST /api/inventory` returns `{"ok":true,"id":...}` (`inventory.rs:203`). **The entire camera feature needs zero server changes.** |
| **Bonus** | | `tower-http` is already compiled with the `cors` feature (`Cargo.toml:14`) but `CorsLayer` is used nowhere. The CORS fix is a config line, not a dependency change |

---

## Part 1 — The chosen set, ranked

Score = (reviewer credibility × real user value) / effort, each 1–5.

| # | Capability | Cred | Value | Effort | Score | Verdict |
|---|---|---|---|---|---|---|
| 1 | **Biometric app lock** | 4 | 4 | 1 | **16.0** | SHIP |
| 2 | **Camera capture → lot photos** | 5 | 5 | 2 | **12.5** | SHIP — flagship |
| 3 | **Offline read cache** | 4 | 5 | 3 | **6.7** | SHIP |
| 4 | **Push notifications** | 5 | 3 | 5 | **3.0** | SHIP, but re-scoped (see §2.4) |
| 5 | **Deep / universal links** | 2 | 3 | 2 | **3.0** | SHIP — it is a *dependency* of #4, not a defense on its own |
| 6 | Share-sheet target | 2 | 2 | 5 | 0.8 | **REJECT** — cheaper 80% substitute in §3 |

**The ratio is not the build order.** Build order is **camera → biometric → offline → (deep links → push)**. Camera goes first despite ranking second because it is the only one of these a reviewer can *watch happen* in a 90-second demo, and it is the one Jack uses hourly. Biometric is #1 on ratio purely because it is a day of work.

**Minimum credible 4.2 set: camera + biometric + offline + push.** Four capabilities, three of which a reviewer can verify in the first two minutes of the app, and every one of which a broker standing in a warehouse actually uses. Do not add anything as review theater.

---

## Part 2 — Per-capability specification

### 2.0 Cross-cutting prerequisites (all four depend on these — build once, first)

These are not optional polish; three of the four capabilities are silently broken without them.

1. **`API_BASE` constant.** Under Capacitor the webview origin is `capacitor://localhost` (iOS) / `https://localhost` (Android). Every relative URL in `app.js` breaks. Choke points: `fetchWithTimeout` (`www/app.js:158`), `mediaUrl` (`www/app.js:2609`, and it is defined *inside* `renderInventory` — hoist it to module scope), `ensureSpace` (`www/app.js:203`, loads `/space.js`). Without the `mediaUrl` fix, **the photo you just took renders as a broken image** — the camera feature appears not to work.
2. **Bearer auth replaces the cookie.** `api` (`www/app.js:162-201`) sends `credentials:'include'` on every call; the cookie is `HttpOnly; SameSite=Strict` and will not cross `capacitor://localhost`. Server already accepts `Authorization: Bearer` (`src/employees.rs:955-964`); login at `/api/auth/employee/login` (`www/app.js:666`) already returns the token and currently throws it away. Also `www/app.js:1629` calls `DELETE /api/account` with bare `fetch` and no auth header at all — it works today only because of the same-origin cookie default, and it will 401 in the wrapper. That is the account-deletion path Apple requires under 5.1.1(v), so it is a submission blocker, not a nit.
3. **`CorsLayer` on the server** allowing origins `capacitor://localhost` and `https://localhost`, `allow_credentials(false)`, methods GET/POST/PUT/PATCH/DELETE, headers `authorization, content-type`. The `cors` feature is already compiled in.
   **Do not use `CapacitorHttp` as the alternative.** It patches `fetch` natively and has known binary-body mangling — which is exactly what the raw-`Bytes` photo upload sends. CORS + normal `fetch` is the correct choice here.
4. **A separate Capacitor project directory**, e.g. `C:/Users/Jack/Desktop/ecliptr-mobile/`, whose build step *copies a filtered subset* of `C:/Users/Jack/Desktop/clienthub-api/www/` into `webDir`. The root `package.json` in `clienthub-api` exists only for icon generation (`@resvg/resvg-js`, `png2icons`) — do not mix Capacitor into it, and never let `node_modules` near the scp deploy set.
   **The copy manifest must exclude `landing.html`.** It contains the `$39` / `$99` pricing table at `www/landing.html:691,709`. Shipping it inside the `.ipa` puts a purchase surface in the binary and hands a reviewer a Guideline 3.1.1 finding. Exclude `landing.html`, `register.html`, `signup.html`, `download.html`, `shop.html`, `staff.html`, `og-image.png`.

---

### 2.1 CAMERA CAPTURE → LOT PHOTOS *(flagship — this is the 4.2 answer)*

**Plugin:** `@capacitor/camera` (official, v7). No community plugin needed.

**Why it is the flagship:** it is the one job on the list a laptop physically cannot do; the server route has been live and open to any org member for months; and `PUT /api/inventory/:id` already accepts `photos`. This capability is *pure client work on top of finished server work* — the highest work-unblocked-per-line item in the project.

**Exact flow (no server changes):**
```
1. Camera.getPhoto({ source: CameraSource.Prompt, resultType: CameraResultType.Uri,
                     quality: 70, width: 2000, correctOrientation: true })
2. Filesystem.readFile({ path: photo.path }) → base64 → Uint8Array → Blob
3. name = crypto.randomUUID() + '.jpg'          // MUST be a uuid — see below
   POST {API_BASE}/api/inventory/{lotId}/photo/{name}
        Content-Type: image/jpeg,  body: Blob (RAW bytes, not multipart)
4. existing = JSON.parse(lot.photos_json || '[]')
   PUT {API_BASE}/api/inventory/{lotId}
       { photos: [...existing, `media/inventory/${lotId}/photos/${name}`] }
```

**Four constraints that will bite whoever builds this:**
- **The route is raw `body: Bytes`, not multipart.** Any `FormData` upload silently fails the magic-byte check and returns 400 "only PNG, JPEG, or WEBP images".
- **The filename must be a fresh UUID.** This is the v0.15.112 root cause: the old `photo_001` scheme reused names after deletion and the CDN/webview served the cached previous image. `crypto.randomUUID()+'.jpg'` = 41 chars, passes the server's ≤128 `[A-Za-z0-9._-]` filter.
- **`PUT /api/inventory/:id` replaces `photos_json` wholesale** (`inventory.rs:348-357`). Merge-on-write is the caller's job. Read the current array, append, write back — never send just the new photo. This is the exact standing rule from the parity audit; violating it here would delete every existing photo on a lot from the phone.
- **You cannot attach a photo before the lot exists** — the endpoint validates `inventory_in_org(&id, &org)`. For the create path: hold captured photos in memory → `POST /api/inventory` → use the returned `id` → upload → PUT. `create_inventory` returns the id, so this works, but it means partial failure is possible (lot saved, photo not) and the UI must say so rather than silently succeeding.

**iOS `Info.plist`:**
```
NSCameraUsageDescription      = "Ecliptr uses the camera to photograph inventory
                                 lots and pallets so buyers can see what you're selling."
NSPhotoLibraryUsageDescription = "Ecliptr can attach photos you've already taken to
                                  an inventory lot."
```
Omit `NSPhotoLibraryAddUsageDescription` — do not save captures back to the camera roll; the copy stays on the server. Vague purpose strings ("this app needs camera access") are a known rejection cause; use the wording above.

**Android `AndroidManifest.xml`:**
```xml
<uses-permission android:name="android.permission.CAMERA"/>
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES"/>   <!-- API 33+, gallery source -->
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"
                 android:maxSdkVersion="32"/>
```
Plus the `FileProvider` `<provider>` block and `res/xml/file_paths.xml` — both are in the Capacitor Android template; verify they survived, because the plugin returns a `content://` URI and fails silently without them.

**Privacy manifest (`PrivacyInfo.xcprivacy`):** the camera is not a "required reason" API — nothing to declare here. Add to `NSPrivacyCollectedDataTypes`:
```
NSPrivacyCollectedDataTypePhotosorVideos
  Linked: YES · Tracking: NO · Purposes: [NSPrivacyCollectedDataTypePurposeAppFunctionality]
```

**Nutrition label (App Store Connect):** User Content → *Photos or Videos*, linked to identity, App Functionality, not used for tracking. Must match the manifest entry exactly.

**`app.js` integration points (absolute path `C:/Users/Jack/Desktop/clienthub-api/www/app.js`):**
| Where | Line | What changes |
|---|---|---|
| `showInventoryForm(editLot)` | `:3771` | Add a photo strip above the button row; on create, capture-then-upload after the `POST` returns the id (`:3820`) |
| lot detail panel, footer | `:2698-2706` | Add an **Add photo** button next to `#inv-edit` / `#inv-delete` — this is the primary entry point |
| `allPhotos` in the detail body | `:2665` | Currently renders `allPhotos[0]` only. Make it a scrollable strip with per-photo delete (delete = PUT the array minus one entry; the file stays on disk, which is correct and safe) |
| `mediaUrl` | `:2609` | Hoist out of `renderInventory`, prefix with `API_BASE` |
| `firstPhoto` | `:2610` | No logic change; benefits automatically |
| Home quick actions | Phase 3 redesign | "Photograph a lot" chip → lot picker → capture. This is the 2-tap path the plan promises |

**Effort:** M. ~250 lines of `app.js`, one plugin, two plist keys, zero server work. Assumes §2.0 is done.

---

### 2.2 BIOMETRIC APP LOCK *(highest ratio — a day of work)*

**Plugins:** `@aparajita/capacitor-biometric-auth` (actively maintained, iOS + Android, TypeScript) **plus** `@aparajita/capacitor-secure-storage` for the token.

**Correction to the existing plan:** it says to store the bearer token in `@capacitor/preferences` "with keychain backing". **`@capacitor/preferences` is `UserDefaults` on iOS — it is not the Keychain, it is not encrypted, and it is backed up in plaintext-equivalent form.** Storing a session JWT for a tool holding client financials and bank transactions there is wrong. Use a Keychain-backed secure-storage plugin (Keychain on iOS, `EncryptedSharedPreferences` on Android). Do not use `@capacitor-community/native-biometric` — it is stale relative to Capacitor 7.

**Why it earns its place with a reviewer:** `LocalAuthentication` is a framework a browser cannot reach, it is visible on first launch, and for a financial tool it reads as *considered*, not bolted on. It is the cheapest credibility in the set.

**The synergy worth naming:** `JWT_EXPIRY_SECS` is 7 days (`src/employees.rs:36`, ~37-day effective window with refresh at `/api/auth/employee/refresh`). Jack's memory already records JWT-expiry pain — getting logged out mid-warehouse. A biometric gate on app resume is *what buys you the right to lengthen that session safely*: the token can live longer because possession of the unlocked phone is no longer sufficient to use it. Ship the lock and the longer session together, or the lock is pure friction.

**iOS `Info.plist`:**
```
NSFaceIDUsageDescription = "Ecliptr uses Face ID to unlock your workspace so your
                            client and financial data stays private if your phone
                            is unlocked by someone else."
```
This key is **mandatory** — without it the app *crashes* the first time Face ID is invoked. A crash a reviewer can reproduce is an automatic rejection.

**Android `AndroidManifest.xml`:**
```xml
<uses-permission android:name="android.permission.USE_BIOMETRIC"/>
```
Set `minSdkVersion 26` (Capacitor 7 defaults to 23). At 23–27 you would additionally need `USE_FINGERPRINT` and the deprecated `FingerprintManager` path; raising minSdk deletes that whole branch and costs nothing real in 2026.

**Privacy manifest:** nothing. **Nutrition label:** nothing — biometric matching happens in the Secure Enclave and no biometric data ever reaches your app or server. **Do not declare biometric data collection.** Over-declaring here is a common error that creates a label the app cannot justify.

**`app.js` integration points:**
| Where | Line | What changes |
|---|---|---|
| boot / `showLogin` | `:212` | Before showing the app: if a token exists in secure storage and lock is enabled → `authenticate()` → on success proceed, on failure show a locked screen (never fall through to the app) |
| `/api/auth/employee/me` check | `:635` | The existing session-validity call becomes the post-unlock step, not the first step |
| new `App.addListener('appStateChange')` | new | Re-lock after N minutes in background (default 5, user-configurable). This is where `@capacitor/app` earns its place |
| Settings → You group | Phase 3 Settings rework | One row: "Require Face ID · On/Off", plus the timeout |

**Effort:** S. ~80 lines, two plugins, one plist key. **This is the single best effort-to-credibility trade in the whole project.**

---

### 2.3 OFFLINE READ CACHE

**Plugin:** `@capacitor/filesystem` (official) writing JSON snapshots to `Directory.Data`. **Not** `@capacitor/preferences` for the payloads — that is `UserDefaults`, which is not designed for hundreds of KB of list data. **Not** `@capacitor-community/sqlite` — it is a real database with a real migration story, and v1 needs a cache, not a second source of truth. (Note: a second SQLite on phones is precisely the divergence the parity audit exists to kill.)

**Scope for v1: READ ONLY. No write queue.** This is a hard line. A write queue multiplies any save-corruption bug by every queued write, and the merge-on-write P0s from `C:/Users/Jack/Desktop/BUSINESS APP/PARITY-AUDIT-2026-07-26.md` are still open. Offline writes are Phase 5 at the earliest, and only after the repair decision is settled.

**What to cache:** the four list endpoints behind the four main tabs — `/api/clients`, `/api/inventory`, `/api/invoices`, `/api/deal-flows`. Nothing else. Every cached money figure renders with a visible **"as of 14:32"** stamp and is never presented as live.

**Prerequisite the plan already flags and I am re-flagging:** the boot-cached globals `_clients` / `_suppliers` / `_payoutRecipients` (`www/app.js:101-105`) are *already* a stale-data source — that is the root cause behind "mobile stale data" in the deploy-23 notes. Build the disk cache **on top of** that fix, not instead of it, or you will have two stale layers arguing.

**iOS `Info.plist`:** none. **Android permissions:** none — `Directory.Data` is app-private scoped storage. Explicitly do **not** add `MANAGE_EXTERNAL_STORAGE` or broad storage permissions; Play flags them and they are unnecessary.

**Privacy manifest — this is where the required-reason API declarations actually come from:**
```xml
NSPrivacyAccessedAPITypes:
  NSPrivacyAccessedAPICategoryFileTimestamp   → reason "C617.1"   (files the app created)
  NSPrivacyAccessedAPICategoryUserDefaults    → reason "CA92.1"   (app's own data)
  NSPrivacyAccessedAPICategoryDiskSpace       → reason "E174.1"   (ONLY if you check free space before writing)
```
**A correction to the existing plan:** it attributes the `UserDefaults` declaration to `app.js`'s heavy `localStorage` use. That is imprecise — `localStorage` inside a `WKWebView` is WebKit's own store and does **not** touch `UserDefaults`. The declaration is required because Capacitor core and `@capacitor/preferences` use `UserDefaults` directly. The end result is the same (declare it), but the reasoning matters if anyone ever audits the manifest — and a wrong or missing manifest is an *automated* rejection at upload, before a human ever looks.

**Nutrition label:** no new category. The cached data is the same data already declared. But caching Financial Info on-device is the strongest single argument for shipping §2.2 in the same release.

**`app.js` integration points:**
| Where | Line | What changes |
|---|---|---|
| `api.get` | `:163-168` | The single choke point. On 2xx: write `{data, fetchedAt}` snapshot. On network failure/timeout: read snapshot, set a global staleness stamp, return cached data |
| `fetchWithTimeout` | `:158-162` | `FETCH_TIMEOUT` is 15s (`:156`). In one-bar signal that is 15 seconds of blank screen. Cache-first-then-revalidate for the four list endpoints turns that into instant paint |
| `setContent` | `:240` | Render the "as of HH:MM" bar when the staleness stamp is set |
| offline banner | `:358-364` | Stops being "you are offline, here is nothing" and becomes "showing data from 14:32" |
| `sw.js` | `www/sw.js:32` | `if (req.url.includes('/api/')) return;` — never caches API. Correct for the browser PWA, and dead weight inside the wrapper (service workers do not run on `capacitor://`). Keep `sw.js` unchanged for the web; branch on `window.Capacitor` at runtime. **Do not try to make one mechanism serve both.** |

**Effort:** M–L. ~200 lines plus the staleness UI, plus the `_clients`/`_suppliers` fix as a hard prerequisite. The risk is not the code, it is showing a stale number as if it were live.

---

### 2.4 PUSH NOTIFICATIONS *(ship, but the trigger list in the brief is wrong)*

**Plugins:** `@capacitor/push-notifications` (official) + `@capacitor/app` (tap routing).

**The honest correction first — this is the most important finding in this section.**

The brief proposes *invoice paid, approval pending, refund recorded*. **Two of those three are not server-originated events.** `mark_invoice_paid` (`src/routes/invoices.rs:447`) and the refund paths are *user actions performed from a device* — the desktop or the phone does the write and syncs it through the oplog. A push on those fires to tell Jack about something he did thirty seconds ago on the machine in front of him. That is the kind of notification people disable in week one, and a reviewer who sees a notification permission prompt that produces nothing useful is not impressed by it.

**The events the server genuinely learns about while the phone is in a pocket** — verified in the source:

| Event | Where it originates | Why it deserves a push |
|---|---|---|
| **A buyer makes an offer on a storefront lot** | `src/routes/storefront.rs:306` `submit_offer` — a *public, unauthenticated* POST from a buyer | The single best trigger in the product. Money walking in the door, from a person you are not talking to. **Note:** `www/app.js` has **zero** references to `offers` — mobile cannot display an offer today. The push would land on a screen that does not exist. Build the mobile offer surface with the push, or the feature is a dead end |
| **New pending approval** | `src/routes/approvals.rs` — fed by signup (`src/main.rs:309`), intake (`intake.rs:243`), web forms (`forms.rs:182`), Shopify webhook | Already has `/api/approvals/count`, a bell, and a badge. The plumbing for the in-app half is done |
| **Stale-listing renewal request** | `src/scheduler.rs:46` `flag_stale_listings` | Already writes approval rows on a 60s tick. Free trigger |
| **Newsletter send job finished or failed** | `src/scheduler.rs:319` `process_pending_sends` | The "sent 30 then stopped" incident cost a day of not knowing. A push closes that loop |
| **Sync push dead-lettered** | v0.15.92 dead-lettering | A device that quietly stops syncing is invisible today |

Do **not** push newsletters, and do not push anything the user's own device just caused.

**Server work — the honest assessment (this is the expensive one):**

1. `device_tokens` table (org-scoped, one row per device, platform, tombstoned on sign-out) + register/unregister endpoints. ~80 lines.
2. **APNs sender.** ES256 JWT via `jsonwebtoken` (already a dep, v9 supports ES256) + HTTP/2 POST to `api.push.apple.com`. ~150 lines.
   **BLOCKER:** `reqwest` in `C:/Users/Jack/Desktop/clienthub-api/Cargo.toml:28` is `default-features = false, features = ["json","rustls-tls"]`, and **`Cargo.lock` contains no `h2` crate**. reqwest 0.12 gates HTTP/2 behind an `http2` feature which is off. APNs will not accept HTTP/1.1. Fix is adding `"http2"` to the feature list — one line, but it pulls in `h2` and its tree, and because the droplet is scp-deployed as a built binary, it means a full server rebuild and redeploy touching every existing `reqwest` call site (Plaid, Facebook, Shopify, `bank_backup`). Deploy hygiene applies: matched set, and **never deploy `src/plaid.rs`**.
3. **FCM sender for Android** — separate code path (HTTP v1 API, RS256 service-account JWT → OAuth2 token exchange → POST). Roughly doubles the sender work. If Android is deferred, defer this too.
4. Trigger wiring at the five points above. Small individually; the scheduler's existing 60s tick (`src/scheduler.rs:19`) is the natural home for the batched ones.
5. Retry, token invalidation on APNs 410 `Unregistered`, and per-user notification preferences (a Settings row).

**iOS configuration:**
- **No `Info.plist` usage-description key** — notification permission is requested through `UNUserNotificationCenter` and needs no purpose string. (Frequently over-added; harmless but wrong.)
- App ID capability **Push Notifications**; entitlement `aps-environment` = `development` / `production`.
- **Do not add `UIBackgroundModes: [remote-notification]`** unless you send silent content-available pushes. You do not need them for v1, and declaring the background mode invites reviewer questions about what you are doing in the background.
- APNs auth key: `.p8` + Team ID + Key ID (token-based; do not use certificates).

**Android `AndroidManifest.xml`:**
```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>   <!-- API 33+, runtime prompt -->
```
Plus `google-services.json`, the `com.google.gms.google-services` Gradle plugin, and the plugin's `FirebaseMessagingService` entry.

**Privacy manifest:** no required-reason API. Add:
```
NSPrivacyCollectedDataTypeDeviceID
  Linked: YES · Tracking: NO · Purposes: [NSPrivacyCollectedDataTypePurposeAppFunctionality]
```

**Nutrition label:** **Identifiers → Device ID.** This is the one category push adds, and the one most commonly forgotten — the label then no longer matches the binary, which is a post-launch removal risk rather than a review-time one. Declare it the moment push ships, not later. Tracking stays NO.

**`app.js` integration points:**
| Where | Line | What changes |
|---|---|---|
| after `/api/auth/employee/me` | `:635` | Register the device token post-login (never pre-login — you do not know the org yet) |
| `refreshBell` / `#header-bell` | `:2843-2849` | The in-app counterpart. `pushNotificationReceived` (foreground) should refresh the badge, not pop a banner over the user's own screen |
| `renderApprovals` | `:2855` | Tap target for the approvals push |
| `navigateTo` / `render` | `:721` / `:733` | Tap routing. **Blocked on the navigation stack** — see below |
| Settings → You → Notifications | Phase 3 | Per-event toggles; the app must remain fully functional if permission is denied |

**Hard dependency:** a push tap must deep-open a specific screen. `www/app.js` has **zero** uses of `pushState`/`popstate`/`hashchange` in 7,057 lines. Until the Phase 2 navigation stack exists, a tapped push can only dump the user on the home tab — which is worse than no push. **Do not start push before the navigation stack lands.**

**Effort:** L. Client ~120 lines; server ~250 lines plus the `http2` rebuild plus a second sender for Android plus retry/invalidation. This is the only capability in the set with meaningful server risk, and it is the last one to build.

---

### 2.5 DEEP / UNIVERSAL LINKS *(infrastructure, not a defense)*

**Plugin:** none beyond `@capacitor/app` (`appUrlOpen` listener).

I am listing this separately from the brief's framing: **deep links do not defend Guideline 4.2 by themselves** — a reviewer sees them as table stakes. They are here because (a) push is worthless without them, (b) a reviewer *will* tap an emailed link and land in Safari signed out if they are missing, and (c) they are the delivery mechanism for the document-handler substitute in §3.

**Server work:** serve two static files with correct `Content-Type` and no redirect:
- `https://ecliptr.app/.well-known/apple-app-site-association` (JSON, `application/json`, **no** `.json` extension)
- `https://ecliptr.app/.well-known/assetlinks.json`

Both require the Apple Team ID and the final bundle ID, so they come after Developer Program enrollment.

**iOS:** Associated Domains entitlement `applinks:ecliptr.app`. **Android:** `<intent-filter android:autoVerify="true">` on the main activity.

**Targets:** storefront `/i/:token`, client portal, invoice links, password reset `/reset`, team invite links (`www/app.js:894`).

**Privacy manifest / nutrition label:** nothing.

**`app.js` integration:** one `App.addListener('appUrlOpen')` handler that parses the path and calls into the navigation stack — same dependency as push.

**Effort:** S–M client, S server. Blocked on Apple enrollment and on the navigation stack.

---

## Part 3 — Rejected, with reasons

**Share-sheet target — REJECT for v1.**
A true share target is a native iOS **Share Extension**: a separate binary target, an App Group for handoff, its own provisioning profile, and no official Capacitor plugin (the community `send-intent` covers Android well and iOS only with a hand-written extension). Effort L. Reviewer credibility is low — reviewers rarely test share extensions. And the user value is capped by design: the plan deliberately keeps the manifest *analyzer* desktop-only, so the phone would receive a spreadsheet it can do little with beyond store it.

**The cheaper 80% substitute, if you want this later:** register Ecliptr as a **document type handler** — `CFBundleDocumentTypes` + `LSSupportsOpeningDocumentsInPlace` + `UTImportedTypeDeclarations` in `Info.plist`, no extension target at all. "Open in Ecliptr" then appears in Mail and Files, the file arrives through the **same `appUrlOpen` listener you already built for deep links**, and you POST it to `POST /api/inventory/:id/manifest/:name` — which **already exists and is verified live** (`src/routes/inventory.rs:33`, accepts `manifest.csv/pdf/xlsx/xls/tsv/txt`, 25 MB cap, any authenticated org member, and `www/app.js` never calls it either). That is Info.plist-only work reusing a finished server route. Hold it in reserve: it is an excellent "one more thing" to add if a reviewer pushes back on 4.2 in round one.

**Barcode / label scanning — REJECT for v1, sequencing problem not a value problem.**
`@capacitor-mlkit/barcode-scanning` is genuinely strong 4.2 material (Vision/ML Kit, impossible in a browser). But **there is no SKU, UPC, or barcode field anywhere in the inventory schema** — `InventoryInput` and `InventoryUpdate` (`src/routes/inventory.rs:225-275`) have no such column, and `details_json` holds variants/condition/price_text, not identifiers. A scanner would have nothing to match against. It also adds 3–5 MB (bundled ML Kit) or a Play Services dependency. Correct order: add a SKU field first, then scan. v1.1.

**Home-screen widget (WidgetKit) — REJECT for v1.**
A separate Swift target reading through an App Group; nothing in the Capacitor JS layer can feed it without writing native code, and it duplicates the freshness logic from §2.3. Real credibility, real effort (L). Revisit once the offline cache is stable — the widget is nearly free once a snapshot file already exists in a shared container.

**Geolocation — REJECT.**
Adds a Precise Location nutrition category and a scary runtime prompt for near-zero value; the lot already has a free-text `location` field (`inventory.rs` `location` column), and "which warehouse" is a business fact, not a GPS fact.

**Contacts import — REJECT.**
Adds a Contacts nutrition category and a prompt users decline; desktop CSV import already covers the job.

**Haptics — take it, but do not count it.**
`@capacitor/haptics` is ~20 lines and pairs naturally with the Phase 1 "make every row press" work. A reviewer cannot distinguish it from nothing, so it is not a 4.2 argument — it is polish, and it is free polish.

---

## Part 4 — The paragraph that answers "why is this an app and not a website?"

Draft this into the App Review notes *before* submitting; a prepared, specific answer usually resolves a 4.2 question in one round:

> Ecliptr is a field tool for wholesale liquidation brokers who work in warehouses, on loading docks, and in trucks. The app uses the device camera to photograph pallets and truckloads directly into an inventory record at the point of intake — the core workflow, and one that cannot be done from a desk. It keeps an encrypted on-device cache so clients, inventory, invoices and deals are readable in warehouses with no cellular signal, with every figure timestamped so cached money is never shown as live. It requires Face ID to unlock, because it holds client financial records and bank transaction data. It receives push notifications when a buyer submits an offer on a listing, when a new client signs up and needs approval, and when a listing goes stale — events that happen while the user is away from any computer. Account deletion is available in-app under Settings → Data & safety and permanently deletes the account and its data.

Every clause in that paragraph is a capability from §2, and every one is demonstrable in the demo workspace within two minutes.

---

## Part 5 — Corrections to `MOBILE-REDESIGN-PLAN.md` this task surfaced

Four things in the existing plan are wrong or imprecise and will cost time if executed as written:

1. **`Cargo.toml:28` `reqwest` has no HTTP/2.** The plan says "reqwest with rustls does HTTP/2, maybe 150 lines". `default-features = false` disables the `http2` feature and `Cargo.lock` has no `h2`. APNs is HTTP/2-only. Add `"http2"` and budget a full server rebuild + scp redeploy.
2. **`@capacitor/preferences` is not Keychain-backed on iOS** — it is `UserDefaults`. The plan directs storing the bearer JWT there. Use a Keychain-backed secure-storage plugin instead.
3. **`localStorage` in a `WKWebView` does not map to `UserDefaults`.** The plan's stated reason for the `NSPrivacyAccessedAPICategoryUserDefaults` declaration is wrong; the correct reason is Capacitor core + the Preferences plugin. Same outcome, but the manifest must be right for the right reason since it is auto-checked at upload.
4. **"Invoice paid" and "refund recorded" are not server-originated events** and are poor push triggers. The verified server-originated set is: storefront offer, pending approval, stale listing, newsletter job outcome, sync dead-letter.

Two additions the plan does not mention that the build depends on:

5. **`mediaUrl` (`www/app.js:2609`) is defined inside `renderInventory` and returns a root-relative path.** Under `capacitor://localhost` every lot photo 404s — the flagship feature appears broken. Hoist it and prefix with `API_BASE`.
6. **`www/landing.html:691,709` carries the `$39`/`$99` pricing table.** If `webDir` is a straight copy of `www/`, a purchase surface ships inside the binary. The bundle copy must be a filtered subset.

---

# APPENDIX — STORE COMPLIANCE AUDIT

## TASK 3 — STORE COMPLIANCE AUDIT (code as it stands, 2026-08-03)

Sources read: `www/app.js` (7,015 lines), `www/index.html`, `www/manifest.json`, `www/sw.js`, `www/landing.html`, `www/guide.html`, `www/register.html`, `src/main.rs`, `src/employees.rs`, `src/auth.rs`, `src/scheduler.rs`, `src/routes/{clients,inventory,referrals,newsletters}.rs`.

Two corrections to `MOBILE-REDESIGN-PLAN.md` before anything else: **(1) in-app account deletion already has a UI** (`www/app.js:1600-1634`) — the plan lists it as Phase 4 work; the real defect is different and worse (see B1). **(2) `index.html` already ships the redesigned tab bar** (`Home · Clients · Inventory · Deals · Search`, index.html:131-152) and `renderMore` is already a search hub with counts (`app.js:1198-1262`) — the plan's "before" IA is stale.

---

# MASTER CHECKLIST

| # | Item | Guideline | Status today |
|---|---|---|---|
| A1 | "Paid plans … coming soon" upsell in Settings | 3.1.1 | **FAIL** |
| A2 | "Your plan" section | 3.1.1 | RISK |
| A3 | Refer & earn names the Business plan ×3 | 3.1.1 | **FAIL** |
| A4 | Referral link → external `/register` | 3.1.1 | RISK |
| A5 | Login screen → external `ecliptr.app/register` | 3.1.1 / 5.1.1 | RISK |
| A6 | "Setup guides" → `/guide` → nav "Pricing" → $39/$99 | 3.1.1 | **FAIL (worst)** |
| A7 | Welcome tour ×4 links to `/guide` on first launch | 3.1.1 | **FAIL** |
| A8 | Server error toast "…Upgrade to add more." | 3.1.1 | **FAIL** |
| A9 | Server error toasts "Paid plans … coming soon" ×2 | 3.1.1 | **FAIL** |
| A10 | Payment methods / mark-paid | 3.1.3(e) | PASS (safe) |
| A11 | No Stripe/checkout/IAP code in the app | 3.1.1 | PASS |
| B1 | Sole admin **cannot** delete their account | 5.1.1(v) | **FAIL (blocker)** |
| B2 | Workspace deletion has no mobile UI | 5.1.1(v) | **FAIL** |
| B3 | Delete endpoint + button exist and work | 5.1.1(v) | PASS |
| B4 | Delete call bypasses the api helper (breaks in wrapper) | 2.1 | **FAIL** |
| B5 | Data-scope of deletion not disclosed | 5.1.1(v) | RISK |
| B6 | Export endpoint exists, no UI | GDPR/Play | RISK |
| C1 | Zero third-party analytics/tracking SDKs | 5.1.2 | PASS |
| C2 | Privacy manifest `PrivacyInfo.xcprivacy` | Apple upload gate | **FAIL (absent)** |
| C3 | Play "Account deletion URL" (web) | Play policy | **FAIL (absent)** |
| C4 | Privacy policy / Terms not linked in app | 5.1.1 / Play | **FAIL** |
| C5 | Permission purpose strings | 5.1.1(i) | N/A yet — specified below |
| D1 | Demo workspace exists, sends are simulated | 2.1 | PASS |
| D2 | Demo password not in repo, unverified | 2.1 | RISK |
| D3 | Reviewer will hit the inventory cap → A8 toast | 3.1.1 | **FAIL** |
| D4 | Reviewer deleting the demo account destroys it | 2.1 | **FAIL** |
| E1 | Guideline 4.2 minimum functionality | 4.2 | **FAIL** |
| E2 | Screens loaded from server at runtime | 2.5.2 | **FAIL** |
| E3 | **No CORS layer anywhere in `src/`** | 2.1 | **FAIL (blocker)** |
| E4 | 24 `confirm()` + 1 `prompt()` system dialogs | 4.2 quality | **FAIL** |
| E5 | Invoice PDF opens externally → 401 blank | 2.1 | **FAIL** |
| E6 | Stale build string "m20 · 2026-07-05" | 2.1 | **FAIL** |
| E7 | Orphan screens with no way back | 4.2 | **FAIL** |
| E8 | "Coming soon" wording in app | 2.2 | **FAIL** (= A1) |
| E9 | No "beta" wording inside the app | 2.2 | PASS |
| E10 | Sign in with Apple not required | 4.8 | PASS |
| E11 | Export compliance declaration | — | TODO (trivial) |

---

# (a) PURCHASE SURFACE — Guideline 3.1.1

Nothing in `www/` contains Stripe, a checkout, a price, or the string `/pricing`. **Every hit below is either upsell *copy* or a link that leads to a price list two hops away.** The chain in A6/A7 is the highest-risk item in this entire audit, and A8 is the most likely to actually fire during review.

### Verdict per occurrence

| File:line | Text | Verdict |
|---|---|---|
| `www/app.js:6397` | `Paid plans with more storage and seats are coming soon.` | **REMOVE on native.** Textbook upsell copy for a non-IAP plan. Also trips 2.2 ("coming soon"). |
| `www/app.js:6393` | `<div class="section-title">Your plan</div>` | **HIDE on native.** Reflecting entitlement is allowed; the heading + hint together read as a plan/pricing screen. Replace with "Workspace" + seat/client usage only. |
| `www/app.js:6395` | renders `Free plan` / `Founder plan` / `Business plan` | SAFE **if** 6397 goes. Apple permits showing what the user already has. Recommend keeping just `Team members: 3/5 · Clients: 41/100`. |
| `www/app.js:6396` | `Team members: n/limit · Clients: n/limit` | SAFE. Usage, not an offer. |
| `www/app.js:1187` | More/Search row sub: `Share your link — earn Business for life` | **REWORD or hide.** Names a paid tier as a reward. |
| `www/app.js:1291` | `bring on 3 workspaces and you're grandfathered into the Business plan, free for life` | **HIDE the whole screen on native.** |
| `www/app.js:1297` | `You've hit 3 — Business for life is yours.` | Same. |
| `www/app.js:1308` | renders each referred workspace's plan badge (Free/Pro/Business) | Same. |
| `www/app.js:1293` + `src/routes/referrals.rs:81` | referral link = `{base}/register?ref={code}` | **HIDE.** Outbound CTA into the signup funnel whose site header exposes Pricing. |
| `www/index.html:101` | `<a href="https://ecliptr.app/register" target="_blank">Create a workspace</a>` | **REMOVE on native.** Registration itself is free and `register.html` contains **no** prices (verified), so this is not strictly a 3.1.1 violation — but it is an unnecessary link out of the app on the *first screen a reviewer sees*, and it lands on a site whose nav links to Pricing. Replace with plain text: "Ask your workspace admin to invite you." |
| `www/app.js:1238` | `<a class="list-item" href="/guide" target="_blank">Setup guides</a>` | **FIX — highest risk.** `/guide` → `guide.html:84` `<a href="/#pricing">Pricing</a>` → `landing.html:662-715`: `$39 / month`, `$99 / month`, and `landing.html:694` `Start free, upgrade in-app →`. **Two taps from inside the app to a price list with an "upgrade in-app" CTA.** |
| `www/app.js:225,226,227,228,231` | 5 welcome-tour steps linking `/guide`, `/guide#inbox`, `/guide#import`, `/guide#sheets` | **FIX — same chain, and it auto-opens on first launch**, i.e. the exact flow a reviewer sees. |
| `src/routes/inventory.rs:169` | `"You've reached your plan's limit of {} inventory items. **Upgrade to add more.**"` | **MUST CHANGE.** Toasted verbatim in-app (`app.js:3820-3822`). Contains the word "Upgrade". Reachable by the reviewer — see D3. |
| `src/routes/clients.rs:162` | `"…100-client limit on the Free plan. Paid plans with unlimited clients are coming soon."` | **MUST CHANGE.** Toasted verbatim (`app.js:3994`). |
| `src/employees.rs:2167` | `"…team-member limit for the Free plan. Paid plans with more seats are coming soon."` | **MUST CHANGE.** Surfaced on the Team screen (`app.js:932`). |
| `src/employees.rs:1734` | `"This workspace has reached its team-member limit on the Free plan."` | SAFE (states a fact, no offer). Reword for consistency. |
| `www/app.js:6448-6453` | Settings → **Payment methods** | **SAFE.** These are the *operator's own* bank/wire/Zelle labels printed on invoices to their buyers — physical goods and services consumed outside the app, explicitly excluded from IAP (3.1.3(e)/3.1.5(a)). Explain this in the review notes so a reviewer doesn't mistake it for a purchase surface. |
| `www/app.js:4664-4691` | "Mark paid" modal, `payment_method_label` | **SAFE**, same reasoning. |
| `www/app.js:714` | code comment | SAFE (comment). |

### Off-app but must change with it
`www/landing.html:694` — **"Start free, upgrade in-app →"** asserts that in-app upgrading exists, which directly contradicts the zero-purchase-surface position if a reviewer opens the site (they routinely do for account-based apps). Change to **"Start free, upgrade on the web →"**.

### Required mechanism
Do **not** fork `app.js` for native — it guarantees drift against the PWA. Gate with one constant near the top of the IIFE:

```js
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
```

Then: skip A1/A2 blocks, drop the `referrals` entry from the Utility group + `TAB_PERM`, drop the login-screen signup link, and either drop the Help→Setup-guides row or point it at a bundled guide with the marketing nav stripped. Server strings (A8/A9) must be fixed server-side unconditionally — they cannot be gated client-side, and they are the ones that will actually fire.

---

# (b) ACCOUNT DELETION — Guideline 5.1.1(v)

**The endpoint exists and so does the UI.** What fails is the path the reviewer will personally walk.

**Endpoint** — `DELETE /api/account`, `src/employees.rs:2268-2309`, routed at `src/employees.rs:2669`. Deletes the `staff_accounts` row + `deal_reps` assignments, records a sync delete, writes an audit row, clears the cookie.

**UI** — `www/app.js:1600-1603` renders a "Danger zone → Delete my account" button inside **My account**, reached via the Search tab → You → My account (`app.js:1233-1234`, wired `:1264`). Handler at `app.js:1626-1634`.

### B1 — BLOCKER: a sole admin cannot delete their account
`src/employees.rs:2291-2296`:
```
"You're the only admin. Delete the whole workspace, or make someone else an admin first."
```
Single-owner workspaces — which includes **the demo account you hand Apple** and most real Ecliptr customers — tap "Delete my account" and receive an error telling them to go do something else. Apple rejects exactly this: the deletion path must complete inside the app.

### B2 — the path that *would* work has no mobile UI
`POST /api/account/delete-workspace` (`src/employees.rs:2388-2427`) is password-confirmed and calls `purge_org_data` (`:2332-2355` — 26 org tables + portal tokens + suppressions + invites + resets + verifications + roles + staff + the org row). Grep of `www/`: **zero** references to `delete-workspace`. Also note `:2396-2398` — `org_default` can never be deleted, so Jack's own workspace will always hit the B1 error; irrelevant to review, relevant to him.

### B3/B4 — the call itself breaks in the wrapper
`app.js:1629` is a bare `fetch('/api/account', { method: 'DELETE' })` — it does **not** go through `api.del`, has no `credentials:'include'`, and uses a relative URL. Under Capacitor the origin becomes `capacitor://localhost`, so this resolves to nothing and 401s silently. Must route through the api helper with an absolute base URL and a Bearer token (see E3).

### B5 — scope not disclosed
Self-delete removes the *user*, not the org's data. That is defensible for a multi-seat B2B workspace (the org is the controller), but the confirmation copy must say so or App Review will ask.

### B6 — export exists, unexposed
`GET /api/account/export` (`src/employees.rs:2458`, routed `:2671`, admin-only) dumps all 26 org tables to JSON. No mobile UI. Free credibility on both privacy forms.

### SPEC — Settings → "Data & safety" group (last group, per plan §4 group 6)

Four rows, each opening a full screen, nothing destructive inline:

1. **Export my data** *(admin only)* → `GET /api/account/export` → share sheet with `ecliptr-export-<org>-<date>.json`. Subtitle: "A JSON copy of everything in this workspace."
2. **Sign out** (moves here from the Search hub).
3. **Delete my account** — *always visible, never disabled*. Sheet (not `confirm()`):
   - Title: "Delete your account"
   - Body: "Your Ecliptr login, profile and rep assignments are deleted immediately and you're signed out. Records you created for **{org_name}** — clients, invoices and deals — stay with the workspace. To delete those too, delete the workspace."
   - Require typing `DELETE` (a wrapped app's destructive action needs more friction than a system alert).
   - `POST` via the api helper. On `200` → clear the token, hard-reset to the login view.
   - **On the only-admin 400, do not show a dead end.** Replace the error with a branch sheet offering (i) "Delete the whole workspace instead" → row 4, or (ii) "Make someone else an admin first" → deep-link into Team with the role picker open. Both complete inside the app. This is the fix for B1.
4. **Delete workspace** *(admin only)* — closes B2. Sheet: red header, the full list of what is purged, "This cannot be undone and affects **{member_count}** people", type the workspace name, then a password field → `POST /api/account/delete-workspace {password}`. On `200` → clear token, reset to login. **Note `org_default` returns 403** (`employees.rs:2397`) — catch it and show "This workspace can't be deleted from the app. Contact support." rather than the raw error.

Sizing: ~180 lines in `app.js` plus one new settings group. No server change required except the B1 branch is purely client-side.

---

# (c) PRIVACY

### What the app actually sends (grepped from the write paths)

| Category | Fields | Where |
|---|---|---|
| Account credentials | email, password | `index.html:93-95` → `POST /api/auth/employee/login` (`app.js:666`) |
| Account profile | display_name, title, phone, avatar image (base64, resized client-side) | `app.js:1594-1596, 1615-1620` → `PATCH /api/account` |
| Third-party contacts (clients) | name, email, phone, company, lead_status, category, tags, street, city, state, zip, next_follow_up_date, notes | `app.js:3972-3986` → `POST/PUT /api/clients` |
| Interaction logs | call/meeting notes, outcome, dates | `app.js:4033` → `POST /api/interactions` |
| Suppliers | name, contact_name, payment method + details | `app.js:2411-2412` |
| Financial | invoices, line items, totals, payments, payment-method labels, deal-flow profit, splits, payouts | `app.js:4328-4329, 4455-4691, 5008-5866` |
| Inventory | lot name, price, qty, condition, location, notes (photos in Phase 4) | `app.js:3819` |
| Notes | free text | `app.js:982-994` |
| **Email credentials** | SMTP host, port, username, **app password** | `app.js:6371` → `PUT /api/settings/smtp` |
| Company profile | name, address, tax ID, logo | `PUT /api/settings/company` (`app.js:6529`) |
| Newsletter | recipient lists, message bodies, send history | `app.js:6910, 6953` |
| Feedback | title/body, auto-stamped with name/email/org (`employees.rs:985`) | `app.js:1660` |
| Server-side only | IP for rate limiting (`employees.rs:925-930`, CF-Connecting-IP / X-Forwarded-For); `audit_log` = user_id, action, entity, timestamp (`employees.rs:85-89`) | — |
| Device-local, never sent | `clienthub_dark`, `clienthub_matte`, `clienthub_accent`, `ec_welcome_v1`, `ec_onboard_done`, `ec_dash_range`, `ec_brief_days` | `app.js:120,126,151,238,3044,3299,5907` |

**No third-party SDKs.** Grep for posthog / sentry / gtag / mixpanel / firebase / segment across `www/`: **zero hits**. Both forms can honestly say "no data shared with third parties" and Apple's "Data used to track you: **No**". *Do not add an analytics or crash SDK before the first submission* — it changes both labels and adds required-reason API declarations.

### Apple privacy nutrition label

All rows: **Collected · Linked to the user · Not used for tracking · Purpose: App Functionality** (add "Product Personalization" nowhere; add "Analytics" nowhere).

| Apple category | Declare | Contents |
|---|---|---|
| Contact Info — Name, Email, Phone, Physical Address | **YES** | user profile + every client/supplier record |
| User Content — Other User Content, Photos or Videos, Emails or Text Messages | **YES** | notes, interactions, lot photos, avatar, newsletter bodies |
| Identifiers — User ID | **YES** | account id, org id |
| Financial Info — Other Financial Info | **YES** | invoices, payments, payouts, margins. **Not** "Payment Info" — no card or bank-account number is ever entered in the app |
| Other Data | **YES** | SMTP app password, company tax ID |
| Usage Data, Diagnostics, Location, Contacts, Health, Search/Browsing History, Purchases, Sensitive Info | **NO** | verified absent |

Note on **Contacts**: declared No because clients are typed, not read from the device address book. If Phase 4 adds a contacts picker, this flips and the label must be updated before that build ships.

### Google Play Data Safety

- **Personal info** — Name, Email address, Phone number, Address, User IDs → Collected, **not** shared, Required, purposes: App functionality + Account management.
- **Financial info** — "Other financial info" → Collected, not shared. (Not "Purchase history", not "Payment info".)
- **Photos and videos** — Photos → Collected (avatar today; lot photos Phase 4).
- **Messages** — "Other in-app messages" → Collected (newsletters/quotes composed and sent).
- **Files and docs** → only if manifest upload lands on mobile.
- **App activity / App info and performance** → **No** (no analytics, no crash SDK).
- Security practices: **Data is encrypted in transit** — YES (HTTPS + HSTS `main.rs:199-202`). **Users can request that data be deleted** — YES. **Data can be deleted** — YES.
- **C3 — MISSING: Play requires a publicly reachable Account Deletion URL** in the Data Safety form, *in addition to* in-app deletion. Ecliptr has none. New work: a static `www/delete-account.html` served at `/delete-account`, explaining the in-app path and offering an email request route for users who can't sign in.
- **C4 — Privacy policy**: `www/privacy.html` exists and is reachable only via the `ServeDir` fallback (`main.rs:190`) as `https://ecliptr.app/privacy.html` — there is no explicit `/privacy` route. Add explicit `/privacy` and `/terms` routes (stable URLs are required by both stores) and link both from the new Data & safety settings group — grep confirms **no privacy or terms link exists anywhere in `www/app.js`**.

### C2 — Apple Privacy Manifest (hard upload gate, not a review round)
`PrivacyInfo.xcprivacy` must ship in the app target: `NSPrivacyTracking = false`, empty `NSPrivacyTrackingDomains`, the collected-data types above, and required-reason APIs — `NSPrivacyAccessedAPICategoryUserDefaults` reason **CA92.1** (Capacitor Preferences/WebView all touch UserDefaults), plus `NSPrivacyAccessedAPICategoryFileTimestamp` **C617.1** and `DiskSpace` **E174.1** if the offline cache lands. Every Capacitor plugin must carry its own manifest too. Missing this = App Store Connect rejects the *upload*.

### Permissions and exact purpose strings

Today the app requests **nothing** — the only device capability used is a file input (`app.js:1590`, avatar) plus clipboard, `tel:` and `mailto:` (`app.js:875-876, 1515, 3600`). No geolocation, no notifications, no camera, no biometrics anywhere in `www/`. For the Phase 4 native build:

**iOS `Info.plist`** — request each one *at the moment of use*, never at launch:

- `NSCameraUsageDescription` → **"Ecliptr uses the camera so you can photograph pallets and manifests and attach them to an inventory lot while you're at the warehouse."**
- `NSPhotoLibraryUsageDescription` → **"Ecliptr accesses your photo library so you can attach existing lot photos and set your profile picture."**
- `NSPhotoLibraryAddUsageDescription` *(only if saving back)* → **"Ecliptr saves lot photos and invoice PDFs to your photo library when you choose to export them."** Omit the key entirely if nothing is written back.
- `NSFaceIDUsageDescription` → **"Ecliptr uses Face ID to unlock your workspace, so client and financial data stays private even if your phone is already unlocked."**
- Push notifications (no plist string) — show a pre-permission screen first: **"Get notified when an invoice is paid, a payment lands, or a team member needs your approval."** Only call `requestPermission()` after the user taps Turn on.
- `ITSAppUsesNonExemptEncryption = false` (E11) — HTTPS only, no proprietary crypto; without it every single upload prompts for export-compliance answers.

**Android manifest** — `INTERNET`, `ACCESS_NETWORK_STATE` (the offline banner), `CAMERA`, `READ_MEDIA_IMAGES` (API 33+) / `READ_EXTERNAL_STORAGE` `maxSdkVersion="32"`, `POST_NOTIFICATIONS` (API 33+), `USE_BIOMETRIC`. **Not** location, contacts, microphone, `MANAGE_EXTERNAL_STORAGE`, or `READ_PHONE_STATE`. **Never add `QUERY_ALL_PACKAGES`** — Play flags it; WhatsApp sharing must use a `<queries>` entry for `com.whatsapp` or the plain system share sheet.

---

# (d) DEMO ACCOUNT FOR REVIEW — Guideline 2.1

**A real demo workspace exists.** `src/scheduler.rs:10-15`:
```rust
/// The sales-demo org (demo@email.com). Its clients are entirely fictional test
pub const DEMO_ORG_ID: &str = "org_8903289cfd67492595c13868929ea789";
```

**How a reviewer logs in:** open the app → the standard email/password form (`index.html:92-99`) → `POST /api/auth/employee/login` (`app.js:666`). No 2FA, no SSO, no email verification gate on an existing account. Login returns both a session cookie and a `token` in the JSON body (`employees.rs:1797`), and the server accepts `Authorization: Bearer` (`employees.rs:955-969`) — so the wrapper has a working auth path already.

**What they'd see:** a populated dashboard, fictional clients, deals, invoices, inventory. **Newsletter and email sends are simulated for this org and never actually delivered** (`scheduler.rs:396-397, 507-521`; `newsletters.rs:317-318`) — a reviewer can press Send safely, which is exactly what you want. They will **not** see the Feedback inbox or Early-access list (gated to `org_default`, `app.js:1246`) or any bank/Plaid data.

### Four things to fix before submitting

- **D2** — the password lives only in the live DB, not the repo. Confirm or reset it, make it stable and non-expiring, and check the login rate limiter (`employees.rs:1311-1347`, 5 attempts) won't lock a reviewer out after a typo.
- **D3 — the reviewer can trigger the "Upgrade to add more" toast.** `employees.rs:764-766` caps the demo org at **10 inventory items**; `inventory.rs:169` returns the "Upgrade to add more." string; `app.js:3820-3822` toasts it verbatim. A reviewer poking at Inventory — the tab you're promoting for the 4.2 defense — is *likely* to hit this. **This is the single most probable way you fail 3.1.1.** Fix the string server-side and raise the demo cap.
- **D4 — the demo account must survive being deleted.** The reviewer *will* test 5.1.1(v). If they succeed, the account is gone for round 2; if it's the sole admin, they hit B1 and reject you. Resolution: seed the demo org with **two** admins and hand over the non-sole one, so deletion genuinely completes and you re-seed between rounds. Alternatively mint a fresh disposable reviewer account per submission. Decide this before writing the review notes.
- Consider a read-only demo role — a demo admin can open Settings and type into the SMTP fields (`app.js:6370-6371`). Harmless but untidy.

### App Review notes — must state
1. Credentials + "sign in with these; the demo workspace is pre-populated with fictional data."
2. "Ecliptr is free during beta. There is nothing to purchase in this app and no purchase surface anywhere in it."
3. "Settings → Payment methods lists the *operator's own* bank/wire details, which print on invoices sent to their wholesale buyers. It is not a purchase mechanism and does not unlock app features. Invoiced goods are physical wholesale merchandise delivered outside the app."
4. "Account deletion: Search tab → My account (or Settings → Data & safety) → Delete my account." Give the literal tap path.
5. Camera/notifications/Face ID: what triggers each prompt, so the reviewer can find them (directly supports the 4.2 defense).

---

# (e) EVERYTHING ELSE THAT GETS A BUSINESS TOOL REJECTED

**E3 — the actual blocker nobody has noticed: there is no CORS layer.** `grep -rn "CorsLayer\|allow_origin\|Access-Control" src/` returns **nothing**. A Capacitor webview runs on `capacitor://localhost` (iOS) / `https://localhost` (Android); every call in `app.js` is a relative URL with `credentials:'include'` (`app.js:162-202`), and the session cookie is `SameSite=Strict` (`employees.rs:509`, `auth.rs:305`). **Nothing will load — the reviewer cannot even sign in.** Fix: switch the wrapper to `Authorization: Bearer` (already supported server-side, `employees.rs:955-969`) with an absolute API base and the token in secure storage, and add a CORS layer allowlisting the two Capacitor origins. Until this is done, A/B/D are all moot.

**E2 — Guideline 2.5.2.** `index.html:155` loads `app.js?v=31` from the server, `style.css?v=19` at `:48`, and `sw.js` is network-first (`sw.js` fetch handler). Every screen is downloaded at runtime today. The bundle must contain the HTML/CSS/JS; only *data* may come over the wire. (Live JS updates via a compliant OTA channel are permitted afterward — plan decision 14.)

**E1 — Guideline 4.2.** Confirmed by grep: no `navigator.geolocation`, no `mediaDevices`, no `Notification`, no `getUserMedia` anywhere in `app.js`. The only device capability is one `accept="image/*"` file input at `app.js:1590` (the avatar). There is currently nothing to answer "why is this an app?" — Phase 4 is the answer, and it must land before submission.

**E4 — 24 `confirm()` and 1 `prompt()`.** In the wrapper these render as `capacitor://localhost says…` system dialogs. `app.js:3711` is a **`prompt()` for the credit-limit field** — an unstyled system text-entry box is the single most website-looking element in the product. Two of them sit on the screens a reviewer is guaranteed to visit: `app.js:1627` (delete account) and `app.js:1723` (sign out).

**E5 — `app.js:4469`** `window.open('/api/invoices/'+id+'/pdf','_blank')` — under Capacitor this kicks the system browser, which has no session, so the reviewer gets a 401 blank page instead of a PDF. Use the Browser plugin with an authenticated blob or a signed one-time URL.

**E6 — `app.js:6455`** renders `Mobile build m20 · 2026-07-05` from `BUILD` (`app.js:76`), while the product is at v0.15.122. A reviewer sees a version string that doesn't match the binary. Wire it to the Capacitor app version or delete the line.

**E7 — orphan screens.** Approvals, Checkup, **My account** (the delete-account screen), Payout config, Team member profile and Categories are rendered via `setContent()` without a tab assignment, so there is no back affordance and a pull-to-refresh ejects you. A reviewer who lands in My account and can't get out reads the app as unfinished. Phase 2's nav stack fixes it; it is not optional before submission.

**E8 — "coming soon" is in the app** (`app.js:6397`). Beyond 3.1.1, "coming soon" reads as unreleased functionality under 2.2. Same edit removes both problems.

**E9 — PASS: no "beta" string in `www/app.js` or `www/index.html`.** It appears only in `landing.html:668` and `terms.html:63`, which is fine — Apple objects to beta wording *in the app and its metadata*. Keep "beta", "trial", "coming soon" and "test" out of the App Store description, subtitle, screenshots and the What's New text.

**E10 — PASS: Sign in with Apple not required.** Email/password only; no Google/Facebook/OAuth login anywhere in the login path. 4.8 does not apply.

**Placeholder content — low risk, worth a pass:** `app.js:2298` `value="https://yoursite.com/thank-you"` and `:2307` `yoursite.com/contact` are deliberate instructional mockups on the web-forms screen. Safe, but rename to `yourcompany.com` so a skimming reviewer doesn't read them as unfinished.

**Referral degradation:** `app.js:1282` renders "Referrals aren't available yet — try again shortly." if the endpoint 404s — reads as a broken feature. Moot once the screen is hidden on native (A3).

**Android-specific:** Play requires targetSdk 35; and if the developer account is personal rather than an organization, you owe 12 testers × 14 days of closed testing before production — plan decision 10, and it is the long pole on that side.

---

## The five things to fix first, in order

1. **E3 — CORS/Bearer.** Nothing else is testable until the wrapper can reach the API.
2. **A8/A9 — the three server strings.** One-line edits in `inventory.rs:169`, `clients.rs:162`, `employees.rs:2167`. Deploys instantly with no app release. `inventory.rs:169` is reachable by the reviewer on the demo account **today**.
3. **B1 — the only-admin deletion dead end**, plus the B4 fetch bug. Client-side only; ~180 lines.
4. **A6/A7 — the `/guide` → Pricing chain.** Six links in `app.js` (`:225-231`, `:1238`), plus stripping the marketing nav from `guide.html`.
5. **D4 — a demo account that survives being deleted**, decided before the review notes are written.