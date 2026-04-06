import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StmDatabase } from '../src/core/database.js';
import { AutoLinker } from '../src/core/auto-link.js';
import { IngestPipeline } from '../src/core/ingest.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let db: StmDatabase;
let dbPath: string;

beforeEach(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stm2-link-'));
  dbPath = path.join(tmpDir, 'test.db');
  db = new StmDatabase(dbPath);
  await db.ensureReady();
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

describe('AutoLinker', () => {
  it('should link nodes sharing tech names', () => {
    const n1 = db.insertNode('base', 'decision', 'Use Redis for session caching', ['redis']);
    const n2 = db.insertNode('base', 'error', 'Redis connection refused ECONNREFUSED', ['redis']);

    const linker = new AutoLinker(db);
    const edges = linker.linkNode(n2.id);

    expect(edges).toBeGreaterThanOrEqual(1);
    const edgesFrom = db.getEdgesFrom(n2.id);
    expect(edgesFrom.some(e => e.toNode === n1.id)).toBe(true);
  });

  it('should link nodes sharing file paths', () => {
    const n1 = db.insertNode('base', 'context', 'Edited src/auth/middleware.ts for JWT validation');
    const n2 = db.insertNode('base', 'error', 'Test failed in src/auth/middleware.ts line 42');

    const linker = new AutoLinker(db);
    linker.linkNode(n2.id);

    const edgesFrom = db.getEdgesFrom(n2.id);
    const edgesTo = db.getEdgesTo(n2.id);
    const allEdges = [...edgesFrom, ...edgesTo];
    expect(allEdges.some(e => e.fromNode === n2.id || e.toNode === n2.id)).toBe(true);
  });

  it('should detect supersedes for same-topic decisions', () => {
    const n1 = db.insertNode('base', 'decision', 'Use Redis for caching because fast');
    // Wait a bit to ensure different timestamp
    const n2 = db.insertNode('base', 'decision', 'Use Redis for caching with TTL 3600s and poolSize 10');

    const linker = new AutoLinker(db);
    linker.linkNode(n2.id);

    const edgesFrom = db.getEdgesFrom(n2.id);
    const supersedes = edgesFrom.filter(e => e.edgeType === 'supersedes');
    expect(supersedes.length).toBeGreaterThanOrEqual(1);
  });

  it('should link all nodes with linkAll', () => {
    db.insertNode('base', 'decision', 'Use Redis for auth sessions');
    db.insertNode('base', 'context', 'Redis config: port 6379, TTL 3600');
    db.insertNode('base', 'error', 'Redis ECONNREFUSED on startup');

    const linker = new AutoLinker(db);
    const result = linker.linkAll();

    expect(result.checked).toBe(3);
    expect(result.edgesCreated).toBeGreaterThanOrEqual(1);
  });
});

describe('IngestPipeline with auto-linking', () => {
  it('should auto-link on ingest', () => {
    const pipeline = new IngestPipeline(db);

    pipeline.ingest({ type: 'decision', data: 'Use Redis for caching', timestamp: new Date().toISOString() });
    pipeline.ingest({ type: 'error', data: 'Redis connection timeout', timestamp: new Date().toISOString() });

    const stats = db.getStats();
    expect(stats.totalNodes).toBe(2);
    // Auto-linking should have created at least one edge
    expect(stats.totalEdges).toBeGreaterThanOrEqual(1);
  });
});

describe('Multi-agent namespaces', () => {
  it('should isolate agent memories', () => {
    db.insertNode('base', 'decision', 'Shared decision about Redis');
    db.insertNode('agent-coder', 'context', 'Working on src/auth.ts');
    db.insertNode('agent-reviewer', 'context', 'Found type safety issue');

    expect(db.getNodesByNamespace('base').length).toBe(1);
    expect(db.getNodesByNamespace('agent-coder').length).toBe(1);
    expect(db.getNodesByNamespace('agent-reviewer').length).toBe(1);
  });

  it('should register agents with authorization', () => {
    const coder = db.getOrCreateAgent('coder');
    expect(coder.authorized).toBe(false);
    expect(coder.namespace).toBe('agent-coder');

    const coordinator = db.getOrCreateAgent('coordinator');
    db.authorizeAgent('coordinator');
    expect(db.isAuthorized('coordinator')).toBe(true);
    expect(db.isAuthorized('coder')).toBe(false);
  });

  it('should search across namespaces', () => {
    db.insertNode('base', 'decision', 'Use Redis for caching');
    db.insertNode('agent-coder', 'context', 'Redis config in src/redis.ts');

    // Search without namespace = all
    const allResults = db.searchContent('Redis');
    expect(allResults.length).toBe(2);

    // Search with namespace = filtered
    const baseOnly = db.searchContent('Redis', 'base');
    expect(baseOnly.length).toBe(1);
  });

  it('should track sessions per agent', () => {
    const s1 = db.startSession('coder', 'agent-coder');
    db.endSession(s1.id, 'Built auth module');

    const s2 = db.startSession('reviewer', 'agent-reviewer');
    db.endSession(s2.id, 'Reviewed auth module');

    const sessions = db.getRecentSessions(5);
    expect(sessions.length).toBe(2);
    expect(sessions.some(s => s.agentId === 'coder')).toBe(true);
    expect(sessions.some(s => s.agentId === 'reviewer')).toBe(true);
  });
});
