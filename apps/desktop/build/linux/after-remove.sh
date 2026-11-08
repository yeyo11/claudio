#!/bin/bash
# shellcheck disable=SC2016 # electron-builder's macros sit in single quotes
# The .deb's postrm (electron-builder.yml, deb.afterRemove). A template like after-install.sh: a dollar
# sign followed by a name in braces is an electron-builder macro, so shell variables go without braces.
#
# The first part is electron-builder's own after-remove.tpl (app-builder-lib 26.15.3), unchanged. The
# second removes what after-install.sh registered for Claudio's apt repository
# (docs/plans/unified-updates.md, D4), the third what it set up for the update unit
# (docs/plans/remote-updates.md, D1-D2).

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1.html
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.  Mirror the chroot guard
  # used in the after-install script — live AppArmor operations are not
  # meaningful inside a chroot.
  # https://wiki.debian.org/AppArmor/HowToUse
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi

# --- Claudio's apt repository ------------------------------------------------------------------
#
# dpkg calls postrm with `upgrade` too, between the old and the new package: then nothing here runs,
# or every upgrade would delete the source the person kept and the new postinst would not add it back
# (repo_add_once=false).
case "$1" in
  remove|purge)
    # The keyring the source names goes with the package, and a source pointing at a missing keyring
    # breaks every `apt update` on the machine
    rm -f /etc/apt/sources.list.d/claudio.sources
    ;;
esac
if [ "$1" = "purge" ]; then
  rm -f /etc/default/claudio
  # The pin is a conffile, which dpkg deletes on purge itself; this keeps it from outliving the
  # package should it ever have been installed as a plain file. Kept on remove, like any conffile:
  # it names only claudio, so it changes nothing while the package is gone
  rm -f /etc/apt/preferences.d/claudio.pref
fi

# --- Claudio's update unit ---------------------------------------------------------------------
#
# Again only on remove and purge: an upgrade keeps the group and its members, or the person would
# lose passwordless updates at every update. The rule and the unit are files of the package, which
# dpkg has already deleted; the rule goes here too so that it never outlives the group it trusts,
# whatever left a copy behind.
case "$1" in
  remove|purge)
    rm -f /usr/share/polkit-1/rules.d/50-claudio-update.rules
    if getent group claudio-update >/dev/null 2>&1; then
      groupdel claudio-update || true
    fi
    if [ -d /run/systemd/system ]; then
      systemctl --system daemon-reload >/dev/null 2>&1 || true
    fi
    ;;
esac
# The last run's outcome, which only the app reads
if [ "$1" = "purge" ]; then
  rm -rf /var/lib/claudio-update
fi

exit 0
