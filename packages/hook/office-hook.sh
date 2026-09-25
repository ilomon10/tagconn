#!/bin/sh
# tagconn Claude Code hook.
#
# Reads a Claude Code hook event (JSON) from stdin and forwards it, verbatim,
# to the tagconn office server. This script must NEVER break the Claude Code
# session it runs inside of, so it:
#   - always exits 0, no matter what happens
#   - never prints anything to stdout (some hook events read stdout back!)
#   - never blocks noticeably when the server is slow/down (short curl timeouts)
#   - is a no-op when OFFICE_DISABLED=1, curl is unavailable, or config is missing
#
# The shared secret and server URL live in a curl config file (`-K`), never on
# the command line: command-line args are visible to every user on the box via
# `ps`, but curl config file contents are not. That file is written by
# scripts/install.ts at $TAGCONN_CURL_CONF (default: ~/.config/tagconn/curl.conf),
# mode 0600, containing `header = "x-office-token: <token>"` and `url = "<url>/api/hooks"`.

# Always read stdin fully first, even if we bail out below, so Claude Code
# never sees a broken pipe.
body="$(cat)"

# No-op switch.
if [ "${OFFICE_DISABLED:-0}" = "1" ]; then
  exit 0
fi

conf="${TAGCONN_CURL_CONF:-$HOME/.config/tagconn/curl.conf}"

# No config yet (not installed) -> silently do nothing.
[ -f "$conf" ] || exit 0

command -v curl >/dev/null 2>&1 || exit 0

printf '%s' "$body" | curl -s -o /dev/null \
  --connect-timeout 0.3 \
  -m 1 \
  -K "$conf" \
  -H 'content-type: application/json' \
  --data-binary @- \
  >/dev/null 2>&1

exit 0
