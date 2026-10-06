# MeetLoaf

A standalone macOS app for Google Meet — separate window, true OS-global hotkeys, and automatic routing of `meet.google.com` links from your browser and other apps (Slack, Mail, Calendar, etc.) into the app.

Three pieces:

1. **`app/`** — Electron app that wraps Meet, registers the `meet://` URL scheme, auto-grants camera/mic, and binds configurable global hotkeys.
2. **`extension/`** — Firefox WebExtension that intercepts `meet.google.com/xxx-yyyy-zzz` navigations and redirects to `meet://`.
3. **Velja** (third-party) — system URL router that catches meet links clicked from Slack/Mail/Calendar/etc. and sends them to MeetLoaf.

---

## For colleagues: install a pre-built release

MeetLoaf isn't signed by Apple or Microsoft, so **how you download it decides whether the OS argues with you.** Paste the one-liner for your platform and it won't.

### macOS

```sh
curl -L -o MeetLoaf.dmg https://github.com/shayredmond/meetloaf/releases/latest/download/MeetLoaf-mac-arm64.dmg
hdiutil attach MeetLoaf.dmg
cp -R /Volumes/MeetLoaf/MeetLoaf.app /Applications/
hdiutil detach /Volumes/MeetLoaf
open -a MeetLoaf
```

Or open the DMG in Finder and drag MeetLoaf across to the Applications shortcut — but see the Gatekeeper note below if you got the DMG from a browser.

No `xattr` step, and no Gatekeeper prompt. The quarantine flag that triggers the "MeetLoaf is damaged" error isn't a property of the app — it's added by whatever downloads it, and only apps that opt in (browsers, Slack, Mail) do. `curl` doesn't, so there's nothing to strip.

> **If you downloaded it through a browser instead**, the flag is there and macOS will refuse to open the app. Fix it with:
> ```sh
> xattr -dr com.apple.quarantine /Applications/MeetLoaf.app
> ```
> Or approve it in **System Settings → Privacy & Security**, where a blocked app shows an **Open Anyway** button shortly after you try to launch it. (Right-click → Open no longer works on macOS 15+; Apple removed that bypass.)

### macOS via Homebrew

If the tap is set up (see below), this is the least-friction route — and `brew upgrade` keeps you current, which matters because macOS can't auto-update itself yet:

```bash
brew install --cask shayredmond/tap/meetloaf --no-quarantine
```

`--no-quarantine` is required: MeetLoaf is ad-hoc signed rather than notarized, and Homebrew quarantines casks by default. Without it you'll get the same "damaged" error described above.

Later, `brew upgrade --cask meetloaf` picks up new releases.

### Windows 10/11

```powershell
Invoke-WebRequest -Uri https://github.com/shayredmond/meetloaf/releases/latest/download/MeetLoaf-Setup.exe -OutFile MeetLoaf-Setup.exe
.\MeetLoaf-Setup.exe
```

That installer carries both x64 and Arm64, so there's nothing to choose. It installs per-user — no admin — and registers the `meet://` handler. If you'd rather not download both architectures, `MeetLoaf-Setup-x64.exe` and `MeetLoaf-Setup-arm64.exe` are on the release page and roughly half the size.

Same idea as macOS: SmartScreen's *"Windows protected your PC"* warning is triggered by the Mark-of-the-Web, which browsers attach to downloads and `Invoke-WebRequest` doesn't.

> **If you downloaded it through a browser**, either click **More info → Run anyway**, or strip the mark first:
> ```powershell
> Unblock-File .\MeetLoaf-Setup.exe
> ```

MeetLoaf checks for updates on launch and from the **MeetLoaf → Check for Updates…** menu. What happens next depends on your platform:

- **Windows** downloads and installs. You're asked before the download starts and again before it restarts; decline the restart and it installs the next time you quit.
- **macOS** offers to open the release page, and you re-download by hand.

That split isn't an oversight. On macOS the updater drives Squirrel.Mac, which verifies the downloaded app's code signature before applying it — and MeetLoaf is ad-hoc signed, with no Apple Developer ID. That check can't be skipped, and shouldn't be: it's what stops an update being swapped in transit. Buying a Developer ID (§ *About signing*) is what unlocks macOS auto-update; the code is already there behind a platform check.

Once MeetLoaf is installed, follow **§2 Firefox extension** and **§3 Velja** below to wire link routing.

---

## Windows

MeetLoaf also runs on Windows 10/11 (x64 and Arm64). Download `MeetLoaf-Setup.exe` from the latest release — it covers both architectures — and run it — it installs per-user, no admin needed, and registers the `meet://` handler. See the install snippet at the top of this README for the download that avoids the SmartScreen warning.

The installer is **unsigned**, so SmartScreen shows *"Windows protected your PC"* on first run: click **More info → Run anyway**. That's the Windows counterpart of the `xattr` step above.

Differences from macOS:

- **Shortcuts** use Ctrl where macOS uses ⌘. Configs synced from a Mac keep working — `Cmd+…` bindings are read as `Ctrl+…` on Windows.
- **Tray icon** lives in the notification area (left-click toggles the window, right-click for the menu). Closing the window hides it there; quit from the tray menu.
- **Screen sharing** shows MeetLoaf's own picker (there's no OS picker on Windows), with an option to share system audio.
- **Link routing:** there's no Velja on Windows. Install the Firefox or Chrome/Edge extension in your default browser (Settings → Routing) — links clicked in Slack, Outlook etc. open in that browser, and the extension hands them to MeetLoaf.

Build locally with `cd app && npm install && npm run dist:win` → `app/dist/MeetLoaf-Setup-<arch>.exe`. For `npm start` on Windows, run `npm run icon:win` once first so the tray icon exists.

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
    "newMeeting": "Cmd+Shift+N",
    "leave": { "accelerator": "Cmd+W", "global": false }
  },
  "window": { "width": 1200, "height": 800 }
}
```

**Start instant meeting** creates a meeting and puts its link on your clipboard, ready to paste. It's unbound by default; bind it to something global and you can spin up a call from any app. It works by loading `meet.google.com/new` and reading the meeting URL Meet redirects to — no clicking around Meet's UI, so it doesn't break when Meet moves a button. Pressed while you're already in a call it does nothing, rather than navigating away and hanging up on you.

**Leave meeting** is bound to `⌘W` out of the box. It's local-only (not global) on purpose — a global `⌘W` would hijack window-close everywhere, so it only hangs up while MeetLoaf is focused. Clear or rebind it in Settings like any other shortcut.

Hand-edits use [Electron's accelerator syntax](https://www.electronjs.org/docs/latest/api/accelerator). Each shortcut is `{ "accelerator": "…", "global": true|false }`; a bare string is treated as a global binding. Empty string = unbound. Restart the app after hand-editing.

> **Note on Picture-in-Picture:** Meet's own *More options → Picture-in-picture* doesn't work inside MeetLoaf. It relies on the Document Picture-in-Picture API, which Electron doesn't render ([electron#39633](https://github.com/electron/electron/issues/39633)). The older per-video `requestPictureInPicture` API is wired up in Electron and renders for an ordinary video, but on Meet's remote WebRTC tiles it surfaces no window and the request never completes (the meeting keeps working — it doesn't crash). Both were tested and ruled out — MeetLoaf has no PiP. Use always-on-top (Settings → Window) to keep the call visible instead.

> **Note on the presentation pop-out (0.1.6, removed in 0.1.7):** a version that auto-detected a remote participant's screen share and split it into its own window shipped briefly and was pulled. The window mechanism itself worked — a `window.open()` popup from the Meet page is same-origin and shares its renderer, so the `<video>` inside it can take Meet's own `MediaStream` by reference, no re-capture needed. What didn't work was *detection*: inferring "this tile is a screen share" from generic video properties (`object-fit`, resolution, aspect ratio, relative tile size) produced false positives on join and wasn't reliable in practice. Anyone revisiting this should start by finding a stable marker in Meet's own markup rather than scoring heuristics.

### Setting up the Homebrew tap (one-time)

The cask lives at [`packaging/homebrew/meetloaf.rb`](packaging/homebrew/meetloaf.rb) in this repo, and `.github/workflows/homebrew.yml` renders it into a tap whenever a release is **published**. Three things have to exist before it does anything:

1. **A tap repository** named `homebrew-tap` under your account — the `homebrew-` prefix is what lets `brew install --cask shayredmond/tap/meetloaf` resolve. It can be empty; the workflow creates `Casks/meetloaf.rb` and a README on first run.
   ```bash
   gh repo create shayredmond/homebrew-tap --public --description "Homebrew tap for MeetLoaf"
   ```
2. **A `tap-publish` environment** on this repo, which is what the deploy key is scoped to:
   ```bash
   gh api -X PUT repos/shayredmond/meetloaf/environments/tap-publish
   ```
   Add a **required reviewer** to it under Settings → Environments if you want each tap push to wait for your approval. Worth considering: this credential can change what `brew install` delivers to everyone using the tap, and an approval gate means a modified workflow can't use it unattended.
3. **A deploy key**, held as an environment secret. A deploy key is scoped to one repository by construction and never expires, so there's no renewal to forget:
   ```bash
   ssh-keygen -t ed25519 -f meetloaf-tap -N "" -C "meetloaf release -> homebrew-tap"
   gh repo deploy-key add meetloaf-tap.pub --repo shayredmond/homebrew-tap --title "meetloaf release" --allow-write
   gh secret set TAP_DEPLOY_KEY --repo shayredmond/meetloaf --env tap-publish < meetloaf-tap
   rm meetloaf-tap meetloaf-tap.pub
   ```
   The private key goes from the file straight into the secret and both files are deleted, so it never appears on screen or in shell history.

Without the secret the workflow still runs and renders the cask, then logs that it skipped publishing — so nothing breaks for anyone who hasn't set a tap up.

It deliberately triggers on *published*, not on the tag build: releases are created as drafts, and a cask pointing at a draft's download URL would 404 for everyone until you pressed Publish. Set `TAP_REPO` as a repository variable to point somewhere other than `shayredmond/homebrew-tap`.

**On log exposure:** the key is written to a file and is never an argument to git. A token embedded in an HTTPS remote URL can surface in git's own error messages; an SSH remote carries no credential at all. Actions masks secrets either way, but this repo's logs are public, so the smaller surface matters. GitHub's SSH host key is pinned from `api.github.com/meta` rather than accepted trust-on-first-use.

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
3. CI (`.github/workflows/release.yml`) builds both platforms in parallel — the arm64 DMG on `macos-14`, the x64 + arm64 installers on `windows-latest` — then a separate `release` job collects both into a GitHub Release named `v0.2.0`.
4. **The release is created as a draft.** Nothing is public yet. Open it under [Releases](https://github.com/shayredmond/meetloaf/releases), download the DMG and the installers, check they run, then press **Publish release**.

Step 4 is the point of no return, and the only one that reaches your colleagues — the update checker reads `/releases/latest`, which excludes drafts. If something's wrong, delete the draft and the release never existed. Merging a PR does none of this: only a `v*` tag starts a release at all.

The same workflow runs on every pull request, building both platforms and uploading them as workflow artifacts without publishing anything. That's deliberate: a Windows build problem should surface on the PR, not halfway through cutting a release. Only a `v*` tag reaches the `release` job, and only that job gets a write-scoped token.

The release job refuses to run if the tag and `app/package.json` disagree — tagging `v0.2.0` against a `0.1.9` package.json would otherwise prompt everyone to upgrade to a build reporting the version they already have, and keep prompting forever.

Once you publish, colleagues on older versions get prompted by MeetLoaf's update checker within 5 seconds of next launch.

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
   This calls `web-ext sign --channel=unlisted` (signed by Mozilla, not listed publicly), then drops the resulting `.xpi` into `app/firefox-extension.xpi`. **Commit that file** — see the note below. Bump `version` in `extension/manifest.json` before each re-sign; AMO rejects a version it has already seen for this add-on ID.
3. Rebuild the desktop app:
   ```sh
   cd ../app && npm run dist
   ```
   The XPI is now bundled inside `MeetLoaf.app`.

### For colleagues

Open MeetLoaf → **Settings (⌘,) → Routing → Install**. MeetLoaf detects Firefox in `/Applications`, opens the bundled XPI in it, and Firefox shows its standard "Add MeetLoaf Router?" prompt. One click.

Re-sign + redistribute the app whenever the extension code changes — the signed XPI carries a version that has to match what's published.

> **The add-on ID changed** to `meetloaf@shayredmond.github.io`. AMO identifies an add-on by that ID, so this counts as a brand-new add-on: the first `./build.sh` after this creates a fresh unlisted listing, and `app/firefox-extension.xpi` has to be regenerated before the bundled installer works again. Anyone running the old extension keeps it until they install the new one — worth having them remove the old one, or both will try to route the same links.

> **Commit the signed XPI.** `app/firefox-extension.xpi` is tracked on purpose, even though it's a build artifact. CI builds the app from a clean checkout and never runs `extension/build.sh`, so an uncommitted XPI means every published release ships without the extension and **Settings → Routing → Install** reports it as missing. Sign, commit the `.xpi`, then tag.

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

The first Meet link you click shows the browser's *"Open MeetLoaf?"* prompt — tick **Always allow** and click **Open**. From then on links go straight to MeetLoaf, and the hand-off tab closes itself after a 10-second countdown (or goes back, if you clicked the link from another page) — **Close now** skips the wait. **Join in the browser instead** on the hand-off tab lets that one tab load Meet normally.

How it works: a `declarativeNetRequest` rule redirects `meet.google.com/xxx-yyyy-zzz` to the extension's `handoff.html` *before the request is sent*, so the Meet page never loads in the browser and never grabs the camera/mic. (An earlier version reacted to `webNavigation.onBeforeNavigate`, which can't cancel the navigation — the call opened in both the browser and MeetLoaf.)

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

By default, **the earliest point MeetLoaf can tell you're in a meeting**. Usually that's reaching the waiting room — the pre-join screen where you pick your camera and mic. That's deliberate: these automations are usually *preparation* (camera on, lights up, mic switched over), so they have to have run by the time you're configuring devices, not after.

Where there's no waiting room, it fires on connection instead. Starting a meeting with the **New** button or a `meet://new` link drops you straight into the call, and the join still fires — just at the moment you connect rather than a few seconds earlier. You lose the head start, never the event.

The meeting code alone can't tell these apart — it's in the URL for every screen — so MeetLoaf reads Meet's own controls and distinguishes three phases:

| Phase       | Detected by                              | Counts as "in a meeting"?     |
|-------------|------------------------------------------|-------------------------------|
| `lobby`     | a *Join now* / *Ask to join* button       | yes (default), no in Connected mode |
| `in_call`   | the *Leave call* control                  | yes                           |
| `post_call` | a *Rejoin* / *Return to home screen* button | **no**                      |

That third row is the one that matters most: after you hang up, Meet leaves you on a "You left the meeting" screen **still at the meeting URL**. It's counted as *not* in a meeting, so your leave automation runs and nothing is left switched on.

Anything MeetLoaf doesn't recognise counts as *not* in a meeting. That direction is chosen on purpose — if Meet renames a label, the worst case is an automation that doesn't fire, never a camera or light left on indefinitely.

**Fire "join" when** in Settings switches between `Waiting room` (default) and `Connected only`. The two aren't alternatives so much as a floor: `Waiting room` means *waiting room or connection, whichever comes first*, while `Connected only` suppresses the waiting-room case entirely. Pick `Connected only` for something that shouldn't announce you early, like an on-air sign.

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
- **Shortcuts don't fire:** some accelerators are taken by macOS/other apps. Check `Console.app` for "Shortcut unavailable" warnings, or pick different bindings. Bindings on punctuation keys (`` ` ``, `-`, `[`, `;`, `/`, …) recorded before 0.2.3 were written in a form Electron rejects and never registered; 0.2.3 translates them on load, so they start working without re-recording.
- **Mic/camera button clicks do nothing:** Meet occasionally changes aria-labels. Open DevTools (View → Toggle Developer Tools) and inspect the button.
- **Firefox extension doesn't redirect:** confirm it's enabled (toolbar icon has no "off" badge); confirm `about:config` → `network.protocol-handler.external.meet` is `true`.
- **Firefox "Launch Application" dialog every link:** tick "Remember my choice" the first time.
- **Velja doesn't see MeetLoaf:** MeetLoaf has to be in `/Applications` and launched at least once for Velja to find it.
- **Home Assistant never fires and Settings → Test reports a connection error (macOS):** if Home Assistant is on your LAN, macOS is probably blocking MeetLoaf's local network access. Check **System Settings → Privacy & Security → Local Network**. An app that has never successfully asked doesn't appear in that list at all, so *absent* is as much a failure as *switched off* — reinstalling a build that declares `NSLocalNetworkUsageDescription` (0.2.2 and later) makes macOS prompt properly. Running MeetLoaf from a terminal masks this entirely, because it inherits the terminal's own grant — so "it works when I launch it from the shell" is a symptom, not a workaround.
- **Home Assistant automation never fires, but MeetLoaf says it sent:** check the automation's own *conditions* before suspecting MeetLoaf. In Home Assistant, open the automation → **Traces**; `execution: failed_conditions` means the webhook arrived and your automation stopped itself. A gate like "only when I'm in the room" will do this silently.
- **Home Assistant automation never fires:** hit **Test** in Settings → Home Assistant — it reports the real HTTP status. `404` on a webhook means the ID is wrong or the automation was deleted; `401`/`403` in service-call mode means the token is bad. Also check the integration is actually **Enabled**.
- **Home Assistant fires late, at connection instead of the waiting room:** that meeting had no waiting room — starting one with **New** or `meet://new` goes straight in. The event still fires; only the head start is lost.
- **Home Assistant doesn't fire at the waiting room:** check **Fire "join" when** is set to `Waiting room`. If it still doesn't, Meet has probably renamed the pre-join button — open DevTools (View → Toggle Developer Tools) and look for `[meetloaf] phase:` lines. `unknown` where you expected `lobby` means the label changed; the patterns are at the top of the call-phase watcher in `app/main-inject.js`.
- **Something stays switched on after I hang up:** MeetLoaf should read Meet's post-hangup screen as `post_call` and fire leave. Check DevTools for `[meetloaf] phase: post_call`; if it says `unknown`, the *Rejoin* / *Return to home screen* labels changed.
- **Update checker never prompts:** confirm `repository.url` in `app/package.json` points to a real GitHub repo (not `OWNER/REPO`).
