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
#
# M8 additions (see docs/design/runner-and-helpdesk.md "Attribution" and
# "Correlation"):
#   - TAGCONN_RUN_KIND=receptionist (set by apps/runner on a Receptionist turn)
#     makes this hook a pure no-op: no event POST, no attribution work at all.
#     Receptionist turns run with --restricted anyway, so this is belt and
#     suspenders, not the only gate.
#   - A UUID-shaped TAGCONN_RUN_ID (set by apps/runner on a quest) is sent as
#     the x-tagconn-run-id header: a correlation HINT only, never authority
#     (the server's own runLinker only trusts an existing, unlinked run).
#   - On SessionStart, once the foreground POST above is sent, a best-effort
#     "attribution" step runs in a detached background subshell (never
#     delays or can fail the hook): it (a) writes a small opt-in
#     .tagconn/README.md into the project repo the first time it sees it, and
#     (b) POSTs .tagconn/office.json (if present) to the server for import.
#     Both are strictly guarded - see the comments below - and both require
#     files scripts/install.ts writes, so a install that never opted in never
#     does any of this.

# Always read stdin fully first, even if we bail out below, so Claude Code
# never sees a broken pipe.
body="$(cat)"

# No-op switch.
if [ "${OFFICE_DISABLED:-0}" = "1" ]; then
  exit 0
fi

# Receptionist turns post no hooks at all (design 2.6.4): no event, no
# attribution. This must be the very first thing checked after reading stdin.
if [ "${TAGCONN_RUN_KIND:-}" = "receptionist" ]; then
  exit 0
fi

conf="${TAGCONN_CURL_CONF:-$HOME/.config/tagconn/curl.conf}"

# No config yet (not installed) -> silently do nothing.
[ -f "$conf" ] || exit 0

command -v curl >/dev/null 2>&1 || exit 0

# A UUID-shaped TAGCONN_RUN_ID becomes the x-tagconn-run-id correlation hint.
run_id_hdr_ok=0
case "${TAGCONN_RUN_ID:-}" in
  ????????-????-????-????-????????????)
    case "${TAGCONN_RUN_ID}" in
      *[!0-9a-f-]*) run_id_hdr_ok=0 ;;
      *) run_id_hdr_ok=1 ;;
    esac
    ;;
esac

if [ "$run_id_hdr_ok" = "1" ]; then
  printf '%s' "$body" | curl -s -o /dev/null \
    --connect-timeout 0.3 \
    -m 1 \
    -K "$conf" \
    -H 'content-type: application/json' \
    -H "x-tagconn-run-id: ${TAGCONN_RUN_ID}" \
    --data-binary @- \
    >/dev/null 2>&1
else
  printf '%s' "$body" | curl -s -o /dev/null \
    --connect-timeout 0.3 \
    -m 1 \
    -K "$conf" \
    -H 'content-type: application/json' \
    --data-binary @- \
    >/dev/null 2>&1
fi

# --------------------------------------------------------------------------
# Attribution (best-effort, background only; never delays or fails the hook)
# --------------------------------------------------------------------------
# Only ever considered on SessionStart, and only when the user hasn't turned
# it off for this run (TAGCONN_ATTRIBUTION=off, set by the runner on quests).
# sed, not a case/glob match, so pretty-printed (space after ':') and compact
# JSON both work, and it can't be confused by "SessionStart" appearing as
# some other field's value.
hook_event=$(printf '%s' "$body" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
is_session_start=0
[ "$hook_event" = "SessionStart" ] && is_session_start=1

if [ "$is_session_start" = "1" ] && [ "${TAGCONN_ATTRIBUTION:-}" != "off" ]; then
  (
    configdir=$(dirname "$conf")
    tpl="$configdir/attribution-README.md"
    attrconf="$configdir/attribution.conf"
    dir="${CLAUDE_PROJECT_DIR:-}"

    # -------------------- README write (opt-in) --------------------
    # Guards: dir must exist, be owned by us, be a git repo, and never be
    # $HOME or /. No mkdir -p: only ever create the single ".tagconn" dir.
    if [ -n "$dir" ] && [ -d "$dir" ] && [ -O "$dir" ] && [ -e "$dir/.git" ] \
      && [ "$dir" != "$HOME" ] && [ "$dir" != "/" ]; then
      # Skip if .tagconn already exists (file, dir, or symlink) - never
      # touch or follow it. This is also how a user opts back out: replace
      # .tagconn with an empty file named .tagconn (see the README itself).
      if [ ! -e "$dir/.tagconn" ] && [ ! -L "$dir/.tagconn" ] && [ -f "$tpl" ]; then
        if mkdir "$dir/.tagconn" 2>/dev/null; then
          # noclobber (set -C): never overwrite an existing README.md even
          # if something raced us between the checks above and here.
          (set -C; cat "$tpl" > "$dir/.tagconn/README.md") 2>/dev/null
        fi
      fi
    fi

    # -------------------- Profile import (opt-in via attribution.conf) --------------------
    # Requires: attribution.conf present (installer writes it 0600 by
    # default), and a REGULAR, NON-SYMLINK .tagconn/office.json under a
    # NON-SYMLINK .tagconn.
    if [ -n "$dir" ] && [ -f "$attrconf" ] && [ ! -L "$dir/.tagconn" ]; then
      f="$dir/.tagconn/office.json"
      if [ -f "$f" ] && [ ! -L "$f" ]; then
        # +1 byte over the cap so we can detect "too large" without reading
        # the whole (possibly huge) file twice.
        n=$(head -c 65537 "$f" 2>/dev/null | wc -c)
        if [ "$n" -gt 0 ] && [ "$n" -le 65536 ]; then
          sid=$(printf '%s' "$body" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
          # Restrict to the session-id character set; an empty or
          # out-of-charset value skips the import (the server can't
          # correlate it to a project without a usable token anyway).
          case "$sid" in
            *[!A-Za-z0-9_-]*) sid="" ;;
          esac
          if [ -n "$sid" ]; then
            head -c 65536 "$f" | curl -s -o /dev/null \
              --connect-timeout 0.3 \
              -m 1 \
              -K "$attrconf" \
              -H "x-tagconn-session-id: $sid" \
              -H 'content-type: application/json' \
              --data-binary @- \
              >/dev/null 2>&1
          fi
        fi
      fi
    fi
  ) </dev/null >/dev/null 2>&1 &
fi

exit 0
