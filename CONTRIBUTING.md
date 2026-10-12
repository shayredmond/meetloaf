# Contributing to MeetLoaf

Thanks for helping. Bug reports, fixes and platform testing are all welcome.

## Running it locally

```sh
cd app
npm install
npm start
```

Node 20+ recommended. On macOS you'll also want `brew install librsvg` for building icons.

**If MeetLoaf is already installed and running, `npm start` quits silently**, because Electron's single-instance lock sees the installed app. Quit the installed app, or give the dev copy its own profile:

```sh
npx electron . --user-data-dir=/tmp/meetloaf-dev
```

The README's [developer section](README.md#for-you-developer-build-and-publish) covers permissions, hotkeys, packaging and releases.

## Layout

- `app/`: the Electron app. `main.js` is the main process; `main-inject.js` runs inside the Meet page.
- `extension/`: Firefox router extension.
- `extension-chrome/`: Chrome/Chromium router extension.
- `packaging/`: Homebrew cask.

## Things that break

Most of MeetLoaf's page integration matches Meet's button labels and DOM, and Google changes those without notice. If a feature quietly stops working, that's the first place to look. The README's Troubleshooting section lists the debugging hooks.

## Pull requests

- Keep each PR to one change, and say in the description which platforms you tested on (macOS, Windows, Linux).
- Update the README if you change behaviour, install steps or settings.
- Don't bump the version; that happens at release time.

## Your responsibility for what you submit

AI-assisted contributions are fine, but you're the author of whatever you submit, however it was written. By opening a pull request you confirm that:

- you've read and understood every line of it, and tested it;
- it does only what the description says, with no hidden behaviour, telemetry, network calls or obfuscated code;
- you have the right to submit it, and it doesn't copy code under an incompatible licence.

Pull requests that look unreviewed, or that add network access, new dependencies or remote code loading without a clear reason, will be closed.

By submitting a pull request you agree that your contribution is licensed under the [MIT License](LICENSE), and that it is provided without warranty on the same terms as the rest of MeetLoaf.
