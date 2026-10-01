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

# Extra request headers are collected in the positional parameters (POSIX sh has no arrays).
set --

# A UUID-shaped TAGCONN_RUN_ID becomes the x-tagconn-run-id correlation hint.
case "${TAGCONN_RUN_ID:-}" in
  ????????-????-????-????-????????????)
    case "${TAGCONN_RUN_ID}" in
      *[!0-9a-f-]*) ;;
      *) set -- "$@" -H "x-tagconn-run-id: ${TAGCONN_RUN_ID}" ;;
    esac
    ;;
esac

# Absolute path of an executable found on PATH. Empty, `.` and relative entries are skipped (`command -v`
# can return a stub planted in the current directory when PATH holds `.` or an empty entry).
tc_which() {
  _ifs=$IFS
  IFS=:
  for _d in $PATH; do
    case "$_d" in
      /*) ;;
      *) continue ;;
    esac
    if [ -f "$_d/$1" ] && [ -x "$_d/$1" ]; then
      IFS=$_ifs
      printf '%s' "$_d/$1"
      return 0
    fi
  done
  IFS=$_ifs
  return 1
}

# SessionStart detection (also used below for attribution): a plain `case` glob first, `sed` only for a
# small body that contains the literal; see the "Perf (SC4 M1)" note in the attribution section.
is_session_start=0
case "$body" in
  *'"SessionStart"'*)
    if [ ${#body} -le 16384 ]; then
      hook_event=$(printf '%s' "$body" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
      [ "$hook_event" = "SessionStart" ] && is_session_start=1
    fi
    ;;
esac


# M12: the project root (git toplevel of CLAUDE_PROJECT_DIR, else CLAUDE_PROJECT_DIR itself), base64 in
# x-tagconn-project-root, plus x-tagconn-project-root-kind: git|dir (git = it came from git), so a floor
# is the repo and not whatever directory the agent `cd`'d into. Untrusted on the server side (it
# validates both). Hardening:
#   - git is an ABSOLUTE path found by walking PATH (`tc_which`: a bare name, or `command -v`, with `.`/empty
#     entries could run a repo-planted stub), run from $HOME with EVERY GIT_* env var
#     cleared, bounded by `timeout 0.3` (without `timeout` on PATH, git is skipped: kind=dir).
#   - the toplevel is accepted only if it holds a .git entry and equals CLAUDE_PROJECT_DIR or is an
#     ancestor of it (defeats a `core.worktree=/home` spoof); otherwise kind=dir with CLAUDE_PROJECT_DIR.
#   - the result is cached per CLAUDE_PROJECT_DIR in <config dir>/root-cache (a 0700 dir we own, files 0600, keyed by cksum, the
#     dir is stored inside to rule out collisions); git runs only on a miss or on SessionStart.
#   - when git ran, curl's -m shrinks so git + curl stay within ~1 s.
# No CLAUDE_PROJECT_DIR (or no base64) -> the headers are simply omitted.
root=""
root_kind=""
curl_max=1
pdir="${CLAUDE_PROJECT_DIR:-}"
case "$pdir" in
  /*[!/]*) ;;
  *) pdir="" ;;
esac
case "$pdir" in
  *'
'*) pdir="" ;;
esac
if [ -n "$pdir" ] && [ -d "$pdir" ] && command -v base64 >/dev/null 2>&1; then
  configdir=$(dirname "$conf")
  cachef="$configdir/root-cache/$(printf '%s' "$pdir" | cksum 2>/dev/null | cut -d' ' -f1)"
  c_dir=""; c_kind=""; c_root=""
  if [ "$is_session_start" != "1" ] && [ -f "$cachef" ] && [ ! -L "$cachef" ] && [ -O "$cachef" ]; then
    { IFS= read -r c_dir; IFS= read -r c_kind; IFS= read -r c_root; } < "$cachef" 2>/dev/null || c_dir=""
    if [ "$c_dir" = "$pdir" ] && { [ "$c_kind" = "git" ] || [ "$c_kind" = "dir" ]; } && [ -n "$c_root" ]; then
      root="$c_root"
      root_kind="$c_kind"
    fi
  fi
  if [ -z "$root" ]; then
    root="$pdir"
    root_kind="dir"
    git_bin=$(tc_which git)
    timeout_bin=$(tc_which timeout)
    if [ -n "$git_bin" ] && [ -n "$timeout_bin" ]; then
      curl_max=0.6
      top=$(
        cd "$HOME" 2>/dev/null || cd / || exit 1
        for v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
        exec "$timeout_bin" 0.3 "$git_bin" -C "$pdir" rev-parse --show-toplevel
      ) 2>/dev/null </dev/null || top=""
      case "$top" in
        /*[!/]*)
          if [ -e "$top/.git" ]; then
            pp=$(cd "$pdir" 2>/dev/null && pwd -P) || pp=""
            case "$pdir/" in
              "$top"/*) root="$top"; root_kind="git" ;;
              *) case "$pp/" in "$top"/*) root="$top"; root_kind="git" ;; esac ;;
            esac
          fi
          ;;
      esac
    fi
    [ ${#root} -le 3000 ] || root=""
    if [ -n "$root" ]; then
      (
        umask 077
        cdir="$configdir/root-cache"
        mkdir -p "$cdir" 2>/dev/null || exit 0
        # Cache only in a real directory (not a symlink) we own with no group/other bits; else skip caching.
        [ -d "$cdir" ] && [ ! -L "$cdir" ] && [ -O "$cdir" ] || exit 0
        dmode=$(ls -ld "$cdir" 2>/dev/null | cut -c1-10)
        case "$dmode" in drwx------) ;; *) exit 0 ;; esac
        # Exclusive create (noclobber) of a randomly-named temp file, then an atomic rename.
        rnd=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
        [ -n "$rnd" ] || exit 0
        tmpf="$cachef.$$.$rnd"
        ( set -C; printf '%s\n%s\n%s\n' "$pdir" "$root_kind" "$root" > "$tmpf" ) 2>/dev/null && mv -f "$tmpf" "$cachef" 2>/dev/null
        rm -f "$tmpf" 2>/dev/null
      ) </dev/null >/dev/null 2>&1
    fi
  fi
  if [ -n "$root" ]; then
    root_b64=$(printf '%s' "$root" | base64 | tr -d '\n' 2>/dev/null) || root_b64=""
    if [ -n "$root_b64" ]; then
      set -- "$@" -H "x-tagconn-project-root: ${root_b64}" -H "x-tagconn-project-root-kind: ${root_kind}"
    fi
  fi
fi

printf '%s' "$body" | curl -s -o /dev/null \
  --connect-timeout 0.3 \
  -m "$curl_max" \
  -K "$conf" \
  -H 'content-type: application/json' \
  "$@" \
  --data-binary @- \
  >/dev/null 2>&1

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
    # Fail closed (L5): if $HOME does not resolve we cannot tell whether the
    # project IS the home dir, so skip attribution entirely.
    [ -n "$rh" ] || rd=""

    # -------------------- README write (opt-in) --------------------
    # Guards: dir must exist, be owned by us, be a git repo, and never be
    # $HOME or /. No mkdir -p: only ever create the single ".tagconn" dir.
    if [ -n "$rd" ] && [ -O "$rd" ] && [ -e "$rd/.git" ] && [ -n "$rh" ] && [ "$rd" != "$rh" ] && [ "$rd" != "/" ]; then
      # Skip if .tagconn already exists as a file or symlink - never touch or
      # follow it. A plain file named .tagconn is how a user opts back out (see
      # the README itself). An existing real, owned .tagconn directory that
      # holds only agent working files (work/, .gitignore - the office-kickoff
      # skill creates them) still gets its README, never overwriting anything.
      agent_only=0
      if [ -d "$rd/.tagconn" ] && [ ! -L "$rd/.tagconn" ] && [ -O "$rd/.tagconn" ] && [ ! -e "$rd/.tagconn/README.md" ] && [ ! -L "$rd/.tagconn/README.md" ]; then
        agent_only=1
        for entry in "$rd/.tagconn"/* "$rd/.tagconn"/.[!.]* "$rd/.tagconn"/..?*; do
          [ -e "$entry" ] || [ -L "$entry" ] || continue
          case "${entry##*/}" in
            work|.gitignore) ;;
            *) agent_only=0 ;;
          esac
        done
      fi
      if [ ! -L "$rd/.tagconn" ] && [ -f "$tpl" ] && { [ "$agent_only" = "1" ] || [ ! -e "$rd/.tagconn" ]; }; then
        if [ "$agent_only" = "1" ] || mkdir "$rd/.tagconn" 2>/dev/null; then
          # Re-check (SC4 L2): close the window between mkdir succeeding and
          # the write below - something could have raced us and swapped
          # .tagconn for a symlink in between. Then `cd` into it and write a
          # relative path: once `cd` resolves, the write targets that exact
          # directory inode even if the path component is later replaced.
          # (L3: this re-check plus the cd-then-relative-write is the sh
          # equivalent of the node hook's O_NOFOLLOW + dev/ino comparison.)
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
              # The directory the profile was read from: the server never auto-applies a profile whose
              # source lies outside the session's floor (it asks the admin instead).
              set --
              src_b64=$(printf '%s' "$rd" | base64 2>/dev/null | tr -d '\n') || src_b64=""
              [ -z "$src_b64" ] || set -- -H "x-tagconn-project-root: $src_b64"
              printf '%s' "$payload" | curl -s -o /dev/null \
                --connect-timeout 0.3 \
                -m 1 \
                -K "$attrconf" \
                -H "x-tagconn-session-id: $sid" \
                "$@" \
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
