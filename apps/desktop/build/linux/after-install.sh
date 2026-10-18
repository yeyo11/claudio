#!/bin/bash
# shellcheck disable=SC2006,SC2016,SC2166 # electron-builder's macros sit in single quotes, and its template keeps its own style
# The .deb's postinst (electron-builder.yml, deb.afterInstall). electron-builder treats this file as a
# template: a dollar sign followed by a name in braces is one of its macros (executable,
# sanitizedProductName), and an unknown one fails the build. Shell variables below are therefore
# written without braces.
#
# The first part is electron-builder's own after-install.tpl (app-builder-lib 26.15.3), unchanged: the
# /usr/bin alternative, chrome-sandbox's mode and the AppArmor profile that lets Chromium's sandbox
# start on hosts that restrict unprivileged user namespaces (docs/plans/unified-updates.md, D5).
# The second part registers Claudio's signed apt repository (D4, docs/decisions/apt-repository.md).

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# Unfortunately, at the moment AppArmor doesn't have a good story for backwards compatibility.
# https://askubuntu.com/questions/1517272/writing-a-backwards-compatible-apparmor-profile
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    # Use cases are for example environments where images for clients are maintained.
    # There, AppArmor might correctly be installed, but live updating makes no sense.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# --- Claudio's apt repository ------------------------------------------------------------------
#
# Registered once, the way Chrome and VS Code do it, so the system's own updater (Software Updater,
# unattended-upgrades, apt upgrade) installs new desktop shells and the app never asks for a password.
# The keyring is a file of this package (/usr/share/keyrings), so a key rotation travels in a package
# update and dpkg removes it with the package; the source names it in Signed-By, so the key is trusted
# for this repository only, never for the rest of the system (/etc/apt/trusted.gpg.d would).
#
# "Once" is recorded as repo_add_once=false in /etc/default/claudio: a person who deletes the source
# does not get it back on the next upgrade. CLAUDIO_APT_REPO=off there, or in the environment of the
# install, skips the registration. The file is parsed, never sourced: these lines run as root.

CLAUDIO_SOURCE=/etc/apt/sources.list.d/claudio.sources
CLAUDIO_DEFAULTS=/etc/default/claudio
CLAUDIO_KEYRING=/usr/share/keyrings/claudio-archive-keyring.gpg

# The value of KEY=VALUE in the defaults file, quotes and spaces trimmed; empty when absent
claudio_default() {
  [ -f "$CLAUDIO_DEFAULTS" ] || return 0
  sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*[\"']?([^\"'[:space:]]*)[\"']?[[:space:]]*$/\\1/p" "$CLAUDIO_DEFAULTS" | tail -n 1
}

claudio_register_apt_source() {
  local mode once tmp
  mode="$CLAUDIO_APT_REPO"
  [ -n "$mode" ] || mode="$(claudio_default CLAUDIO_APT_REPO)"
  if [ "$mode" = "off" ]; then
    echo "claudio: CLAUDIO_APT_REPO=off, so the apt repository is not registered"
    return 0
  fi
  once="$(claudio_default repo_add_once)"
  [ "$once" = "false" ] && return 0
  # A source with no key would break every `apt update` on the machine
  if [ ! -s "$CLAUDIO_KEYRING" ]; then
    echo "claudio: $CLAUDIO_KEYRING is missing, so the apt repository is not registered" >&2
    return 0
  fi

  mkdir -p /etc/apt/sources.list.d || return 0
  # Written beside the target and renamed, so apt never reads half a file
  tmp="$(mktemp /etc/apt/sources.list.d/.claudio.sources.XXXXXX)" || return 0
  cat > "$tmp" <<'SOURCE'
# Claudio's signed apt repository, registered once by the claudio package
# (https://github.com/yeyo11/claudio/blob/main/docs/decisions/apt-repository.md).
# Deleting this file is honoured: the package does not add it again. `apt remove claudio` deletes it.
Types: deb
URIs: https://yeyo11.github.io/claudio/apt
Suites: stable
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/claudio-archive-keyring.gpg
SOURCE
  if ! { chmod 0644 "$tmp" && mv -f "$tmp" "$CLAUDIO_SOURCE"; }; then
    rm -f "$tmp"
    return 0
  fi

  # Keep whatever else the file says (an admin's CLAUDIO_APT_REPO line) and set repo_add_once
  tmp="$(mktemp /etc/default/.claudio.XXXXXX)" || return 0
  if [ -f "$CLAUDIO_DEFAULTS" ]; then
    grep -v -E '^[[:space:]]*repo_add_once[[:space:]]*=' "$CLAUDIO_DEFAULTS" > "$tmp"
  else
    printf '%s\n' '# Read by the claudio package. Set CLAUDIO_APT_REPO=off to never register its apt repository.' > "$tmp"
  fi
  printf '%s\n' 'repo_add_once=false' >> "$tmp"
  if ! { chmod 0644 "$tmp" && mv -f "$tmp" "$CLAUDIO_DEFAULTS"; }; then
    rm -f "$tmp"
  fi
  return 0
}

# dpkg calls postinst with `configure` on install and upgrade, and with abort-* when it rolls back
if [ "$1" = "configure" ]; then
  claudio_register_apt_source
fi

exit 0
