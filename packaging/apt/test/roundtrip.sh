#!/usr/bin/env bash
# The apt round trip of docs/plans/unified-updates.md (Tests, "deb"): install Claudio from its signed
# repository, upgrade through it, refuse a repository signed by another key or past its Valid-Until,
# and remove and purge cleanly. Runs as root inside a throwaway container, never on a person's
# machine: .github/workflows/desktop-smoke.yml runs it in debian:trixie and ubuntu:26.04.
#
#   docker run --rm -v <checkout>:/src:ro -v <debs>:/debs:ro -v <keys>:/keys:ro <image> \
#     bash /src/packaging/apt/test/roundtrip.sh
#
# /debs holds two claudio .deb files of different versions, built with a throwaway key's keyring
# staged in place of the real one (dist/package/claudio-archive-keyring.gpg). /keys holds that key:
# signing-key.asc (its armored secret half) and claudio-archive-keyring.gpg (the keyring the .deb
# files ship).
set -euo pipefail

SRC=/src
# The keyring the .deb files were built with: the throwaway key's, never the real one
KEYRING_SRC=/keys/claudio-archive-keyring.gpg
SOURCE=/etc/apt/sources.list.d/claudio.sources
DEFAULTS=/etc/default/claudio
KEYRING=/usr/share/keyrings/claudio-archive-keyring.gpg
REPO=/srv/repo
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
installed() { dpkg-query -W -f '${Version}' claudio 2>/dev/null || true; }
# The registered source, rewritten to the local repository: the test cannot reach Pages, and what is
# under test from here on is apt's handling of the repository, not the address
point_source_at() {
  sed -i -E "s|^URIs: .*|URIs: file:$1|" "$SOURCE"
}

step "tools"
apt-get update -qq
apt-get install -y -qq apt-utils gnupg >/dev/null

export GNUPGHOME=/root/gnupg
rm -rf "$GNUPGHOME"
mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --import /keys/signing-key.asc
SIGNING_KEY="$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr:/ { print $10; exit }')"
[ -n "$SIGNING_KEY" ] || fail "no secret key in /keys/signing-key.asc"

mapfile -t DEBS < <(ls /debs/*.deb)
[ "${#DEBS[@]}" -eq 2 ] || fail "expected two .deb files in /debs, found ${#DEBS[@]}"
V_A="$(dpkg-deb -f "${DEBS[0]}" Version)"
V_B="$(dpkg-deb -f "${DEBS[1]}" Version)"
if dpkg --compare-versions "$V_A" lt "$V_B"; then OLD="${DEBS[0]}"; NEW="${DEBS[1]}"; V1="$V_A"; V2="$V_B"
else OLD="${DEBS[1]}"; NEW="${DEBS[0]}"; V1="$V_B"; V2="$V_A"; fi
dpkg --compare-versions "$V1" lt "$V2" || fail "the two .deb files have the same version $V1"
mkdir -p /srv/v1 /srv/both
cp "$OLD" /srv/v1/
cp "$OLD" "$NEW" /srv/both/

step "a repository with $V1, signed and checked against the keyring the package ships"
bash "$SRC/packaging/apt/build-repo.sh" --debs /srv/v1 --out "$REPO" --sign-with "$SIGNING_KEY" --verify-with "$KEYRING_SRC"
grep -q '^Valid-Until: ' "$REPO/dists/stable/Release" || fail "Release has no Valid-Until"
grep -q "^Filename: pool/main/c/claudio/claudio_${V1}_amd64.deb$" "$REPO/dists/stable/main/binary-amd64/Packages" \
  || fail "Packages does not point into the pool"

step "install $V1 from the repository"
# What a person does by hand before the package exists on the machine (packaging/apt/index.html)
install -m 0644 "$KEYRING_SRC" "$KEYRING"
cat > /etc/apt/sources.list.d/bootstrap.sources <<EOF
Types: deb
URIs: file:$REPO
Suites: stable
Components: main
Signed-By: $KEYRING
EOF
apt-get update -qq
apt-get install -y -qq claudio >/dev/null
[ "$(installed)" = "$V1" ] || fail "installed $(installed), wanted $V1"
rm /etc/apt/sources.list.d/bootstrap.sources

step "the postinst registered the source, once"
[ -f "$SOURCE" ] || fail "$SOURCE was not written"
expected="Types: deb
URIs: https://yeyo11.github.io/claudio/apt
Suites: stable
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/claudio-archive-keyring.gpg"
[ "$(grep -v '^#' "$SOURCE")" = "$expected" ] || { cat "$SOURCE"; fail "$SOURCE is not the expected source"; }
[ "$(stat -c '%a %U' "$SOURCE")" = "644 root" ] || fail "$SOURCE mode $(stat -c '%a %U' "$SOURCE")"
[ "$(dpkg -S "$KEYRING" | cut -d: -f1)" = "claudio" ] || fail "$KEYRING is not the package's file"
[ "$(stat -c '%a %U' "$KEYRING")" = "644 root" ] || fail "$KEYRING mode $(stat -c '%a %U' "$KEYRING")"
cmp -s "$KEYRING" "$KEYRING_SRC" || fail "the package ships another keyring"
grep -qx 'repo_add_once=false' "$DEFAULTS" || fail "$DEFAULTS does not record repo_add_once=false"
for f in /opt/Claudio/resources/shell.json /opt/Claudio/resources/server/guard.mjs; do
  [ -f "$f" ] || fail "$f is missing"
done
ls /opt/Claudio/resources/keys/*.pub >/dev/null || fail "no public key in /opt/Claudio/resources/keys"

step "upgrade to $V2 through the registered source"
bash "$SRC/packaging/apt/build-repo.sh" --debs /srv/both --out "$REPO" --sign-with "$SIGNING_KEY" --verify-with "$KEYRING_SRC"
point_source_at "$REPO"
apt-get update -qq
apt-get install -y -qq --only-upgrade claudio >/dev/null
[ "$(installed)" = "$V2" ] || fail "upgraded to $(installed), wanted $V2"
# The postinst ran again (configure) and left the source as it was: once means once
grep -q "^URIs: file:$REPO$" "$SOURCE" || fail "the upgrade rewrote $SOURCE"

step "a source the person deleted is not added back"
rm "$SOURCE"
apt-get install -y -qq --reinstall "$NEW" >/dev/null
[ ! -e "$SOURCE" ] || fail "the reinstall added $SOURCE back"
printf '%s\n' "$expected" > "$SOURCE"
point_source_at "$REPO"

step "an InRelease signed by another key is refused"
gpg --batch --quiet --passphrase '' --quick-gen-key 'Rogue <rogue@example.invalid>' ed25519 sign 1d
ROGUE="$(gpg --batch --with-colons --list-secret-keys 'Rogue' | awk -F: '/^fpr:/ { print $10; exit }')"
bash "$SRC/packaging/apt/build-repo.sh" --debs /srv/both --out /srv/rogue --sign-with "$ROGUE"
point_source_at /srv/rogue
if apt-get update -qq 2>/tmp/rogue.err; then cat /tmp/rogue.err; fail "apt update accepted a repository signed by another key"; fi
grep -qiE 'not signed|NO_PUBKEY|signature|Missing key' /tmp/rogue.err || { cat /tmp/rogue.err; fail "apt refused for another reason"; }

step "a Release past its Valid-Until is refused"
bash "$SRC/packaging/apt/build-repo.sh" --debs /srv/both --out /srv/stale --sign-with "$SIGNING_KEY" --valid-seconds 1
sleep 3
point_source_at /srv/stale
if apt-get update -qq 2>/tmp/stale.err; then cat /tmp/stale.err; fail "apt update accepted an expired Release"; fi
grep -qi 'expired' /tmp/stale.err || { cat /tmp/stale.err; fail "apt refused for another reason"; }
point_source_at "$REPO"
apt-get update -qq

step "remove deletes the source and the keyring, keeps /etc/default/claudio"
apt-get remove -y -qq claudio >/dev/null
[ ! -e "$SOURCE" ] || fail "remove left $SOURCE"
[ ! -e "$KEYRING" ] || fail "remove left $KEYRING"
[ -f "$DEFAULTS" ] || fail "remove deleted $DEFAULTS"
apt-get update -qq || fail "apt update fails after remove"

step "purge deletes /etc/default/claudio"
apt-get purge -y -qq claudio >/dev/null
[ ! -e "$DEFAULTS" ] || fail "purge left $DEFAULTS"

step "CLAUDIO_APT_REPO=off skips the registration"
CLAUDIO_APT_REPO=off apt-get install -y -qq "$NEW" >/dev/null
[ "$(installed)" = "$V2" ] || fail "the local install did not happen"
[ ! -e "$SOURCE" ] || fail "CLAUDIO_APT_REPO=off still wrote $SOURCE"
apt-get purge -y -qq claudio >/dev/null
printf '%s\n' 'CLAUDIO_APT_REPO=off' > "$DEFAULTS"
apt-get install -y -qq "$NEW" >/dev/null
[ ! -e "$SOURCE" ] || fail "CLAUDIO_APT_REPO=off in $DEFAULTS still wrote $SOURCE"
apt-get purge -y -qq claudio >/dev/null

# shellcheck disable=SC1091 # the container's own
step "passed: $V1 -> $V2 on $(. /etc/os-release && echo "$PRETTY_NAME")"
