import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { StmDatabase } from '../core/database.js';
import { IngestPipeline } from '../core/ingest.js';
import type { MemoryType } from '../core/types.js';

const PROJECT_DIR = process.env.STM2_PROJECT_DIR || process.cwd();
const DB_PATH = path.join(PROJECT_DIR, '.stm', 'stm2.db');

let db: StmDatabase;

async function getDb(): Promise<StmDatabase> {
  if (!db) {
    db = new StmDatabase(DB_PATH);
    await db.ensureReady();
  }
  return db;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const server = new Server(
  { name: 'stm2', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } }
);

// --- Tools ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'recall',
      description: 'Search memories by meaning. Use when CLAUDE.md context isn\'t enough. Returns compressed summaries by default.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'What to search for' },
          scope: { type: 'string', enum: ['own', 'base', 'all'], default: 'all', description: 'Search scope' },
          detail: { type: 'boolean', default: false, description: 'Return full content instead of summaries' },
          limit: { type: 'number', default: 10, description: 'Max results' },
          context_budget_tokens: { type: 'number', default: 2000, description: 'Max tokens in response' }
        },
        required: ['query']
      }
    },
    {
      name: 'remember',
      description: 'Store a memory manually. Hooks auto-capture most things, but use this for insights and synthesis.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'What to remember' },
          type: { type: 'string', enum: ['decision', 'context', 'error', 'task', 'milestone', 'observation'], default: 'context' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for searchability' },
          namespace: { type: 'string', default: 'base', description: 'Memory namespace' }
        },
        required: ['content']
      }
    },
    {
      name: 'lint',
      description: 'Health check: find stale tasks, orphan memories, and memory stats.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          namespace: { type: 'string', default: 'base' }
        }
      }
    },
    {
      name: 'status',
      description: 'Memory system health: node counts, edges, sessions.',
      inputSchema: { type: 'object' as const, properties: {} }
    },
    {
      name: 'forget',
      description: 'Remove a specific memory by ID.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          node_id: { type: 'string', description: 'Memory ID to delete' }
        },
        required: ['node_id']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const database = await getDb();

  switch (name) {
    case 'recall': {
      const query = (args as any).query as string;
      const scope = ((args as any).scope || 'all') as string;
      const detail = (args as any).detail === true;
      const limit = ((args as any).limit || 10) as number;
      const budget = ((args as any).context_budget_tokens || 2000) as number;

      // Search by content (LIKE search for now, FTS5 in future)
      let results = database.searchContent(query, scope === 'base' ? 'base' : undefined, limit * 2);

      // Also search in all namespaces if scope is 'all'
      if (scope === 'all' && results.length < limit) {
        const moreResults = database.searchContent(query, undefined, limit * 2);
        const existingIds = new Set(results.map(r => r.id));
        for (const r of moreResults) {
          if (!existingIds.has(r.id)) results.push(r);
        }
      }

      // Rank by recency
      results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      results = results.slice(0, limit);

      // Build response within token budget
      let totalTokens = 0;
      const lines: string[] = [];

      for (const node of results) {
        const text = detail
          ? `[${node.type}] ${node.content} (${node.createdAt.split('T')[0]})`
          : `[${node.type}] ${node.summary || node.content.slice(0, 100)} (${node.createdAt.split('T')[0]})`;

        const tokens = estimateTokens(text);
        if (totalTokens + tokens > budget) break;

        totalTokens += tokens;
        lines.push(text);
        database.touchNode(node.id);
      }

      return {
        content: [{
          type: 'text',
          text: lines.length > 0
            ? `Found ${results.length} memories (showing ${lines.length}):\n\n${lines.join('\n')}`
            : `No memories found for "${query}"`
        }]
      };
    }

    case 'remember': {
      const content = (args as any).content as string;
      const type = ((args as any).type || 'context') as MemoryType;
      const tags = ((args as any).tags || []) as string[];
      const namespace = ((args as any).namespace || 'base') as string;

      const node = database.insertNode(namespace, type, content, tags, content.slice(0, 80));

      return {
        content: [{
          type: 'text',
          text: `Remembered: "${content.slice(0, 60)}..." (id: ${node.id}, type: ${type})`
        }]
      };
    }

    case 'lint': {
      const namespace = ((args as any)?.namespace || 'base') as string;
      const nodes = database.getNodesByNamespace(namespace, 500);
      const issues: string[] = [];

      // Stale tasks (created > 14 days ago)
      const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const staleTasks = nodes.filter(n => n.type === 'task' && n.createdAt < twoWeeksAgo);
      if (staleTasks.length > 0) {
        issues.push(`${staleTasks.length} stale tasks (> 2 weeks old):`);
        for (const t of staleTasks.slice(0, 5)) {
          issues.push(`  - ${(t.summary || t.content).slice(0, 80)}`);
        }
      }

      // Orphan nodes (no edges)
      let orphanCount = 0;
      for (const n of nodes) {
        const from = database.getEdgesFrom(n.id);
        const to = database.getEdgesTo(n.id);
        if (from.length === 0 && to.length === 0) orphanCount++;
      }
      if (orphanCount > 0) {
        issues.push(`${orphanCount} orphan memories (no connections)`);
      }

      // Stats
      const stats = database.getStats();

      return {
        content: [{
          type: 'text',
          text: issues.length > 0
            ? `Lint found ${issues.length} issues:\n${issues.join('\n')}\n\nStats: ${stats.totalNodes} nodes, ${stats.totalEdges} edges, ${stats.totalSessions} sessions`
            : `No issues found. Stats: ${stats.totalNodes} nodes, ${stats.totalEdges} edges, ${stats.totalSessions} sessions`
        }]
      };
    }

    case 'status': {
      const stats = database.getStats();
      const sessions = database.getRecentSessions(1);
      const lastSession = sessions[0]?.summary || 'none';

      return {
        content: [{
          type: 'text',
          text: `STM2 Status\nMemories: ${stats.totalNodes}\nEdges: ${stats.totalEdges}\nSessions: ${stats.totalSessions}\nNamespaces: ${stats.namespaces.join(', ') || 'none'}\nLast session: ${lastSession.slice(0, 100)}`
        }]
      };
    }

    case 'forget': {
      const nodeId = (args as any).node_id as string;
      const node = database.getNode(nodeId);
      if (!node) {
        return { content: [{ type: 'text', text: `Memory ${nodeId} not found` }] };
      }
      database.deleteNode(nodeId);
      return { content: [{ type: 'text', text: `Deleted: "${(node.summary || node.content).slice(0, 60)}"` }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
});

// --- Resources ---

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'stm2://index',
      name: 'Memory Index',
      description: 'Content catalog of all memories',
      mimeType: 'text/markdown'
    },
    {
      uri: 'stm2://briefing',
      name: 'Session Briefing',
      description: 'Compressed context for session start',
      mimeType: 'text/plain'
    }
  ]
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const database = await getDb();
  const uri = request.params.uri;

  if (uri === 'stm2://index') {
    const nodes = database.getNodesByNamespace('base', 200);
    const byType = new Map<string, typeof nodes>();
    for (const n of nodes) {
      const list = byType.get(n.type) || [];
      list.push(n);
      byType.set(n.type, list);
    }

    let content = '# STM2 Memory Index\n\n';
    for (const [type, items] of byType) {
      content += `## ${type} (${items.length})\n`;
      for (const item of items.slice(0, 15)) {
        content += `- ${(item.summary || item.content).slice(0, 80)} [${item.createdAt.split('T')[0]}]\n`;
      }
      content += '\n';
    }

    return { contents: [{ uri, mimeType: 'text/markdown', text: content }] };
  }

  if (uri === 'stm2://briefing') {
    const sessions = database.getRecentSessions(3);
    const decisions = database.getNodesByType('base', 'decision', 5);
    const tasks = database.getNodesByType('base', 'task', 5);

    const parts: string[] = [];
    if (sessions.length > 0) {
      const lines = sessions.filter(s => s.summary)
        .map(s => `- [${s.startedAt.split('T')[0]}] ${(s.summary || '').slice(0, 100)}`);
      if (lines.length > 0) parts.push(`Sessions:\n${lines.join('\n')}`);
    }
    if (tasks.length > 0) {
      parts.push(`Tasks:\n${tasks.map(t => `- ${(t.summary || t.content).slice(0, 80)}`).join('\n')}`);
    }
    if (decisions.length > 0) {
      parts.push(`Decisions:\n${decisions.map(d => `- ${(d.summary || d.content).slice(0, 80)}`).join('\n')}`);
    }

    return {
      contents: [{
        uri,
        mimeType: 'text/plain',
        text: parts.length > 0 ? parts.join('\n\n') : 'No memories yet.'
      }]
    };
  }

  return { contents: [] };
});

// --- Start ---

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

startServer().catch(console.error);
