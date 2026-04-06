import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { MemoryNode, MemoryEdge, Agent, Session, MemoryType, EdgeType } from './types.js';

const SCHEMA_VERSION = 2;
const DECAY_LAMBDA = 0.03;
const MS_PER_HOUR = 3_600_000;

export class StmDatabase {
  private db!: SqlJsDatabase;
  private dbPath: string;
  private ready: Promise<void>;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    const SQL = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.db.run('PRAGMA foreign_keys = ON');
    const version = this.getSchemaVersion();
    if (version === 0) {
      this.createSchema();
    } else if (version < SCHEMA_VERSION) {
      this.migrate(version);
    }
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  private getSchemaVersion(): number {
    try {
      const result = this.db.exec('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1');
      if (result.length > 0 && result[0].values.length > 0) {
        return result[0].values[0][0] as number;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  private createSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL DEFAULT 'base',
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        tags TEXT DEFAULT '[]',
        md_path TEXT,
        access_count INTEGER DEFAULT 0,
        last_accessed TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        from_node TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        to_node TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        edge_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        created_at TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        namespace TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL UNIQUE,
        authorized INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    // FTS5 for full-text search
    try {
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts
        USING fts5(content, summary, tokenize='unicode61')
      `);
    } catch {
      // FTS5 may not be available — LIKE fallback will be used
    }

    this.db.run('CREATE INDEX IF NOT EXISTS idx_nodes_namespace ON nodes(namespace)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_nodes_created ON nodes(created_at)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node)');

    this.db.run(`INSERT INTO schema_version (version, applied_at) VALUES (${SCHEMA_VERSION}, datetime('now'))`);

    this.save();
  }

  private migrate(fromVersion: number): void {
    if (fromVersion < 2) {
      // v2: add FTS5 virtual table
      try {
        this.db.run(`
          CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts
          USING fts5(content, summary, tokenize='unicode61')
        `);
        // Backfill existing nodes into FTS
        this.db.run(`
          INSERT INTO nodes_fts(rowid, content, summary)
          SELECT rowid, content, COALESCE(summary, '') FROM nodes
        `);
      } catch {
        // FTS5 may not be available in all sql.js builds — fall back silently
      }
      this.db.run(`INSERT INTO schema_version (version, applied_at) VALUES (2, datetime('now'))`);
      this.save();
    }
  }

  private hasFts(): boolean {
    try {
      this.db.exec("SELECT * FROM nodes_fts LIMIT 0");
      return true;
    } catch {
      return false;
    }
  }

  private save(): void {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  // --- Importance scoring ---

  calcImportance(node: MemoryNode, now = Date.now()): number {
    const ageHours = (now - new Date(node.updatedAt).getTime()) / MS_PER_HOUR;
    const decay = Math.exp(-DECAY_LAMBDA * ageHours);
    const boost = 1 + Math.log(1 + node.accessCount);
    return decay * boost;
  }

  getNodesByImportance(namespace: string, limit = 50): MemoryNode[] {
    const nodes = this.getNodesByNamespace(namespace, 500);
    const now = Date.now();
    const scored = nodes.map(n => ({ node: n, importance: this.calcImportance(n, now) }));
    scored.sort((a, b) => b.importance - a.importance);
    return scored.slice(0, limit).map(s => s.node);
  }

  // --- Deduplication ---

  findDuplicate(namespace: string, type: MemoryType, contentKey: string): MemoryNode | null {
    const likeKey = `%${contentKey}%`;
    const result = this.db.exec(
      `SELECT * FROM nodes WHERE namespace = ? AND type = ? AND content LIKE ? ORDER BY updated_at DESC LIMIT 1`,
      [namespace, type, likeKey]
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return this.resultToNode(result[0].columns, result[0].values[0]);
  }

  // --- Node operations ---

  insertNode(
    namespace: string,
    type: MemoryType,
    content: string,
    tags: string[] = [],
    summary?: string
  ): MemoryNode {
    const id = randomUUID();
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(tags);

    this.db.run(
      `INSERT INTO nodes (id, namespace, type, content, summary, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, namespace, type, content, summary ?? null, tagsJson, now, now]
    );

    // Sync FTS index
    if (this.hasFts()) {
      try {
        const rowResult = this.db.exec('SELECT rowid FROM nodes WHERE id = ?', [id]);
        if (rowResult.length > 0 && rowResult[0].values.length > 0) {
          const rowid = rowResult[0].values[0][0];
          this.db.run(
            'INSERT INTO nodes_fts(rowid, content, summary) VALUES (?, ?, ?)',
            [rowid, content, summary ?? '']
          );
        }
      } catch { /* non-blocking */ }
    }

    this.save();

    return {
      id, namespace, type, content,
      summary: summary ?? null,
      tags, mdPath: null,
      accessCount: 0, lastAccessed: null,
      createdAt: now, updatedAt: now,
      embedding: null
    };
  }

  getNode(id: string): MemoryNode | null {
    const result = this.db.exec('SELECT * FROM nodes WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return this.resultToNode(result[0].columns, result[0].values[0]);
  }

  getNodesByNamespace(namespace: string, limit = 100): MemoryNode[] {
    const result = this.db.exec(
      'SELECT * FROM nodes WHERE namespace = ? ORDER BY created_at DESC LIMIT ?',
      [namespace, limit]
    );
    if (result.length === 0) return [];
    return result[0].values.map(v => this.resultToNode(result[0].columns, v));
  }

  getNodesByType(namespace: string, type: MemoryType, limit = 50): MemoryNode[] {
    const result = this.db.exec(
      'SELECT * FROM nodes WHERE namespace = ? AND type = ? ORDER BY created_at DESC LIMIT ?',
      [namespace, type, limit]
    );
    if (result.length === 0) return [];
    return result[0].values.map(v => this.resultToNode(result[0].columns, v));
  }

  searchContent(query: string, namespace?: string, limit = 20): MemoryNode[] {
    // Try FTS5 first, fall back to LIKE
    if (this.hasFts()) {
      try {
        const ftsQuery = query.replace(/['"]/g, ''); // sanitize for FTS
        let sql = `SELECT n.* FROM nodes n
          INNER JOIN nodes_fts f ON n.rowid = f.rowid
          WHERE nodes_fts MATCH ?`;
        const params: any[] = [ftsQuery];

        if (namespace) {
          sql += ' AND n.namespace = ?';
          params.push(namespace);
        }
        sql += ' LIMIT ?';
        params.push(limit);

        const result = this.db.exec(sql, params);
        if (result.length > 0 && result[0].values.length > 0) {
          return result[0].values.map(v => this.resultToNode(result[0].columns, v));
        }
      } catch { /* FTS query failed — fall through to LIKE */ }
    }

    // LIKE fallback
    const likeQuery = `%${query}%`;
    let sql = 'SELECT * FROM nodes WHERE content LIKE ?';
    const params: any[] = [likeQuery];

    if (namespace) {
      sql += ' AND namespace = ?';
      params.push(namespace);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const result = this.db.exec(sql, params);
    if (result.length === 0) return [];
    return result[0].values.map(v => this.resultToNode(result[0].columns, v));
  }

  touchNode(id: string): void {
    this.db.run(
      `UPDATE nodes SET access_count = access_count + 1, last_accessed = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      [id]
    );
    this.save();
  }

  deleteNode(id: string): void {
    // Remove from FTS index before deleting the node
    if (this.hasFts()) {
      try {
        const rowResult = this.db.exec('SELECT rowid FROM nodes WHERE id = ?', [id]);
        if (rowResult.length > 0 && rowResult[0].values.length > 0) {
          const rowid = rowResult[0].values[0][0];
          this.db.run('INSERT INTO nodes_fts(nodes_fts, rowid, content, summary) VALUES (\'delete\', ?, (SELECT content FROM nodes WHERE id = ?), COALESCE((SELECT summary FROM nodes WHERE id = ?), \'\'))', [rowid, id, id]);
        }
      } catch { /* non-blocking */ }
    }
    this.db.run('DELETE FROM edges WHERE from_node = ? OR to_node = ?', [id, id]);
    this.db.run('DELETE FROM nodes WHERE id = ?', [id]);
    this.save();
  }

  // --- Edge operations ---

  insertEdge(fromNode: string, toNode: string, edgeType: EdgeType, weight = 1.0): MemoryEdge {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.run(
      `INSERT OR IGNORE INTO edges (id, from_node, to_node, edge_type, weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, fromNode, toNode, edgeType, weight, now]
    );
    this.save();

    return { id, fromNode, toNode, edgeType, weight, createdAt: now };
  }

  getEdgesFrom(nodeId: string): MemoryEdge[] {
    const result = this.db.exec('SELECT * FROM edges WHERE from_node = ?', [nodeId]);
    if (result.length === 0) return [];
    return result[0].values.map(v => this.resultToEdge(result[0].columns, v));
  }

  getEdgesTo(nodeId: string): MemoryEdge[] {
    const result = this.db.exec('SELECT * FROM edges WHERE to_node = ?', [nodeId]);
    if (result.length === 0) return [];
    return result[0].values.map(v => this.resultToEdge(result[0].columns, v));
  }

  getConnectedNodes(nodeId: string, maxHops = 2): MemoryNode[] {
    const visited = new Set<string>([nodeId]);
    let frontier = [nodeId];

    for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
      const nextFrontier: string[] = [];
      for (const nid of frontier) {
        const edges = [...this.getEdgesFrom(nid), ...this.getEdgesTo(nid)];
        for (const e of edges) {
          const neighbor = e.fromNode === nid ? e.toNode : e.fromNode;
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
          }
        }
      }
      frontier = nextFrontier;
    }

    visited.delete(nodeId);
    const nodes: MemoryNode[] = [];
    for (const nid of visited) {
      const node = this.getNode(nid);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  // --- Session operations ---

  startSession(agentId?: string, namespace?: string): Session {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO sessions (id, agent_id, namespace, started_at) VALUES (?, ?, ?, ?)',
      [id, agentId ?? null, namespace ?? null, now]
    );
    this.save();
    return { id, agentId: agentId ?? null, namespace: namespace ?? null, startedAt: now, endedAt: null, summary: null };
  }

  endSession(id: string, summary: string): void {
    this.db.run(`UPDATE sessions SET ended_at = datetime('now'), summary = ? WHERE id = ?`, [summary, id]);
    this.save();
  }

  getRecentSessions(limit = 3): Session[] {
    const result = this.db.exec('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?', [limit]);
    if (result.length === 0) return [];
    return result[0].values.map(v => {
      const cols = result[0].columns;
      return {
        id: v[cols.indexOf('id')] as string,
        agentId: v[cols.indexOf('agent_id')] as string | null,
        namespace: v[cols.indexOf('namespace')] as string | null,
        startedAt: v[cols.indexOf('started_at')] as string,
        endedAt: v[cols.indexOf('ended_at')] as string | null,
        summary: v[cols.indexOf('summary')] as string | null
      };
    });
  }

  // --- Agent operations ---

  getOrCreateAgent(agentId: string): Agent {
    const result = this.db.exec('SELECT * FROM agents WHERE id = ?', [agentId]);
    if (result.length > 0 && result[0].values.length > 0) {
      const cols = result[0].columns;
      const v = result[0].values[0];
      return {
        id: v[cols.indexOf('id')] as string,
        namespace: v[cols.indexOf('namespace')] as string,
        authorized: !!(v[cols.indexOf('authorized')] as number),
        createdAt: v[cols.indexOf('created_at')] as string
      };
    }

    const namespace = `agent-${agentId}`;
    const now = new Date().toISOString();
    this.db.run('INSERT INTO agents (id, namespace, authorized, created_at) VALUES (?, ?, 0, ?)', [agentId, namespace, now]);
    this.save();
    return { id: agentId, namespace, authorized: false, createdAt: now };
  }

  authorizeAgent(agentId: string): void {
    this.db.run('UPDATE agents SET authorized = 1 WHERE id = ?', [agentId]);
    this.save();
  }

  isAuthorized(agentId: string): boolean {
    const result = this.db.exec('SELECT authorized FROM agents WHERE id = ?', [agentId]);
    if (result.length === 0 || result[0].values.length === 0) return false;
    return result[0].values[0][0] === 1;
  }

  // --- Stats ---

  getStats(): { totalNodes: number; totalEdges: number; totalSessions: number; namespaces: string[] } {
    const nodes = this.db.exec('SELECT COUNT(*) as c FROM nodes');
    const edges = this.db.exec('SELECT COUNT(*) as c FROM edges');
    const sessions = this.db.exec('SELECT COUNT(*) as c FROM sessions');
    const ns = this.db.exec('SELECT DISTINCT namespace FROM nodes');

    return {
      totalNodes: (nodes[0]?.values[0]?.[0] as number) ?? 0,
      totalEdges: (edges[0]?.values[0]?.[0] as number) ?? 0,
      totalSessions: (sessions[0]?.values[0]?.[0] as number) ?? 0,
      namespaces: ns.length > 0 ? ns[0].values.map(v => v[0] as string) : []
    };
  }

  close(): void {
    this.save();
    this.db.close();
  }

  // --- Helpers ---

  private resultToNode(columns: string[], values: any[]): MemoryNode {
    const get = (col: string) => values[columns.indexOf(col)];
    return {
      id: get('id') as string,
      namespace: get('namespace') as string,
      type: get('type') as MemoryType,
      content: get('content') as string,
      summary: get('summary') as string | null,
      tags: JSON.parse((get('tags') as string) || '[]'),
      mdPath: get('md_path') as string | null,
      accessCount: get('access_count') as number,
      lastAccessed: get('last_accessed') as string | null,
      createdAt: get('created_at') as string,
      updatedAt: get('updated_at') as string,
      embedding: null
    };
  }

  private resultToEdge(columns: string[], values: any[]): MemoryEdge {
    const get = (col: string) => values[columns.indexOf(col)];
    return {
      id: get('id') as string,
      fromNode: get('from_node') as string,
      toNode: get('to_node') as string,
      edgeType: get('edge_type') as EdgeType,
      weight: get('weight') as number,
      createdAt: get('created_at') as string
    };
  }
}
