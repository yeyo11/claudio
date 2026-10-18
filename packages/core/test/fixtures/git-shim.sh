#!/bin/sh
# A stand-in for git in the golden tests: it writes down the arguments of every call to
# $FAKE_CALL_LOG (when set) and then runs the real git, which $FAKE_REAL_GIT names.
if [ -n "$FAKE_CALL_LOG" ]; then
  printf 'git' >> "$FAKE_CALL_LOG"
  for a in "$@"; do printf ' %s' "$a" >> "$FAKE_CALL_LOG"; done
  printf '\n' >> "$FAKE_CALL_LOG"
fi
# The tests' `origin` is a bare repository beside the project, which has no host, and a project with
# a host-less origin is not ready. With $FAKE_ORIGIN_URL set, `remote get-url origin` names that
# host while fetch and push still reach the bare repository. A URL a test set itself is left alone.
if [ -n "$FAKE_ORIGIN_URL" ] && [ "$3" = remote ] && [ "$4" = get-url ] && [ "$5" = origin ]; then
  url=$("$FAKE_REAL_GIT" "$@") || exit $?
  case "$url" in /*) echo "$FAKE_ORIGIN_URL" ;; *) echo "$url" ;; esac
  exit 0
fi
exec "$FAKE_REAL_GIT" "$@"
