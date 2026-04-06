#!/bin/bash
# STM2 PostToolUse Hook — captures edits, commits, errors
# Zero token cost. Exit 0 always.
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Only proceed if .stm exists
[ ! -d "$CWD/.stm" ] && exit 0

# Use temp file to safely pass data (avoids shell injection via special chars)
TMPDATA=$(mktemp 2>/dev/null || echo "/tmp/stm2-hook-$$")
trap 'rm -f "$TMPDATA"' EXIT

cli() {
  node "$CWD/dist/cli.js" "$@" 2>/dev/null || true
}

case "$TOOL_NAME" in
  Edit|Write|MultiEdit)
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    if [ -n "$FILE_PATH" ]; then
      cli ingest --type edit --data "Edited: ${FILE_PATH##*/}"
    fi
    ;;
  Bash)
    CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' | head -c 200)
    OUTPUT=$(echo "$INPUT" | jq -r '.tool_output // empty' | head -c 300)

    # Sanitize: strip control chars and quotes that break bash args
    CMD=$(printf '%s' "$CMD" | tr -d '\000-\037' | tr '"' "'")
    OUTPUT=$(printf '%s' "$OUTPUT" | tr -d '\000-\037' | tr '"' "'")

    # Git commits
    if echo "$CMD" | grep -q "git commit"; then
      cli ingest --type commit --data "$CMD"
    fi

    # Test results
    if echo "$CMD" | grep -qE "npm test|vitest|jest|pytest"; then
      if echo "$OUTPUT" | grep -qi "fail\|error"; then
        cli ingest --type error --data "Test failed" --output "$OUTPUT"
      else
        cli ingest --type test --data "Tests passed" --output "$OUTPUT"
      fi
    fi

    # General errors (but skip if already captured as test error)
    if echo "$OUTPUT" | grep -qi "error\|exception\|ENOENT\|EACCES"; then
      if ! echo "$CMD" | grep -qE "npm test|vitest|jest|pytest"; then
        cli ingest --type error --data "$CMD" --output "$OUTPUT"
      fi
    fi
    ;;
esac

exit 0
