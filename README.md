# MeetLoaf

A standalone macOS app for Google Meet — separate window, true OS-global hotkeys, and automatic routing of `meet.google.com` links from your browser and other apps (Slack, Mail, Calendar, etc.) into the app.

Three pieces:

1. **`app/`** — Electron app that wraps Meet, registers the `meet://` URL scheme, auto-grants camera/mic, and binds configurable global hotkeys.
2. **`extension/`** — Firefox WebExtension that intercepts `meet.google.com/xxx-yyyy-zzz` navigations and redirects to `meet://`.
3. **Velja** (third-party) — system URL router that catches meet links clicked from Slack/Mail/Calendar/etc. and sends them to MeetLoaf.

---

## For colleagues: install a pre-built release

If someone else has already run the release pipeline and published a DMG:

```sh
# Download + install + strip quarantine attr (so Gatekeeper doesn't block it)
curl -LO https://github.com/OWNER/REPO/releases/latest/download/MeetLoaf.dmg
hdiutil attach MeetLoaf.dmg
cp -R /Volumes/MeetLoaf/MeetLoaf.app /Applications/
xattr -dr com.apple.quarantine /Applications/MeetLoaf.app
hdiutil detach /Volumes/MeetLoaf
open -a MeetLoaf
```

> **Why `xattr -dr com.apple.quarantine`?** The app is ad-hoc signed, not notarized (no Apple Developer ID). Without this, macOS Gatekeeper will refuse to launch it with a vague "damaged" error on macOS 15+. Stripping the quarantine flag tells macOS "I trust this file." Alternative: right-click → Open once, then System Settings → Privacy & Security → "Open Anyway."

MeetLoaf checks for updates on launch (and from the **MeetLoaf → Check for Updates…** menu). It won't auto-install — it just pings the GitHub Releases API, and if a newer tag exists, offers to open the release page.

Once MeetLoaf is installed, follow **§2 Firefox extension** and **§3 Velja** below to wire link routing.

---

## For you (developer): build and publish

### Prereqs

```sh
brew install librsvg node
```

Node 20+ recommended.

### One-time setup

Update `app/package.json`'s `repository.url` to the real GitHub repo. Without this, the in-app update checker silently does nothing.

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/YOURNAME/MeetLoaf.git"
}
```

### Local dev loop

```sh
cd app
npm install
npm start           # launches MeetLoaf against dev Electron
```

Global hotkeys, camera/mic, and `meet://` handoff all work in dev. The only thing that requires a packaged `.app` in `/Applications` is the OS registering MeetLoaf as the default `meet://` handler for *other* apps.

### Configure hotkeys

Open **MeetLoaf → Settings…** (`⌘,`). Click any shortcut field and press the key combo you want — Raycast-style live recording. `⌫` clears, `Esc` cancels. Saves automatically on each change and re-registers global shortcuts immediately.

Under the hood it writes `~/.config/meetloaf/config.json` (or `$XDG_CONFIG_HOME/meetloaf/config.json` if you've set that), which you can also hand-edit if you prefer — and easily back up via your dotfiles manager:

```json
{
  "shortcuts": {
    "mute": "Cmd+Shift+M",
    "camera": "Cmd+Shift+V",
    "hand": "Cmd+Shift+H",
    "toggleWindow": "Cmd+Shift+Backslash",
    "leave": { "accelerator": "Cmd+W", "global": false }
  },
  "window": { "width": 1200, "height": 800 }
}
```

**Leave meeting** is bound to `⌘W` out of the box. It's local-only (not global) on purpose — a global `⌘W` would hijack window-close everywhere, so it only hangs up while MeetLoaf is focused. Clear or rebind it in Settings like any other shortcut.

Hand-edits use [Electron's accelerator syntax](https://www.electronjs.org/docs/latest/api/accelerator). Each shortcut is `{ "accelerator": "…", "global": true|false }`; a bare string is treated as a global binding. Empty string = unbound. Restart the app after hand-editing.

> **Note on Picture-in-Picture:** Meet's own *More options → Picture-in-picture* doesn't work inside MeetLoaf. It relies on the Document Picture-in-Picture API, which Electron doesn't render ([electron#39633](https://github.com/electron/electron/issues/39633)). The older per-video `requestPictureInPicture` API is wired up in Electron and renders for an ordinary video, but on Meet's remote WebRTC tiles it surfaces no window and the request never completes (the meeting keeps working — it doesn't crash). Both were tested and ruled out — MeetLoaf has no PiP. Use always-on-top (Settings → Window) to keep the call visible instead.

> **Note on the presentation pop-out (0.1.6, removed in 0.1.7):** a version that auto-detected a remote participant's screen share and split it into its own window shipped briefly and was pulled. The window mechanism itself worked — a `window.open()` popup from the Meet page is same-origin and shares its renderer, so the `<video>` inside it can take Meet's own `MediaStream` by reference, no re-capture needed. What didn't work was *detection*: inferring "this tile is a screen share" from generic video properties (`object-fit`, resolution, aspect ratio, relative tile size) produced false positives on join and wasn't reliable in practice. Anyone revisiting this should start by finding a stable marker in Meet's own markup rather than scoring heuristics.

### Build a DMG locally

```sh
cd app
npm run icon        # SVG → icon.icns
npm run dist        # arm64 .app, ad-hoc sign, wrap in DMG
```

Output: `app/dist/MeetLoaf-<version>.dmg`

Drop that file into Slack / Drive / wherever and colleagues can use the install snippet at the top of this README.

### Publish a release via GitHub Actions

1. Bump `version` in `app/package.json` (e.g. `0.1.0` → `0.2.0`).
2. Commit, tag, push:
   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. CI (`.github/workflows/release.yml`) builds the DMG on a `macos-14` runner (Apple Silicon) and attaches it to a GitHub Release named `v0.2.0`.

Colleagues on older versions get prompted by MeetLoaf's update checker within 5 seconds of next launch.

### About signing

We ad-hoc sign (`codesign --sign -`). That's enough to satisfy Apple Silicon's "must be signed to execute" rule, but **not** notarized, so macOS shows a Gatekeeper prompt on first launch until the user strips the quarantine attr. Upgrading to a Developer ID cert + notarization later is a one-line change in `app/scripts/build-dmg.sh` — swap `-` for the cert identity and add an `xcrun notarytool submit` step.

---

## 2. Firefox extension

Best path for a permanent install: bundle a signed XPI inside MeetLoaf so colleagues can install it from **Settings → Routing → Install**.

### One-time setup (developer)

1. Get an AMO API key at https://addons.mozilla.org/developers/addon/api/key/.
2. Sign + bundle:
   ```sh
   cd extension
   export WEB_EXT_API_KEY='user:xxxxxxx:xx'
   export WEB_EXT_API_SECRET='hex...'
   ./build.sh
   ```
   This calls `web-ext sign --channel=unlisted` (signed by Mozilla, not listed publicly), then drops the resulting `.xpi` into `app/firefox-extension.xpi`.
3. Rebuild the desktop app:
   ```sh
   cd ../app && npm run dist
   ```
   The XPI is now bundled inside `MeetLoaf.app`.

### For colleagues

Open MeetLoaf → **Settings (⌘,) → Routing → Install**. MeetLoaf detects Firefox in `/Applications`, opens the bundled XPI in it, and Firefox shows its standard "Add MeetLoaf Router?" prompt. One click.

Re-sign + redistribute the app whenever the extension code changes — the signed XPI carries a version that has to match what's published.

### Alternative — temporary load (no signing)

For a quick test without going through AMO:

1. Open `about:debugging#/runtime/this-firefox`
2. *Load Temporary Add-on…* → pick `extension/manifest.json`

(Resets when you restart Firefox.)

## 2b. Chrome / Chromium extension (Arc, Brave, Edge, Vivaldi, etc.)

Chrome blocks `.crx` side-loading, so for personal-use extensions you either submit to the Chrome Web Store (~$5 one-time, public/unlisted listing) or load the unpacked source. MeetLoaf bundles the source and points the user at it.

### For colleagues

Settings (⌘,) → **Routing** → next to "Chrome / Chromium extension":

1. Click **Open extensions** — your browser opens `chrome://extensions`.
2. Toggle **Developer mode** (top-right of that page).
3. Click **Show folder** in MeetLoaf — Finder opens with the extension folder selected.
4. Drag the folder onto the extensions page, or click **Load unpacked** and select it.

The extension is now active. Toggle it via the puzzle-piece icon in your browser's toolbar.

### Submitting to the Chrome Web Store (optional, one-click flow)

If you'd rather have a single-click install for colleagues:

1. Pay the one-time $5 Chrome Web Store developer fee
2. Zip the `extension-chrome/` folder, submit as an *unlisted* item
3. ~1 day review, then you have a permanent install URL
4. Replace MeetLoaf's "Open extensions / Show folder" buttons with `shell.openExternal('https://chromewebstore.google.com/detail/...')`

---

### Alternative — sign manually

Get API credentials at https://addons.mozilla.org/developers/addon/api/key/, then:

```sh
cd extension
npx web-ext sign --api-key=$AMO_JWT_ISSUER --api-secret=$AMO_JWT_SECRET --channel=unlisted
```

This produces a signed `.xpi` in `web-ext-artifacts/` — drag it into Firefox to install permanently.

Click the toolbar icon to toggle routing on/off.

## 3. Velja (system URL router)

```sh
brew install --cask velja
```

Open Velja → Preferences:

1. Set Velja as the default browser (Velja prompts for this).
2. Set your **default browser fallback** to Firefox.
3. Add a **Browser Rule**:
   - Match: host equals `meet.google.com`
   - Open in: `MeetLoaf`

Now a meet link clicked from anywhere (Slack, Mail, Fantastical, Terminal, ...) goes through Velja → MeetLoaf.

---

## How the pieces fit

| Link source                                 | Caught by | Path to MeetLoaf                               |
|---------------------------------------------|-----------|------------------------------------------------|
| Click inside Firefox                        | Extension | `meet.google.com/...` → `meet://...`           |
| Click in Slack / Mail / Calendar / Terminal | Velja     | Velja rule routes `meet.google.com` → MeetLoaf |
| Direct `meet://` URL                        | MeetLoaf  | Native URL scheme handler                      |

If you're already in a meeting when a new `meet://` link arrives, MeetLoaf prompts you before switching.

## 4. Home Assistant (meeting automations)

MeetLoaf can fire a Home Assistant automation the moment you **join** a meeting, and another when you **leave** — "on air" sign, desk lamp, do-not-disturb, whatever you've got.

Configure it in **Settings → Home Assistant**.

### What counts as "joined"

By default, **reaching the waiting room** — the pre-join screen where you pick your camera and mic. That's deliberate: these automations are usually *preparation* (camera on, lights up, mic switched over), so they have to have run by the time you're configuring devices, not after.

The meeting code alone can't tell these apart — it's in the URL for every screen — so MeetLoaf reads Meet's own controls and distinguishes three phases:

| Phase       | Detected by                              | Counts as "in a meeting"?     |
|-------------|------------------------------------------|-------------------------------|
| `lobby`     | a *Join now* / *Ask to join* button       | yes (default), no in Connected mode |
| `in_call`   | the *Leave call* control                  | yes                           |
| `post_call` | a *Rejoin* / *Return to home screen* button | **no**                      |

That third row is the one that matters most: after you hang up, Meet leaves you on a "You left the meeting" screen **still at the meeting URL**. It's counted as *not* in a meeting, so your leave automation runs and nothing is left switched on.

Anything MeetLoaf doesn't recognise counts as *not* in a meeting. That direction is chosen on purpose — if Meet renames a label, the worst case is an automation that doesn't fire, never a camera or light left on indefinitely.

**Fire "join" when** in Settings switches between `Waiting room` (default) and `Connected`. Pick `Connected` for something that shouldn't announce you early, like an on-air sign.

Leave also fires on navigating away from the meeting, on a renderer crash, and on quitting MeetLoaf mid-call. A phase change has to hold briefly before it commits (400ms entering, 2s leaving) so Meet's DOM churn during a reconnect can't run your automations twice.

Note that always-on-top (Settings → Window) is unaffected by this setting — it still engages only once you're actually connected, never in the waiting room.

### Webhook mode (default, recommended)

No credentials. In Home Assistant, create an automation with a **Webhook** trigger, then paste its webhook ID into MeetLoaf.

```yaml
# Home Assistant automation
alias: Meeting started
triggers:
  - trigger: webhook
    webhook_id: meetloaf-joined
    local_only: true          # drop this if you're going via Nabu Casa
actions:
  - action: light.turn_on
    target:
      entity_id: light.on_air_sign
```

MeetLoaf `POST`s JSON, so the automation can see the details:

```json
{
  "event": "join",
  "app": "meetloaf",
  "version": "0.1.5",
  "meeting_code": "abc-defg-hij",
  "url": "https://meet.google.com/abc-defg-hij",
  "timestamp": "2026-08-23T10:04:11.482Z",
  "phase": "lobby",
  "reason": "dom"
}
```

Reachable as `{{ trigger.json.event }}`, `{{ trigger.json.meeting_code }}`, and so on — which means one webhook can serve both events if you'd rather branch inside HA than use two automations.

`phase` is the phase that triggered it — `lobby`, `in_call`, `post_call` or `away` — so one automation can do less at the waiting room and more once you're actually connected.

`reason` says what detected the transition: `dom` (a control appeared/disappeared), `navigation` (left the meeting URL), `poll` (main's backstop timer), `quit` (you quit MeetLoaf mid-call), `renderer-gone` (the Meet page crashed). Useful if you want "turn the lamp off, but only if I actually hung up".

Paste either a bare webhook ID (combined with **Base URL**) or a full webhook URL — handy for a [Nabu Casa cloud webhook](https://www.nabucasa.com/config/webhooks/), which gives you a public URL with no port forwarding.

### Service-call mode

If you'd rather trigger an entity you already have, switch to **Service call**, supply a base URL and a [long-lived access token](https://www.home-assistant.io/docs/authentication/#your-account-profile), and give an entity ID. The service is derived from the domain:

| Entity domain                                   | On join    | On leave    |
|-------------------------------------------------|------------|-------------|
| `automation`                                    | `trigger`  | `trigger`   |
| `script`, `scene`                               | `turn_on`  | `turn_on`   |
| `input_boolean`, `switch`, `light`, `fan`, `siren` | `turn_on`  | `turn_off`  |

That last row means a single `input_boolean.in_a_meeting` helper mirrors your call state, which is usually nicer to build automations against than two one-shot triggers.

> **Why webhook is the default:** `config.json` lives in `~/.config/meetloaf/` precisely so your dotfiles manager can track it. A long-lived access token in that file grants full API access to your whole Home Assistant instance — a webhook ID only triggers the one automation, and you can revoke it by deleting the trigger. Service-call mode is there when you want it; just know what you're committing.

### Notes

- The **Test** buttons in Settings send a real request (with `"test": true` in the payload) and report the HTTP status or the exact error, so you can verify before your next meeting.
- Requests time out after 5s and retry once on a 5xx or a network error. `4xx` isn't retried — it means the ID or token is wrong.
- Failures are logged, never shown as a dialog. A smart-home hook going quiet must not interrupt a call. Check `Console.app` (or run from a terminal) for `[meetloaf] Home Assistant … failed` lines.
- Requests go out from the app's main process via Node, which uses its own CA store — a Home Assistant behind a **self-signed** certificate will be rejected. Use plain `http://` on your LAN, or a real certificate.

---

## Troubleshooting

- **"MeetLoaf is damaged and can't be opened"** on first launch: run `xattr -dr com.apple.quarantine /Applications/MeetLoaf.app`. See the install snippet at the top.
- **Shortcuts don't fire:** some accelerators are taken by macOS/other apps. Check `Console.app` for "Shortcut unavailable" warnings, or pick different bindings.
- **Mic/camera button clicks do nothing:** Meet occasionally changes aria-labels. Open DevTools (View → Toggle Developer Tools) and inspect the button.
- **Firefox extension doesn't redirect:** confirm it's enabled (toolbar icon has no "off" badge); confirm `about:config` → `network.protocol-handler.external.meet` is `true`.
- **Firefox "Launch Application" dialog every link:** tick "Remember my choice" the first time.
- **Velja doesn't see MeetLoaf:** MeetLoaf has to be in `/Applications` and launched at least once for Velja to find it.
- **Home Assistant automation never fires:** hit **Test** in Settings → Home Assistant — it reports the real HTTP status. `404` on a webhook means the ID is wrong or the automation was deleted; `401`/`403` in service-call mode means the token is bad. Also check the integration is actually **Enabled**.
- **Home Assistant doesn't fire at the waiting room:** check **Fire "join" when** is set to `Waiting room`. If it still doesn't, Meet has probably renamed the pre-join button — open DevTools (View → Toggle Developer Tools) and look for `[meetloaf] phase:` lines. `unknown` where you expected `lobby` means the label changed; the patterns are at the top of the call-phase watcher in `app/main-inject.js`.
- **Something stays switched on after I hang up:** MeetLoaf should read Meet's post-hangup screen as `post_call` and fire leave. Check DevTools for `[meetloaf] phase: post_call`; if it says `unknown`, the *Rejoin* / *Return to home screen* labels changed.
- **Update checker never prompts:** confirm `repository.url` in `app/package.json` points to a real GitHub repo (not `OWNER/REPO`).
