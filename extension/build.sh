#!/usr/bin/env bash
# Sign the Firefox extension via Mozilla's web-ext + AMO API, then copy the
# resulting .xpi into app/ so it ships inside MeetLoaf.app.
#
# Normally you don't need this: .github/workflows/sign-firefox.yml signs on
# every push to main that bumps "version" in manifest.json, and opens a PR
# with the new app/firefox-extension.xpi. This script is the manual fallback,
# e.g. when the workflow can't run or you want to sign from a branch.
#
# One-time setup:
#   1. Get an AMO API key at https://addons.mozilla.org/developers/addon/api/key/
#   2. Export the credentials before running this script:
#        export WEB_EXT_API_KEY='user:1234567:89'
#        export WEB_EXT_API_SECRET='hex...'
#
# If you do run it, COMMIT the resulting app/firefox-extension.xpi. The release
# build bundles the committed file and never signs anything, so an uncommitted
# XPI means every release ships without the extension. Bump "version" in manifest.json first — AMO rejects a re-upload of
# a version it has already seen for this add-on ID.
set -euo pipefail

cd "$(dirname "$0")"

if [[ -z "${WEB_EXT_API_KEY:-}" || -z "${WEB_EXT_API_SECRET:-}" ]]; then
  echo "Missing AMO credentials." >&2
  echo "  export WEB_EXT_API_KEY='user:...' WEB_EXT_API_SECRET='...'" >&2
  echo "  Get them at https://addons.mozilla.org/developers/addon/api/key/" >&2
  exit 1
fi

rm -rf web-ext-artifacts

# --channel=unlisted produces a signed XPI for personal/private distribution.
# It's signed by Mozilla but not listed in the public AMO catalog. Anyone with
# the file can install it permanently in regular Firefox.
npx --yes web-ext sign \
  --channel=unlisted \
  --ignore-files build.sh \
  --api-key="$WEB_EXT_API_KEY" \
  --api-secret="$WEB_EXT_API_SECRET"

XPI=$(ls -t web-ext-artifacts/*.xpi 2>/dev/null | head -n1 || true)
if [[ -z "$XPI" ]]; then
  echo "No .xpi found — did web-ext sign succeed?" >&2
  exit 1
fi

DEST="../app/firefox-extension.xpi"
cp "$XPI" "$DEST"
echo ""
echo "Wrote $DEST"
echo "Rebuild the .app (cd ../app && npm run dist) to bundle it."
