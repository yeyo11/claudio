#!/usr/bin/env bash
# Builds Claudio's apt repository from a directory of .deb files (docs/plans/unified-updates.md, D4;
# docs/decisions/apt-repository.md). The repository is rebuilt from scratch every time, so it holds
# no state of its own: .github/workflows/apt-repo.yml runs this on every release and every month.
#
#   packaging/apt/build-repo.sh --debs <dir> --out <dir> [--sign-with <fingerprint>]
#       [--verify-with <keyring.gpg>] [--valid-days <n> | --valid-seconds <n>]
#
# Writes <out>/{index.html, claudio-archive-keyring.gpg, .asc, dists/stable/..., pool/main/c/claudio/...}.
# --sign-with names a secret key already in GnuPG's keyring ($GNUPGHOME): InRelease (clearsigned) and
# Release.gpg (detached, armored) are made with it. --verify-with checks both signatures against a
# keyring with gpgv, the way apt will, so a secret that does not match the key the .deb ships fails
# here instead of breaking `apt update` for every user. Needs apt-ftparchive (apt-utils), dpkg-deb,
# gpg and gpgv.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEBS=""
OUT=""
SIGN_WITH=""
VERIFY_WITH=""
# A mirror or a man in the middle cannot serve a stale Release past this (a freeze attack); the
# monthly rebuild re-signs well before it ends. --valid-seconds is for the test of an expired one
VALID_SECONDS=$((90 * 86400))

while [ $# -gt 0 ]; do
  case "$1" in
    --debs) DEBS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --sign-with) SIGN_WITH="$2"; shift 2 ;;
    --verify-with) VERIFY_WITH="$2"; shift 2 ;;
    --valid-days)
      case "$2" in ''|*[!0-9]*) echo "--valid-days takes a number" >&2; exit 2 ;; esac
      VALID_SECONDS=$(($2 * 86400)); shift 2 ;;
    --valid-seconds) VALID_SECONDS="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DEBS" ] && [ -d "$DEBS" ] || { echo "--debs must name a directory" >&2; exit 2; }
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
case "$VALID_SECONDS" in ''|*[!0-9]*|0) echo "--valid-days and --valid-seconds take a positive number" >&2; exit 2 ;; esac

rm -rf "$OUT"
POOL="$OUT/pool/main/c/claudio"
BINARY="$OUT/dists/stable/main/binary-amd64"
mkdir -p "$POOL" "$BINARY"

# Only the claudio package for amd64 goes in, under its canonical pool name, whatever the release
# asset was called: what apt installs is decided by the Packages index, not by a file name
count=0
for deb in "$DEBS"/*.deb; do
  [ -e "$deb" ] || continue
  package="$(dpkg-deb -f "$deb" Package)"
  version="$(dpkg-deb -f "$deb" Version)"
  arch="$(dpkg-deb -f "$deb" Architecture)"
  if [ "$package" != "claudio" ] || [ "$arch" != "amd64" ]; then
    echo "skipping $deb: $package $arch is not claudio amd64" >&2
    continue
  fi
  case "$version" in *[!0-9A-Za-z.+~-]*|'') echo "refusing $deb: odd version '$version'" >&2; exit 1 ;; esac
  cp "$deb" "$POOL/claudio_${version}_amd64.deb"
  count=$((count + 1))
done
[ "$count" -gt 0 ] || { echo "no claudio .deb in $DEBS" >&2; exit 1; }

# Paths in Packages (Filename:) are relative to the repository root, so the index is built from it
(cd "$OUT" && apt-ftparchive packages pool/main) > "$BINARY/Packages"
gzip -9nc "$BINARY/Packages" > "$BINARY/Packages.gz"

RELEASE_TMP="$(mktemp)"
trap 'rm -f "$RELEASE_TMP"' EXIT
(cd "$OUT/dists/stable" && apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=Claudio \
  -o APT::FTPArchive::Release::Label=Claudio \
  -o APT::FTPArchive::Release::Suite=stable \
  -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures=amd64 \
  -o APT::FTPArchive::Release::Components=main \
  -o APT::FTPArchive::Release::Description="Claudio desktop app" \
  -o "APT::FTPArchive::Release::ValidTime=$VALID_SECONDS" \
  -o APT::FTPArchive::Release::MD5=false \
  -o APT::FTPArchive::Release::SHA1=false \
  release .) > "$RELEASE_TMP"
mv "$RELEASE_TMP" "$OUT/dists/stable/Release"
VALID_UNTIL="$(sed -n 's/^Valid-Until: //p' "$OUT/dists/stable/Release")"
[ -n "$VALID_UNTIL" ] || { echo "apt-ftparchive wrote no Valid-Until" >&2; exit 1; }

if [ -n "$SIGN_WITH" ]; then
  gpg --batch --yes --local-user "$SIGN_WITH" --digest-algo SHA512 --clearsign \
    --output "$OUT/dists/stable/InRelease" "$OUT/dists/stable/Release"
  gpg --batch --yes --local-user "$SIGN_WITH" --digest-algo SHA512 --detach-sign --armor \
    --output "$OUT/dists/stable/Release.gpg" "$OUT/dists/stable/Release"
fi

if [ -n "$VERIFY_WITH" ]; then
  [ -f "$OUT/dists/stable/InRelease" ] || { echo "--verify-with needs a signed repository" >&2; exit 1; }
  gpgv --keyring "$(cd "$(dirname "$VERIFY_WITH")" && pwd)/$(basename "$VERIFY_WITH")" "$OUT/dists/stable/InRelease"
  gpgv --keyring "$(cd "$(dirname "$VERIFY_WITH")" && pwd)/$(basename "$VERIFY_WITH")" \
    "$OUT/dists/stable/Release.gpg" "$OUT/dists/stable/Release"
fi

cp "$HERE/index.html" "$OUT/index.html"
cp "$HERE/claudio-archive-keyring.gpg" "$HERE/claudio-archive-keyring.asc" "$OUT/"
echo "built $OUT with $count package(s), valid until $VALID_UNTIL"
