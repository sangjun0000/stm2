# STM2

**Collective Intelligence Memory for AI Agents**

Zero-token-cost persistent memory for Claude Code via hooks + CLAUDE.md. Memories survive across sessions — your AI picks up exactly where it left off.

Inspired by Andrej Karpathy's [LLM OS](https://x.com/kaborashi79/status/1723363906105364646) vision — where LLMs are the CPU of a new operating system, with tools as peripherals and files as persistent storage. STM2 implements the **memory layer** of that OS: a filesystem-backed, graph-structured memory that gives AI agents the ability to remember across sessions, just like an OS kernel manages state across process lifecycles.

## The Problem

AI coding agents have **amnesia**. Every time you start a new conversation:

- Claude doesn't know what you built yesterday
- It forgets the bugs you already fixed
- It re-suggests approaches you already rejected
- It loses track of open tasks and next steps

You end up repeating yourself every session: *"We're using JWT, not sessions. The database is sql.js, not PostgreSQL. The auth module is done, we need to work on rate limiting next."*

This isn't just annoying — it's a **productivity killer**. The longer a project runs, the more context is lost between sessions.

## Why STM2?

### Existing approaches fall short

| Approach | Problem |
|----------|---------|
| Paste context manually | Tedious, error-prone, you forget things too |
| Long CLAUDE.md files | Gets stale, costs tokens every message, manual maintenance |
| Chat history / memory features | Shallow key-value pairs, no relationships, no auto-capture |
| External RAG / vector DB | Heavy infrastructure, overkill for project memory |

### STM2 is different

**1. Zero token cost auto-capture.** Hooks run in the background after every tool use. File edits, git commits, test failures, and errors are captured without Claude spending a single token. You don't have to `remember` anything — it just happens.

**2. CLAUDE.md as the restore point.** Instead of loading hundreds of memories into context, STM2 writes a ~500-token summary directly into CLAUDE.md. When a new session starts, Claude reads it for free as part of project instructions. No tool calls, no token budget, instant context.

**3. Graph memory, not flat storage.** Memories link to each other: an error `caused_by` a decision, a task `depends_on` context, a new decision `supersedes` an old one. This means Claude can trace *why* something happened, not just *what* happened.

**4. Runs anywhere, no infrastructure.** sql.js compiles SQLite to WASM. No native binaries, no Docker, no external services. `npm install` and you're done — Windows, Mac, Linux, CI.

## Quick Start

### 1. Install

```bash
npm install @sangjunsama/stm2
```

### 2. Initialize

```bash
npx stm2 init
```

This creates a `.stm/` directory with the database and folder structure.

### 3. Connect as MCP Server

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "stm2": {
      "command": "node",
      "args": ["./node_modules/@sangjunsama/stm2/dist/mcp/server.js"],
      "env": {
        "STM2_PROJECT_DIR": "/path/to/your/project"
      }
    }
  }
}
```

### 4. Set Up Hooks

Add to your `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "",
        "command": "bash ./node_modules/@sangjunsama/stm2/src/hooks/post-tool-use.sh"
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "command": "bash ./node_modules/@sangjunsama/stm2/src/hooks/session-start.sh"
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "command": "bash ./node_modules/@sangjunsama/stm2/src/hooks/session-end.sh"
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "command": "bash ./node_modules/@sangjunsama/stm2/src/hooks/pre-compact.sh"
      }
    ]
  }
}
```

## MCP Tools

Once connected, Claude gets 5 tools:

| Tool | Description | Example |
|------|-------------|---------|
| `remember` | Store a memory manually | `remember("Chose JWT over session cookies", type: "decision")` |
| `recall` | Search memories by keyword | `recall("authentication")` |
| `forget` | Delete a memory by ID | `forget(node_id: "abc-123")` |
| `status` | Show memory system health | `status()` |
| `lint` | Find stale tasks and orphan memories | `lint()` |

### MCP Resources

| URI | Description |
|-----|-------------|
| `stm2://index` | Full catalog of all memories, grouped by type |
| `stm2://briefing` | Compressed context for session start |

## Memory Types

| Type | When to use | Example |
|------|-------------|---------|
| `decision` | Architecture/design choices | "Chose sql.js over better-sqlite3 for WASM support" |
| `context` | Background information | "Project uses Node 18+ with ES modules" |
| `error` | Bugs and errors encountered | "Auth 401 was caused by expired JWT secret" |
| `task` | Work items for later | "Need to add rate limiting to API endpoints" |
| `milestone` | Completed achievements | "Auth module complete with OAuth2 + JWT" |
| `observation` | Patterns and insights | "Test suite runs 3x faster with --pool=forks" |

## CLI Commands

```bash
stm2 init                 # Initialize .stm/ directory and database
stm2 status               # Show memory stats
stm2 briefing             # Output session briefing
stm2 ingest               # Ingest a raw event into memory
stm2 summarize-session    # Generate session summary
stm2 update-claude-md     # Sync CLAUDE.md with current memory state
stm2 update-index         # Regenerate .stm/base/index.md
stm2 orbit                # Re-link all memories (rebuild edges)
stm2 authorize <agent-id> # Authorize an agent to write to base namespace
```

## How It Works

### Auto-Capture (Hooks)

STM2 hooks into Claude Code's lifecycle events:

```
PostToolUse → detects edits, commits, errors, test results → stores in DB
SessionStart → outputs briefing → Claude gets context immediately
SessionEnd → summarizes session → updates CLAUDE.md + index
PreCompact → saves state before context window compression
```

All hooks exit 0 and run in the background — they never block Claude.

### Auto-Link

When a memory is stored, STM2 automatically finds related memories and creates edges:

- **Entity matching** — shared file paths, tech names (React, JWT, etc.), ticket numbers
- **Type-aware edges** — errors link to decisions via `caused_by`, tasks link to context via `depends_on`
- **Supersedes detection** — newer decisions about the same topic automatically supersede older ones

### Zero-Token Context Restore — How?

Most memory systems cost tokens to use: the agent calls a `recall` tool, gets results back, and those results consume context window space. STM2 takes a fundamentally different approach.

```
┌─────────────────────────────────────────────────────────┐
│  Traditional Memory System                              │
│                                                         │
│  Session Start                                          │
│    → Agent calls recall("what was I working on?")       │
│    → 500 tokens consumed for the query                  │
│    → 2000 tokens consumed for the results               │
│    → Total: ~2500 tokens spent just to restore context  │
│    → Repeats every session                              │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  STM2                                                   │
│                                                         │
│  Session End (previous session)                         │
│    → Hook runs: summarize → write to CLAUDE.md          │
│    → Cost: 0 tokens (hooks run outside Claude)          │
│                                                         │
│  Session Start (new session)                            │
│    → Claude reads CLAUDE.md as project instructions     │
│    → This happens AUTOMATICALLY, before any tool call   │
│    → Cost: 0 additional tokens (CLAUDE.md is always     │
│      loaded regardless — STM2 just fills it with        │
│      useful content instead of leaving it empty)        │
│                                                         │
│  Result: Full context restored, 0 extra tokens          │
└─────────────────────────────────────────────────────────┘
```

The key insight: **CLAUDE.md is always loaded into context at session start**. It's a fixed cost that every Claude Code project pays. STM2 turns this "free" space into a living memory summary — recent sessions, open tasks, key decisions, recent errors — all within a ~500 token budget. Nothing extra is spent.

The `recall` tool still exists for deep searches, but for 90% of sessions, CLAUDE.md alone provides enough context to continue seamlessly.

### CLAUDE.md Sync

The `session-end` hook writes a dynamic section to CLAUDE.md:

```markdown
## STM2 Context (auto-generated, do not edit manually)

### Recent Sessions
- [2026-04-06] Auth module complete, 21 tests passing

### Open Tasks
- [ ] Publish to npm registry

### Key Decisions
- Chose sql.js over better-sqlite3 for WASM support
```

This section is capped at ~500 tokens so it never bloats the context window.

## Architecture

```
src/
├── core/
│   ├── database.ts     # sql.js database with nodes, edges, sessions, agents
│   ├── types.ts        # TypeScript interfaces for all entities
│   ├── ingest.ts       # Event parsing pipeline (edit, commit, error, test, etc.)
│   ├── auto-link.ts    # Entity extraction + automatic edge creation
│   ├── claude-md.ts    # CLAUDE.md dynamic section updater
│   └── setup.ts        # Initialization utilities
├── mcp/
│   └── server.ts       # MCP server (remember, recall, forget, status, lint)
├── hooks/
│   ├── post-tool-use.sh   # Captures edits, commits, errors
│   ├── session-start.sh   # Outputs briefing
│   ├── session-end.sh     # Summarize + update CLAUDE.md + index
│   └── pre-compact.sh     # Save state before compression
├── cli.ts              # CLI entry point
└── index.ts            # Library exports
```

### Data Model

```
Node (memory)              Edge (relationship)
┌────────────────┐        ┌──────────────────┐
│ id             │───────→│ from_node        │
│ namespace      │        │ to_node          │
│ type           │        │ edge_type        │
│ content        │        │ weight           │
│ summary        │        └──────────────────┘
│ tags[]         │
│ access_count   │        Edge types:
│ created_at     │        caused_by, depends_on,
└────────────────┘        supersedes, related_to,
                          part_of, led_to, summarizes
```

## Development

```bash
npm install        # Install dependencies
npm run build      # Compile TypeScript
npm test           # Run tests (vitest)
npm run dev        # Watch mode
npm run lint       # ESLint
```

## Requirements

- Node.js >= 18
- Claude Code (for hooks and MCP integration)
- `jq` (for hook scripts to parse JSON)

## License

MIT
