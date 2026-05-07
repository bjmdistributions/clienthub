# Deploy

How to ship ClientHub to your devices. This is the human's runbook — agents do not run deploys.

---

## Architecture summary

- **3 devices:** 1 PC (initial dev) + 2 Macs
- **Distribution:** GitHub Actions builds `.msi` + `.dmg` on every release tag, free
- **Updates:** Tauri auto-updater pulls from GitHub Releases (after TASK-007 complete)
- **Email:** Google Workspace (paid, ~$6/mo) — your business address as sender
- **Sync:** Syncthing P2P between the 3 devices, free
- **AI:** Ollama running locally on each device, free
- **Code-signing:** Skipped (no Apple Developer ID, no Windows EV cert) — first-launch warnings handled below

**Total recurring cost:** ~$6/mo for Google Workspace. Nothing else.

---

## One-time setup

### Step 1 — Get a domain identifier

Pick a reverse-DNS identifier for the app. Examples: `com.yourbusiness.clienthub`, `io.firstnamelastname.clienthub`. This goes in `tauri.conf.json` and affects:
- macOS keychain namespace
- Windows registry entries
- App data directory location

**Have an agent run TASK-002 with your chosen identifier.**

### Step 2 — Generate icons

Make a 1024×1024 PNG of your app icon (transparent background recommended). Save it as `src-tauri/icons/icon.png`.

**Have an agent run TASK-001.**

### Step 3 — Set up Google Workspace

1. Sign up at [workspace.google.com](https://workspace.google.com), use your domain
2. Enable 2FA on the account
3. Generate an App Password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
4. Save the 16-character password — you'll paste it into ClientHub Settings on first launch

**Or** use the OAuth2 flow once TASK-004 is complete (cleaner, more secure long-term).

### Step 4 — Push to GitHub

1. Create a private GitHub repo (free, unlimited)
2. Push the code:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin git@github.com:yourname/clienthub.git
   git push -u origin main
   ```

The `.github/workflows/release.yml` will trigger on tag pushes.

### Step 5 — First release build

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions will:
1. Build `.msi` on a Windows runner (~7 min)
2. Build a universal `.dmg` (Intel + Apple Silicon) on a Mac runner (~10 min)
3. Create a draft release with both files attached

Go to GitHub → your repo → Releases → find the draft → click **Publish release**.

---

## Per-device installation

### On each Mac

1. Download the `.dmg` from the GitHub release
2. Open it, drag ClientHub to Applications
3. **First launch:** right-click ClientHub in Applications → **Open** → **Open** (one-time only)
   - This bypasses Gatekeeper for unsigned apps. Subsequent launches just work.
4. In ClientHub:
   - **Settings → Email:** paste your `you@yourbusiness.com` and the app password (or use OAuth2 button)
   - **Settings → Company:** fill in business info that goes on invoices
   - **Settings → AI:** confirm Ollama is running, pick a model

Install Ollama: `brew install ollama && ollama serve` (in one terminal) and `ollama pull llama3.1:8b` (in another).

### On the PC

1. Download the `.msi` from the GitHub release
2. Run it. Windows SmartScreen will warn — click **More info** → **Run anyway**
3. Same Settings setup as Macs.

Install Ollama: download from [ollama.com](https://ollama.com), run, then `ollama pull llama3.1:8b` from PowerShell.

### Set up Syncthing on all 3 devices

1. Install [Syncthing](https://syncthing.net/downloads/) on each
2. On the **PC** (or whichever device has the most up-to-date data):
   - Add a folder pointing to:
     ```
     %APPDATA%\<your.identifier>\sync\
     ```
   - Note the folder ID it generates
3. On each **Mac**:
   - Add the same folder ID, point it to:
     ```
     ~/Library/Application Support/<your.identifier>/sync/
     ```
4. In Syncthing on each device, share the folder with the other two by their device IDs (Syncthing UI walks you through this)

Within a few minutes, all three devices have identical sync state. Going forward, every change made on any device propagates to the other two automatically.

---

## Issuing updates

Once TASK-007 (auto-updater) is complete:

1. Bump version in `package.json` and `src-tauri/Cargo.toml`
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`
3. GitHub Actions builds and publishes a release
4. All 3 devices receive an update prompt within 24h
5. User clicks "Update", app installs and relaunches

Until TASK-007 is complete, repeat the per-device installation flow.

---

## What can go wrong (and what to do)

### Mac: "ClientHub is damaged and can't be opened"
This means the ad-hoc signing didn't apply. Run in Terminal:
```bash
xattr -cr /Applications/ClientHub.app
```
Then launch normally.

### Mac: First launch is rejected even with right-click → Open
Newer macOS versions sometimes require:
1. System Settings → Privacy & Security
2. Scroll to bottom: "ClientHub was blocked..." → click **Open Anyway**

### Windows: SmartScreen blocks every launch
Add the `.msi`'s install directory (typically `C:\Program Files\ClientHub\`) to Windows Defender's exclusions. Or accept the one-time "Run anyway" each install — it's not blocked after install completes.

### Sync isn't propagating
1. In Syncthing UI on all devices, confirm the folder shows green ("Up to Date")
2. Verify all three devices show each other as "Connected"
3. Check that the folder paths are correct (the sync folder must exist before Syncthing can watch it — start ClientHub once on each device first)
4. In ClientHub: Settings → Sync → "Replay All Events" forces a fresh scan

### Ollama isn't reachable
- Mac/Linux: `ollama serve` in a terminal, leave it running
- Windows: Ollama installs as a service that auto-starts; verify in Task Manager → Services
- Test: open `http://localhost:11434/api/tags` in a browser, should return JSON

### Email send fails with auth error
- App Password: regenerate at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) and update Settings → Email
- OAuth2: refresh token may be revoked if account password changed; re-run TASK-004 flow

---

## Backup strategy

Your sync folder **is** your backup, but only if Syncthing is healthy on at least 2 devices. For an extra layer:

1. Periodically zip `<app_data_dir>/clienthub.db` and store it in iCloud/Dropbox
2. The DB can be restored to any device — just close ClientHub, replace the file, reopen
3. After restore on a single device, run "Replay All Events" to reconstruct from sync log

---

## Cost summary (final)

| Item | Recurring cost |
|------|---------------|
| Google Workspace | ~$6/mo |
| GitHub | $0 (private repos free) |
| GitHub Actions | $0 (within 2,000 min/mo private repo allotment) |
| Syncthing | $0 |
| Ollama + models | $0 (local) |
| Code-signing | $0 (skipped) |
| Domain (already owned for Workspace) | $0 incremental |
| **Total** | **~$6/mo** |

vs. equivalent SaaS bundle (HubSpot Starter $20 + QuickBooks $30 + Zapier $20 + Loom $15 = ~$85/mo). Net savings: ~$950/yr.
