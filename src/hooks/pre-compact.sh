#!/bin/bash
# STM2 PreCompact Hook — save state before context compression
command -v jq >/dev/null 2>&1 || exit 0
CWD=$(cat | jq -r '.cwd // empty')
[ ! -d "$CWD/.stm" ] && exit 0

node "$CWD/dist/cli.js" summarize-session 2>/dev/null
exit 0
