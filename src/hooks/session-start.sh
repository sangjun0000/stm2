#!/bin/bash
# STM2 SessionStart Hook — output briefing to stdout (injected as system reminder)
command -v jq >/dev/null 2>&1 || exit 0
CWD=$(cat | jq -r '.cwd // empty')
[ ! -f "$CWD/.stm/stm2.db" ] && exit 0

node "$CWD/dist/cli.js" briefing 2>/dev/null
exit 0
