import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StmDatabase } from '../src/core/database.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let db: StmDatabase;
let dbPath: string;

beforeEach(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stm2-mcp-'));
  dbPath = path.join(tmpDir, 'test.db');
  db = new StmDatabase(dbPath);
  await db.ensureReady();
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

describe('MCP Tool Logic', () => {
  describe('recall (search)', () => {
    it('should find memories by content search', () => {
      db.insertNode('base', 'decision', 'Use Redis for caching because latency < 5ms', ['redis']);
      db.insertNode('base', 'context', 'TypeScript strict mode enabled', ['typescript']);
      db.insertNode('base', 'error', 'Redis connection refused ECONNREFUSED', ['redis', 'error']);

      const results = db.searchContent('Redis');
      expect(results.length).toBe(2);
      expect(results.every(r => r.content.includes('Redis'))).toBe(true);
    });

    it('should filter by namespace', () => {
      db.insertNode('base', 'decision', 'Redis decision');
      db.insertNode('agent-coder', 'context', 'Redis config details');

      const baseOnly = db.searchContent('Redis', 'base');
      expect(baseOnly.length).toBe(1);
      expect(baseOnly[0].namespace).toBe('base');
    });

    it('should respect limit', () => {
      for (let i = 0; i < 20; i++) {
        db.insertNode('base', 'context', `Memory item ${i} about Redis`);
      }

      const results = db.searchContent('Redis', 'base', 5);
      expect(results.length).toBe(5);
    });

    it('should increment access count on touch', () => {
      const node = db.insertNode('base', 'decision', 'Important decision about Redis');
      expect(node.accessCount).toBe(0);

      db.touchNode(node.id);
      db.touchNode(node.id);
      db.touchNode(node.id);

      const updated = db.getNode(node.id);
      expect(updated!.accessCount).toBe(3);
    });
  });

  describe('remember', () => {
    it('should store a memory with tags', () => {
      const node = db.insertNode('base', 'decision', 'Use JWT for auth', ['auth', 'jwt'], 'JWT auth decision');

      const retrieved = db.getNode(node.id);
      expect(retrieved!.content).toBe('Use JWT for auth');
      expect(retrieved!.tags).toEqual(['auth', 'jwt']);
      expect(retrieved!.summary).toBe('JWT auth decision');
    });

    it('should store in specific namespace', () => {
      db.insertNode('agent-coder', 'context', 'Working on auth module');

      const nodes = db.getNodesByNamespace('agent-coder');
      expect(nodes.length).toBe(1);

      const baseNodes = db.getNodesByNamespace('base');
      expect(baseNodes.length).toBe(0);
    });
  });

  describe('lint', () => {
    it('should detect orphan nodes', () => {
      const n1 = db.insertNode('base', 'decision', 'Orphan decision');
      const n2 = db.insertNode('base', 'context', 'Connected context');
      const n3 = db.insertNode('base', 'error', 'Connected error');

      db.insertEdge(n2.id, n3.id, 'caused_by');

      // n1 has no edges = orphan
      const n1From = db.getEdgesFrom(n1.id);
      const n1To = db.getEdgesTo(n1.id);
      expect(n1From.length + n1To.length).toBe(0);

      // n2, n3 have edges = not orphans
      const n2From = db.getEdgesFrom(n2.id);
      expect(n2From.length).toBe(1);
    });
  });

  describe('forget', () => {
    it('should delete a memory and its edges', () => {
      const n1 = db.insertNode('base', 'decision', 'To be deleted');
      const n2 = db.insertNode('base', 'context', 'Related context');
      db.insertEdge(n1.id, n2.id, 'related_to');

      db.deleteNode(n1.id);

      expect(db.getNode(n1.id)).toBeNull();
      expect(db.getEdgesFrom(n1.id).length).toBe(0);
      expect(db.getEdgesTo(n1.id).length).toBe(0);
      // n2 still exists
      expect(db.getNode(n2.id)).not.toBeNull();
    });
  });

  describe('briefing generation', () => {
    it('should generate briefing from sessions and nodes', () => {
      db.insertNode('base', 'decision', 'Use Redis', [], 'Redis decision');
      db.insertNode('base', 'task', 'Implement rate limiting', [], 'Rate limiting');

      const session = db.startSession();
      db.endSession(session.id, 'Built auth module with Redis');

      const sessions = db.getRecentSessions(3);
      const decisions = db.getNodesByType('base', 'decision', 5);
      const tasks = db.getNodesByType('base', 'task', 5);

      expect(sessions.length).toBe(1);
      expect(sessions[0].summary).toBe('Built auth module with Redis');
      expect(decisions.length).toBe(1);
      expect(tasks.length).toBe(1);
    });
  });
});
