import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StmDatabase } from '../src/core/database.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let db: StmDatabase;
let dbPath: string;

beforeEach(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stm2-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  db = new StmDatabase(dbPath);
  await db.ensureReady();
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

describe('StmDatabase', () => {
  describe('nodes', () => {
    it('should insert and retrieve a node', () => {
      const node = db.insertNode('base', 'decision', 'Use Redis for caching', ['redis', 'cache']);
      expect(node.id).toBeDefined();
      expect(node.namespace).toBe('base');
      expect(node.type).toBe('decision');
      expect(node.content).toBe('Use Redis for caching');
      expect(node.tags).toEqual(['redis', 'cache']);

      const retrieved = db.getNode(node.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.content).toBe('Use Redis for caching');
    });

    it('should get nodes by namespace', () => {
      db.insertNode('base', 'decision', 'Decision 1');
      db.insertNode('base', 'context', 'Context 1');
      db.insertNode('agent-coder', 'context', 'Agent context');

      const baseNodes = db.getNodesByNamespace('base');
      expect(baseNodes.length).toBe(2);

      const agentNodes = db.getNodesByNamespace('agent-coder');
      expect(agentNodes.length).toBe(1);
    });

    it('should get nodes by type', () => {
      db.insertNode('base', 'decision', 'Decision 1');
      db.insertNode('base', 'decision', 'Decision 2');
      db.insertNode('base', 'error', 'Error 1');

      const decisions = db.getNodesByType('base', 'decision');
      expect(decisions.length).toBe(2);

      const errors = db.getNodesByType('base', 'error');
      expect(errors.length).toBe(1);
    });

    it('should touch node and increment access count', () => {
      const node = db.insertNode('base', 'context', 'Some context');
      expect(node.accessCount).toBe(0);

      db.touchNode(node.id);
      const updated = db.getNode(node.id);
      expect(updated!.accessCount).toBe(1);
    });

    it('should delete node and cascade edges', () => {
      const n1 = db.insertNode('base', 'decision', 'Node 1');
      const n2 = db.insertNode('base', 'decision', 'Node 2');
      db.insertEdge(n1.id, n2.id, 'related_to');

      db.deleteNode(n1.id);
      expect(db.getNode(n1.id)).toBeNull();
      expect(db.getEdgesFrom(n1.id).length).toBe(0);
    });
  });

  describe('edges', () => {
    it('should create and retrieve edges', () => {
      const n1 = db.insertNode('base', 'decision', 'Redis');
      const n2 = db.insertNode('base', 'error', 'Connection refused');

      const edge = db.insertEdge(n1.id, n2.id, 'caused_by');
      expect(edge.edgeType).toBe('caused_by');

      const fromEdges = db.getEdgesFrom(n1.id);
      expect(fromEdges.length).toBe(1);
      expect(fromEdges[0].toNode).toBe(n2.id);
    });

    it('should traverse connected nodes', () => {
      const n1 = db.insertNode('base', 'decision', 'Redis');
      const n2 = db.insertNode('base', 'context', 'Auth module');
      const n3 = db.insertNode('base', 'error', 'Connection error');

      db.insertEdge(n1.id, n2.id, 'related_to');
      db.insertEdge(n2.id, n3.id, 'caused_by');

      const connected = db.getConnectedNodes(n1.id, 2);
      expect(connected.length).toBe(2);
    });
  });

  describe('content search', () => {
    it('should find nodes by content', () => {
      db.insertNode('base', 'decision', 'Redis selected for caching layer');
      db.insertNode('base', 'context', 'TypeScript strict mode enabled');

      const results = db.searchContent('Redis');
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('Redis');
    });
  });

  describe('sessions', () => {
    it('should start and end a session', () => {
      const session = db.startSession('coder-1', 'agent-coder-1');
      expect(session.id).toBeDefined();

      db.endSession(session.id, 'Built auth module');

      const recent = db.getRecentSessions(1);
      expect(recent.length).toBe(1);
      expect(recent[0].summary).toBe('Built auth module');
    });
  });

  describe('agents', () => {
    it('should auto-register agent', () => {
      const agent = db.getOrCreateAgent('coder-1');
      expect(agent.namespace).toBe('agent-coder-1');
      expect(agent.authorized).toBe(false);
    });

    it('should authorize agent', () => {
      db.getOrCreateAgent('coordinator');
      db.authorizeAgent('coordinator');
      expect(db.isAuthorized('coordinator')).toBe(true);
    });
  });

  describe('stats', () => {
    it('should return correct stats', () => {
      db.insertNode('base', 'decision', 'D1');
      db.insertNode('agent-x', 'context', 'C1');

      const stats = db.getStats();
      expect(stats.totalNodes).toBe(2);
      expect(stats.namespaces).toContain('base');
      expect(stats.namespaces).toContain('agent-x');
    });
  });
});
