#!/bin/sh
# A stand-in for git in the golden tests: it writes down the arguments of every call to
# $CLAUDIO_CALL_LOG (when set) and then runs the real git, which $CLAUDIO_REAL_GIT names.
if [ -n "$CLAUDIO_CALL_LOG" ]; then
  printf 'git' >> "$CLAUDIO_CALL_LOG"
  for a in "$@"; do printf ' %s' "$a" >> "$CLAUDIO_CALL_LOG"; done
  printf '\n' >> "$CLAUDIO_CALL_LOG"
fi
# The tests' `origin` is a bare repository beside the project, which has no host, and a project with
# a host-less origin is not ready. With $CLAUDIO_ORIGIN_URL set, `remote get-url origin` names that
# host while fetch and push still reach the bare repository. A URL a test set itself is left alone.
if [ -n "$CLAUDIO_ORIGIN_URL" ] && [ "$3" = remote ] && [ "$4" = get-url ] && [ "$5" = origin ]; then
  url=$("$CLAUDIO_REAL_GIT" "$@") || exit $?
  case "$url" in /*) echo "$CLAUDIO_ORIGIN_URL" ;; *) echo "$url" ;; esac
  exit 0
fi
exec "$CLAUDIO_REAL_GIT" "$@"
