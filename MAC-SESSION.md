# Mac session — Apple signing and iOS setup

The executable copy of this runbook, kept in the repo so a Claude Code session on the
MacBook can read it without needing the Obsidian vault. Written 2026-08-07, the day the
Apple Developer account was approved.

**Purpose: touch the Mac once, not five times.** Four separate pieces of Apple work all
need the same machine and the same person — Developer ID signing for the desktop app,
the App ID, the App Store distribution certificate, and the push key. They are needed
weeks apart. Produce all four in one sitting and the Mac stops being a repeated blocker.

## Who does what

| Jack | The agent |
|---|---|
| Every Keychain Access and developer.apple.com step | Verifying the result from the terminal |
| Creating and typing the `.p12` password | Never sees it, never asks for it |
| Creating the app-specific password | Never sees it |
| Pasting the five GitHub secrets | Editing `release.yml` afterwards |

**The agent must never ask Jack to paste a certificate, a password, or a token into the
chat.** Every credential goes from the Mac into GitHub's secret UI directly. The agent's
job is to check that the right thing was produced, not to handle it.

## Step 0 — preflight, do this first

```
xcodebuild -version
sw_vers
```

**Xcode must be 26.0 or newer.** Capacitor 8 will not build an iOS project below it.
The download is multiple GB and is the longest lead-time item in the launch, so if it is
older, start the upgrade before anything else in this document. If macOS itself is too
old to run Xcode 26, stop and say so — that is a decision, not a step.

## Step 1 — Developer ID Application certificate

This is what makes the macOS desktop build stop showing "unidentified developer".

1. **Keychain Access** → menu bar **Certificate Assistant** → *Request a Certificate From
   a Certificate Authority*. Enter the Apple ID email, leave CA Email blank, select
   **Saved to disk**. Produces a `.certSigningRequest` file.
2. developer.apple.com → **Certificates, Identifiers & Profiles** → Certificates → **+**
3. Choose **Developer ID Application**. Not "Apple Distribution" — that is App Store only
   and cannot sign a directly distributed DMG.
4. Upload the CSR, download the `.cer`, double-click to install it.
5. Confirm it landed — the agent can run this:
   ```
   security find-identity -v -p codesigning
   ```
   Expect a line reading `Developer ID Application: <name> (TEAMID)`.
6. Keychain Access → **My Certificates** → that identity → right-click → **Export** →
   `.p12`, set a password.
7. Base64 it:
   ```
   openssl base64 -A -in Certificates.p12 -out cert-base64.txt
   ```

Only the Apple Developer Program **Account Holder** can create this certificate. An
Admin or App Manager will not see the option.

## Step 2 — the other three, while already in the portal

- **App ID** — Identifiers → **+** → App IDs → App. Bundle ID **`app.ecliptr.mobile`**
  (decided 2026-08-07; permanent after first submission). Tick **Push Notifications** and
  **Associated Domains** now, even though both ship later — adding a capability afterwards
  means regenerating profiles.
- **Apple Distribution certificate** — same Certificates screen, same CSR. Needed to
  archive to App Store Connect.
- **APNs key** — Keys → **+** → Apple Push Notifications service. Download the `.p8`
  **once**; Apple will not offer it again. Note the Key ID.

## Step 3 — five GitHub secrets

`bjmdistributions/clienthub` → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | entire contents of `cert-base64.txt` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password from step 1.6 |
| `APPLE_ID` | the Apple ID email |
| `APPLE_PASSWORD` | an **app-specific** password from appleid.apple.com → Sign-In and Security. Not the account password. |
| `APPLE_TEAM_ID` | developer.apple.com/account → Membership |

**Do not create `APPLE_SIGNING_IDENTITY`.** Verified against tauri-bundler's source: with
the certificate and its password present, the identity is derived from the certificate.
Setting it manually only adds a way to fail.

## Step 4 — the workflow edit (agent, after step 3)

1. **Delete** the `Ad-hoc sign (macOS)` step in `.github/workflows/release.yml`. It sets
   `APPLE_SIGNING_IDENTITY=-`, which persists into the tauri-action step. With a real
   certificate present, tauri-bundler compares the two and hard-errors. It is not a
   fallback and must not be made conditional — it must go.
2. Add the five `APPLE_*` variables to the `Build Tauri app` step's `env:` block.
3. Leave `tauri-action@v0.5` alone. v1.0.0 removes `updaterJsonKeepUniversal` (in use)
   and changes `.app.tar.gz` filenames; bundling that with first-time signing would make
   any failure unattributable.

## Step 5 — prove it without shipping it

Push a tag **containing a hyphen**:

```
git tag v0.15.133-rc1 && git push origin v0.15.133-rc1
```

Since 2026-08-07 the workflow builds a hyphenated tag into a draft release and never
publishes it — no installed app can see it. This exists precisely for this test.

Why it matters: the last Developer ID attempt (`23b7284`, reverted by `a50baa2` the next
day) broke macOS for `v0.14.6`, `.7` and `.8`. Each one published looking healthy while
shipping Windows-only assets and a `latest.json` with no darwin keys, so every Mac
silently stopped receiving updates for three releases.

Download the DMG from the draft and check:

```
codesign -dv --verbose=4 /Applications/Ecliptr.app
spctl -a -vvv -t install /Applications/Ecliptr.app
xcrun stapler validate ~/Downloads/Ecliptr_0.15.133-rc1_universal.dmg
```

Then delete the draft release in the GitHub UI. Only after that does a real version tag
go out.

## The one unknown

Whether the notarized build needs an `Entitlements.plist`. Hardened runtime is already on
(Tauri defaults it to true and `tauri.conf.json` does not override it), and Tauri's docs
treat entitlements as opt-in. No primary source settles it for a WKWebView app.

**Do not add entitlements speculatively** — every extra entitlement weakens the hardened
runtime. Notarize with none, install the stapled DMG on a clean Mac, and only add a file
if it actually crashes at launch.

## Expected side effect

The app's code signature changes, so macOS will re-prompt for keychain access on first
launch of the notarized build. Approve it once. **Do not rename the keyring service** to
silence the prompt — that breaks credential lookup for existing installs.

`DEPLOY.md`'s "bypass Gatekeeper" section becomes wrong the day the first notarized build
ships, and should be rewritten in the same session.
