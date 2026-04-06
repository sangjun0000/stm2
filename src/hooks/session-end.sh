#!/bin/bash
# STM2 SessionEnd Hook — summarize + update CLAUDE.md + update index
command -v jq >/dev/null 2>&1 || exit 0

CWD=$(cat | jq -r '.cwd // empty')
[ ! -d "$CWD/.stm" ] && exit 0

cli() { node "$CWD/dist/cli.js" "$@" 2>/dev/null || true; }

cli summarize-session
cli update-claude-md
cli update-index

exit 0
