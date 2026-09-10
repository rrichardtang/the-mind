#!/bin/bash
# Bootstrap: clone-or-update this repo's cache, then run its install.sh. Copied to
# ~/.claude/session-start.sh by install.sh and wired as a user-level SessionStart hook,
# so every session in every project self-refreshes. Also committed here so a repo can
# vendor it as its own project hook — needed where ~/.claude does not persist between
# sessions (Claude Code on the web), since there the user-level hook is gone by the time
# it would run and something inside the repo has to bootstrap the first sync.
set -euo pipefail

CONFIG_REPO="https://github.com/rrichardtang/claude-config"
CONFIG_CACHE="${HOME}/.cache/claude-config"
LOCK_FILE="${CONFIG_CACHE}.lock"

mkdir -p "$(dirname "$CONFIG_CACHE")"
exec 9>"$LOCK_FILE"
flock 9

if [ -d "$CONFIG_CACHE/.git" ]; then
  # fetch+reset rather than pull --ff-only: self-heals from a force-push or an
  # interrupted prior run, where a stale-but-present .git would otherwise make
  # this branch permanently unreachable and the cache stuck on an old revision.
  # Fetch CONFIG_REPO directly rather than the cache's own "origin" remote, so
  # a stale or unrelated pre-existing cache can't silently keep syncing from
  # the wrong URL.
  git -C "$CONFIG_CACHE" fetch --depth 1 "$CONFIG_REPO" main
  git -C "$CONFIG_CACHE" reset --hard FETCH_HEAD
else
  rm -rf "$CONFIG_CACHE"
  GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --branch main "$CONFIG_REPO" "$CONFIG_CACHE"
fi

bash "$CONFIG_CACHE/install.sh"
