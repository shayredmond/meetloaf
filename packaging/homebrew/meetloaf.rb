# Source of truth for the Homebrew cask. The release workflow renders this into
# shayredmond/homebrew-tap with __VERSION__ and __SHA256__ filled in, so the
# cask is reviewed here alongside the code it installs rather than drifting in
# a second repo.
cask "meetloaf" do
  version "__VERSION__"
  sha256 "__SHA256__"

  # Pinned to the exact release, not /latest/: the checksum above is only valid
  # for one build, and a moving URL would fail verification on every new one.
  url "https://github.com/shayredmond/meetloaf/releases/download/v#{version}/MeetLoaf-mac-arm64.dmg"
  name "MeetLoaf"
  desc "Standalone Google Meet app with global hotkeys and meet:// link routing"
  homepage "https://github.com/shayredmond/meetloaf"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Both taken from the built app: arm64-only, LSMinimumSystemVersion 12.0.
  depends_on arch: :arm64
  depends_on macos: ">= :monterey"

  app "MeetLoaf.app"

  # MeetLoaf keeps config under XDG rather than in the sandboxed container, so
  # `brew uninstall --zap` has to be told about it. com.nabucasa.meetloaf is the
  # bundle identifier used before 0.1.8 — harmless to list, and it tidies up
  # anyone who installed a build from before the rename.
  zap trash: [
    "~/.config/meetloaf",
    "~/Library/Application Support/meetloaf",
    "~/Library/Preferences/com.nabucasa.meetloaf.plist",
    "~/Library/Preferences/com.shayredmond.meetloaf.plist",
    "~/Library/Saved Application State/com.shayredmond.meetloaf.savedState",
  ]

  caveats <<~EOS
    MeetLoaf is ad-hoc signed rather than notarized, so macOS quarantines it by
    default. Install with --no-quarantine, or run:

      xattr -dr com.apple.quarantine "#{appdir}/MeetLoaf.app"
  EOS
end
