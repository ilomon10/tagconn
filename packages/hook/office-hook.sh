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
#
# LC_ALL=C: every ${#var} length check below (the SC4 M1/L3 fixes) must count
# BYTES, matching `wc -c`/`head -c`. In a multibyte locale, shell parameter
# length expansion counts characters instead, which would silently miscount a
# UTF-8 body and defeat the size caps. This also keeps sed/case matching
# locale-independent.
export LC_ALL=C

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
# it off for this run (TAGCONN_ATTRIBUTION=off, set by the runner on Receptionist
# turns — see apps/runner/src/env.ts/runManager.ts. NOT set on quests: this
# check is belt-and-suspenders there anyway, since the Receptionist already
# skips this whole hook via TAGCONN_RUN_KIND=receptionist above. SC5 INFO: if
# quests should also skip attribution README/import work, that's a product
# decision for the PM, not something this comment can fix on its own.)
#
# Perf (SC4 M1): a PostToolUse (or any) body can be megabytes (tool output),
# and running `sed` over the whole thing on EVERY event was measured at ~1.2s
# for an 8MB body vs ~0.18s for the cheap check below. So: first, a plain
# shell `case` glob (no subprocess, short-circuits fast) checks whether the
# literal string "SessionStart" appears at all; only then, and only when the
# body is small (real SessionStart payloads are a few hundred bytes), do we
# fork `sed` to parse hook_event_name properly (so we're not fooled by
# "SessionStart" appearing as some other field's value). Anything that
# doesn't match both cheap checks is treated as "not SessionStart" - safe,
# since attribution is opt-in best-effort, never required for correctness.
is_session_start=0
case "$body" in
  *'"SessionStart"'*)
    if [ ${#body} -le 16384 ]; then
      hook_event=$(printf '%s' "$body" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
      [ "$hook_event" = "SessionStart" ] && is_session_start=1
    fi
    ;;
esac

if [ "$is_session_start" = "1" ] && [ "${TAGCONN_ATTRIBUTION:-}" != "off" ]; then
  (
    configdir=$(dirname "$conf")
    tpl="$configdir/attribution-README.md"
    attrconf="$configdir/attribution.conf"
    dir="${CLAUDE_PROJECT_DIR:-}"

    # Canonicalize (SC4 L1): a plain string compare against $HOME is bypassed
    # by a trailing slash, `..`, or CLAUDE_PROJECT_DIR being a symlink INTO
    # $HOME. Resolve both to their real, symlink-free paths via `cd && pwd -P`
    # and use $rd (never the original $dir) for every path below.
    rd=""
    if [ -n "$dir" ] && [ -d "$dir" ]; then
      rd=$(cd "$dir" 2>/dev/null && pwd -P) || rd=""
    fi
    rh=""
    if [ -n "$HOME" ] && [ -d "$HOME" ]; then
      rh=$(cd "$HOME" 2>/dev/null && pwd -P) || rh=""
    fi

    # -------------------- README write (opt-in) --------------------
    # Guards: dir must exist, be owned by us, be a git repo, and never be
    # $HOME or /. No mkdir -p: only ever create the single ".tagconn" dir.
    if [ -n "$rd" ] && [ -O "$rd" ] && [ -e "$rd/.git" ] && [ "$rd" != "$rh" ] && [ "$rd" != "/" ]; then
      # Skip if .tagconn already exists (file, dir, or symlink) - never
      # touch or follow it. This is also how a user opts back out: replace
      # .tagconn with an empty file named .tagconn (see the README itself).
      if [ ! -e "$rd/.tagconn" ] && [ ! -L "$rd/.tagconn" ] && [ -f "$tpl" ]; then
        if mkdir "$rd/.tagconn" 2>/dev/null; then
          # Re-check (SC4 L2): close the window between mkdir succeeding and
          # the write below - something could have raced us and swapped
          # .tagconn for a symlink in between. Then `cd` into it and write a
          # relative path: once `cd` resolves, the write targets that exact
          # directory inode even if the path component is later replaced.
          if [ -d "$rd/.tagconn" ] && [ ! -L "$rd/.tagconn" ]; then
            (
              cd "$rd/.tagconn" 2>/dev/null || exit 0
              # noclobber (set -C): never overwrite an existing README.md.
              set -C
              cat "$tpl" > README.md
            ) 2>/dev/null
          fi
        fi
      fi
    fi

    # -------------------- Profile import (opt-in via attribution.conf) --------------------
    # Requires: attribution.conf present (installer writes it 0600 by
    # default), and a REGULAR, NON-SYMLINK, OWNED-BY-US .tagconn/office.json
    # under a REGULAR (well, directory), NON-SYMLINK, OWNED-BY-US .tagconn.
    if [ -n "$rd" ] && [ -f "$attrconf" ]; then
      t="$rd/.tagconn"
      if [ -d "$t" ] && [ ! -L "$t" ] && [ -O "$t" ]; then
        f="$t/office.json"
        # [ -f ] is true only for a regular file (never a FIFO/socket/device),
        # so a planted named pipe can't make the `head` below block forever.
        if [ -f "$f" ] && [ ! -L "$f" ] && [ -O "$f" ]; then
          # Read ONCE (SC4 L3): the old code read the file twice (once to
          # measure it with `wc -c`, once to send it), leaving a TOCTOU
          # window where the content could change in between. Reading into a
          # variable strips trailing newlines, so a trailing literal "x" is
          # appended first and stripped back off after - the classic shell
          # idiom for capturing a command's exact byte output including
          # trailing whitespace (see comments on `raw`/`payload` below).
          raw=$(head -c 65537 -- "$f" 2>/dev/null; printf x)
          n=$(( ${#raw} - 1 ))
          if [ "$n" -gt 0 ] && [ "$n" -le 65536 ]; then
            sid=$(printf '%s' "$body" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
            # Restrict to the session-id character set; an empty or
            # out-of-charset value skips the import (the server can't
            # correlate it to a project without a usable token anyway).
            case "$sid" in
              *[!A-Za-z0-9_-]*) sid="" ;;
            esac
            if [ -n "$sid" ]; then
              payload=${raw%x}
              printf '%s' "$payload" | curl -s -o /dev/null \
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
    fi
  ) </dev/null >/dev/null 2>&1 &
fi

exit 0
