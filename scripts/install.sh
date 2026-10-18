#!/usr/bin/env bash
# Installs the Claudio desktop app on Linux from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/yeyo11/claudio/main/scripts/install.sh | bash
#
# The AppImage in ~/.local (no root at all) where Chromium's sandbox can start without root; elsewhere,
# Ubuntu 24.04 and later among them, the .deb from Claudio's signed apt repository (asks for sudo once),
# which then updates with the rest of the system. Never --no-sandbox.
#
# Options (after `bash -s --` when piped):
#   --version vX.Y.Z   install that release instead of the latest
#   --appimage         use the AppImage, wherever this runs
#   --deb              use the .deb through the apt repository, wherever this runs
#   --uninstall        remove what this script installed
set -euo pipefail

REPO="yeyo11/claudio"
APT_URL="https://yeyo11.github.io/claudio/apt"
# The apt repository's OpenPGP key (Ed25519, "Claudio apt repository"). The keyring fetched from Pages
# must hold this key and no other: Pages serving another key must not make apt trust it
# (docs/decisions/apt-repository.md)
APT_FINGERPRINT="33DC4ECFD40612112D06475843E6487D3DF5098F"
# The Ed25519 keys the desktop manifest (claudio-desktop-<v>-linux-x64.json) is signed with: the
# release's signing keys, docker/keys/*.pub. A rotation adds the new key here before it signs.
read -r -d '' MANIFEST_KEYS <<'KEYS' || true
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAPT4FtCvezqHswy7ITTrBc5140+5C2ICLVtYElEbB9fI=
-----END PUBLIC KEY-----
KEYS

say() { printf '\033[1;38;5;173m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }

# True when Chromium's sandbox can start inside an AppImage without root: unprivileged user namespaces
# are allowed. Where they are restricted (kernel.apparmor_restrict_unprivileged_userns=1, Ubuntu 24.04
# and later), only a root-installed AppArmor profile lets it start, which the .deb has and an AppImage in
# a user dir cannot have; the alternative, --no-sandbox, drops the renderer sandbox (D5). The argument
# is the proc root, for the tests.
sandbox_rootless() {
  local proc="${1:-/proc}" value
  if [ -r "$proc/sys/kernel/apparmor_restrict_unprivileged_userns" ]; then
    value="$(cat "$proc/sys/kernel/apparmor_restrict_unprivileged_userns")"
    [ "$value" = "0" ] || return 1
  fi
  if [ -r "$proc/sys/kernel/unprivileged_userns_clone" ]; then
    value="$(cat "$proc/sys/kernel/unprivileged_userns_clone")"
    [ "$value" = "1" ] || return 1
  fi
  [ -r "$proc/sys/user/max_user_namespaces" ] || return 1
  value="$(cat "$proc/sys/user/max_user_namespaces")"
  case "$value" in ''|*[!0-9]*) return 1 ;; esac
  [ "$value" -gt 0 ]
}

# The AppImage's runtime is static and mounts itself through fusermount3 (or fusermount): libfuse2 is
# not needed
fuse_usable() {
  [ -e /dev/fuse ] || return 1
  command -v fusermount3 >/dev/null 2>&1 || command -v fusermount >/dev/null 2>&1
}

# The fingerprint of the one primary key in an OpenPGP keyring file; empty when it holds none or more
keyring_fingerprint() {
  local home
  home="$(mktemp -d)"
  GNUPGHOME="$home" gpg --batch --quiet --with-colons --show-keys "$1" 2>/dev/null \
    | awk -F: '$1 == "pub" { keys++; want = 1; next } $1 == "fpr" && want { fpr = $10; want = 0 } END { if (keys == 1) print fpr }'
  rm -rf "$home"
}

# The sha256 the desktop manifest gives for a file name, from its JSON without a JSON parser: the
# object after "<name>":, up to its closing brace
manifest_sha256() {
  local flat rest
  flat="$(tr -d ' \t\r\n' < "$1")"
  case "$flat" in *"\"$2\":{"*) ;; *) return 0 ;; esac
  rest="${flat#*"\"$2\":{"}"
  rest="${rest%%\}*}"
  printf '%s' "$rest" | sed -n -E 's/.*"sha256":"([0-9a-f]{64})".*/\1/p'
}

# True when a line `<keyId> <base64>` (or a bare base64 line) of the signature file verifies the
# manifest with one of the pinned keys. Needs OpenSSL 3 (pkeyutl -rawin)
manifest_signed() {
  local manifest="$1" signature="$2" dir="$3" line sig pem
  printf '%s\n' "$MANIFEST_KEYS" | awk -v dir="$dir" '/BEGIN PUBLIC KEY/ { n++ } { print > (dir "/key" n ".pem") }'
  while IFS= read -r line || [ -n "$line" ]; do
    sig="${line##* }"
    [ -n "$sig" ] || continue
    printf '%s' "$sig" | base64 -d > "$dir/sig.bin" 2>/dev/null || continue
    for pem in "$dir"/key*.pem; do
      if openssl pkeyutl -verify -pubin -inkey "$pem" -rawin -in "$manifest" -sigfile "$dir/sig.bin" >/dev/null 2>&1; then
        return 0
      fi
    done
  done < "$signature"
  return 1
}

# The sha512 (hex) electron-builder's latest-linux.yml gives for a file name; it writes base64
yml_sha512() {
  local b64
  b64="$(awk -v name="$2" '$1 == "-" && $2 == "url:" { hit = ($3 == name) } hit && $1 == "sha512:" { print $2; exit }' "$1")"
  [ -n "$b64" ] || return 0
  printf '%s' "$b64" | base64 -d | od -An -v -tx1 | tr -d ' \n'
}

openssl3() {
  command -v openssl >/dev/null 2>&1 || return 1
  case "$(openssl version 2>/dev/null)" in "OpenSSL "[3-9]*) return 0 ;; *) return 1 ;; esac
}

# The tests source this file for the functions above
if [ "${CLAUDIO_INSTALL_LIB:-}" = 1 ] && (return 0 2>/dev/null); then return 0; fi

VERSION=""
FORMAT=""
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a tag, e.g. v0.2.0}"; shift 2 ;;
    --appimage) FORMAT="appimage"; shift ;;
    --deb) FORMAT="deb"; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$DATA_HOME/claudio"
DESKTOP_FILE="$DATA_HOME/applications/claudio.desktop"
ICON_FILE="$DATA_HOME/icons/hicolor/512x512/apps/claudio.png"

sudo_() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }
debian_like() { command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; }

if [ "$UNINSTALL" -eq 1 ]; then
  # The AppImage's files first: they need no password, so a declined sudo below still leaves them gone
  rm -f "$BIN_DIR/claudio" "$DESKTOP_FILE" "$ICON_FILE"
  rm -rf "$APP_DIR"
  if command -v dpkg >/dev/null 2>&1 && dpkg -s claudio >/dev/null 2>&1; then
    # The package's postrm also removes the apt source it registered
    say "Removing the claudio package (it may ask for your password)"
    sudo_ apt-get remove -y claudio
  fi
  say "Claudio removed. Your data in ~/.config/Claudio and ~/Claudio was kept."
  exit 0
fi

[ "$(uname -s)" = "Linux" ] || fail "the desktop app is Linux-only; elsewhere run it with Docker (see the README)"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "only x86_64 builds are published so far (this machine is $(uname -m))" ;;
esac
need curl

if [ -z "$FORMAT" ]; then
  if command -v dpkg >/dev/null 2>&1 && dpkg -s claudio >/dev/null 2>&1; then
    # Already installed as a package: update it in place rather than install a second copy
    FORMAT="deb"
  elif sandbox_rootless && fuse_usable; then
    FORMAT="appimage"
  elif debian_like; then
    FORMAT="deb"
  else
    FORMAT="appimage"
    if ! sandbox_rootless; then
      say "Warning: this system restricts unprivileged user namespaces, so the AppImage's sandbox cannot start without root. Allow them, or install Claudio another way (see the README)."
    fi
  fi
fi

TMP="$(mktemp -d)"
# Readable by apt's unprivileged _apt user, which cannot enter a home directory
chmod 755 "$TMP"
trap 'rm -rf "$TMP"' EXIT

if [ "$FORMAT" = "deb" ]; then
  debian_like || fail "the .deb needs apt and dpkg; use --appimage on this system"
  command -v gpg >/dev/null 2>&1 || fail "gpg is required to check the apt repository's key (sudo apt-get install gnupg), or use --appimage"
  say "Adding Claudio's apt repository"
  curl -fsSL -o "$TMP/claudio-archive-keyring.gpg" "$APT_URL/claudio-archive-keyring.gpg" \
    || fail "could not download the repository key from $APT_URL"
  got="$(keyring_fingerprint "$TMP/claudio-archive-keyring.gpg")"
  [ "$got" = "$APT_FINGERPRINT" ] || fail "the repository key is not Claudio's (got '${got:-none}', want $APT_FINGERPRINT); nothing was installed"
  cat > "$TMP/claudio.sources" <<SOURCE
# Claudio's signed apt repository (https://github.com/$REPO/blob/main/docs/decisions/apt-repository.md).
# \`apt remove claudio\` deletes it.
Types: deb
URIs: $APT_URL
Suites: stable
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/claudio-archive-keyring.gpg
SOURCE
  say "Installing with apt (it may ask for your password)"
  sudo_ install -D -m 0644 -o root -g root "$TMP/claudio-archive-keyring.gpg" /usr/share/keyrings/claudio-archive-keyring.gpg
  sudo_ install -D -m 0644 -o root -g root "$TMP/claudio.sources" /etc/apt/sources.list.d/claudio.sources
  # This source only: another repository that fails to update must not stop the install
  sudo_ apt-get update -o Dir::Etc::sourcelist=sources.list.d/claudio.sources -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0
  # -y: the person ran the installer, and a piped script has no terminal for apt's question
  if [ -n "$VERSION" ]; then
    sudo_ apt-get install -y "claudio=${VERSION#v}"
  else
    sudo_ apt-get install -y claudio
  fi
  TAG="$(dpkg-query -W -f '${Version}' claudio 2>/dev/null || echo "?")"
else
  # The release's asset list, from the API: no guessing file names from the version. Parsed from a
  # file, not a pipe: a reader that stops early would SIGPIPE the writer and pipefail would abort.
  if [ -n "$VERSION" ]; then API="https://api.github.com/repos/$REPO/releases/tags/$VERSION"; else API="https://api.github.com/repos/$REPO/releases/latest"; fi
  curl -fsSL -H 'Accept: application/vnd.github+json' -o "$TMP/release.json" "$API" || fail "could not read the release from GitHub ($API)"
  TAG="$(sed -n -E 's/.*"tag_name": *"([^"]+)".*/\1/p' "$TMP/release.json")"
  TAG="${TAG%%$'\n'*}"
  # The download URL of the asset whose name matches a glob
  asset() {
    local url
    while IFS= read -r url; do
      # shellcheck disable=SC2254 # the argument is a pattern
      case "$url" in */$1) printf '%s\n' "$url"; return 0 ;; esac
    done < <(sed -n -E 's/.*"browser_download_url": *"(https:[^"]+)".*/\1/p' "$TMP/release.json")
  }
  URL="$(asset '*-x86_64.AppImage')"
  [ -n "$URL" ] || fail "release ${TAG:-?} has no AppImage yet"
  NAME="$(basename "$URL")"
  FILE="$TMP/$NAME"
  say "Downloading Claudio $TAG (AppImage)"
  curl -fL --progress-bar -o "$FILE" "$URL"

  # Checked before anything is installed: against the signed desktop manifest when the release has one
  # and OpenSSL 3 can check Ed25519, else against latest-linux.yml's sha512 (what the updater checks),
  # saying so. A manifest that is present but does not verify stops the install: never a fallback then.
  MANIFEST_URL="$(asset 'claudio-desktop-*-linux-x64.json')"
  SIG_URL="$(asset 'claudio-desktop-*-linux-x64.json.sig')"
  if [ -n "$MANIFEST_URL" ] && [ -n "$SIG_URL" ] && openssl3; then
    curl -fsSL -o "$TMP/manifest.json" "$MANIFEST_URL" || fail "could not download the desktop manifest"
    curl -fsSL -o "$TMP/manifest.json.sig" "$SIG_URL" || fail "could not download the desktop manifest's signature"
    mkdir -p "$TMP/keys"
    manifest_signed "$TMP/manifest.json" "$TMP/manifest.json.sig" "$TMP/keys" \
      || fail "the desktop manifest of $TAG is not signed by Claudio's key; nothing was installed"
    want="$(manifest_sha256 "$TMP/manifest.json" "$NAME")"
    [ -n "$want" ] || fail "the desktop manifest of $TAG does not list $NAME"
    got="$(sha256sum "$FILE" | cut -d' ' -f1)"
    [ "$got" = "$want" ] || fail "$NAME does not match its signed manifest; nothing was installed"
    say "Verified against the signed desktop manifest"
  else
    if [ -z "$MANIFEST_URL" ]; then
      say "Release $TAG has no signed desktop manifest: checking the download against latest-linux.yml's sha512 only"
    else
      say "OpenSSL 3 is not available to check the signature: checking the download against latest-linux.yml's sha512 only"
    fi
    YML_URL="$(asset latest-linux.yml)"
    [ -n "$YML_URL" ] || fail "release $TAG has no latest-linux.yml to check the download against"
    curl -fsSL -o "$TMP/latest-linux.yml" "$YML_URL" || fail "could not download latest-linux.yml"
    want="$(yml_sha512 "$TMP/latest-linux.yml" "$NAME")"
    [ -n "$want" ] || fail "latest-linux.yml does not list $NAME"
    got="$(sha512sum "$FILE" | cut -d' ' -f1)"
    [ "$got" = "$want" ] || fail "$NAME does not match its sha512; nothing was installed"
  fi

  mkdir -p "$APP_DIR" "$BIN_DIR" "$(dirname "$DESKTOP_FILE")" "$(dirname "$ICON_FILE")"
  install -m 755 "$FILE" "$APP_DIR/Claudio.AppImage"
  ln -sf "$APP_DIR/Claudio.AppImage" "$BIN_DIR/claudio"
  curl -fsSL -o "$ICON_FILE" "https://raw.githubusercontent.com/$REPO/$TAG/apps/desktop/build/icons/512x512.png" || true
  # Same file name as the .deb's /usr/share/applications/claudio.desktop, so this entry shadows it
  cat > "$DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Claudio
GenericName=Claude Code Control Panel
Comment=Desktop UI for Claude Code agents: runs, sessions and multi-agent orchestration
Exec=$APP_DIR/Claudio.AppImage %U
Icon=claudio
Terminal=false
Categories=Development;
Keywords=Claude;Claude Code;AI;agents;orchestration;
StartupWMClass=claudio
DESKTOP
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$(dirname "$DESKTOP_FILE")" || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$DATA_HOME/icons/hicolor" || true
  fuse_usable || say "Note: the AppImage mounts itself with FUSE; install fuse3 (it provides fusermount3) to start it"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Note: add $BIN_DIR to your PATH to run 'claudio' from a terminal" ;; esac
fi

if ! command -v claude >/dev/null 2>&1; then
  say "Claudio drives the Claude Code CLI, which is not on your PATH yet:"
  echo "    curl -fsSL https://claude.ai/install.sh | bash"
fi
say "Claudio $TAG installed. Open it from your applications menu, or run: claudio"
