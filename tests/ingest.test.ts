import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StmDatabase } from '../src/core/database.js';
import { IngestPipeline } from '../src/core/ingest.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let db: StmDatabase;
let dbPath: string;
let pipeline: IngestPipeline;

beforeEach(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stm2-ingest-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  db = new StmDatabase(dbPath);
  await db.ensureReady();
  pipeline = new IngestPipeline(db);
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

describe('IngestPipeline', () => {
  describe('deduplication', () => {
    it('should deduplicate repeated file edits', () => {
      const id1 = pipeline.ingest({
        type: 'edit',
        data: 'Edited: src/server.ts',
        timestamp: new Date().toISOString()
      });
      const id2 = pipeline.ingest({
        type: 'edit',
        data: 'Edited: src/server.ts',
        timestamp: new Date().toISOString()
      });

      // Second ingest should return the same node (deduped)
      expect(id1).toBe(id2);

      // Only 1 node should exist
      const nodes = db.getNodesByNamespace('base');
      expect(nodes.length).toBe(1);

      // Access count should be bumped
      const node = db.getNode(id1!)!;
      expect(node.accessCount).toBe(1); // touchNode was called once for the dedup
    });

    it('should NOT deduplicate different file edits', () => {
      const id1 = pipeline.ingest({
        type: 'edit',
        data: 'Edited: src/server.ts',
        timestamp: new Date().toISOString()
      });
      const id2 = pipeline.ingest({
        type: 'edit',
        data: 'Edited: src/auth.ts',
        timestamp: new Date().toISOString()
      });

      expect(id1).not.toBe(id2);
      const nodes = db.getNodesByNamespace('base');
      expect(nodes.length).toBe(2);
    });

    it('should deduplicate repeated same errors', () => {
      const id1 = pipeline.ingest({
        type: 'error',
        data: 'npm test',
        output: 'TypeError: Cannot read properties of undefined\nat line 42',
        timestamp: new Date().toISOString()
      });
      const id2 = pipeline.ingest({
        type: 'error',
        data: 'npm test',
        output: 'TypeError: Cannot read properties of undefined\nat line 42',
        timestamp: new Date().toISOString()
      });

      expect(id1).toBe(id2);
      const nodes = db.getNodesByNamespace('base');
      expect(nodes.length).toBe(1);
    });

    it('should NOT deduplicate commits', () => {
      const id1 = pipeline.ingest({
        type: 'commit',
        data: 'git commit -m "feat: add auth"',
        timestamp: new Date().toISOString()
      });
      const id2 = pipeline.ingest({
        type: 'commit',
        data: 'git commit -m "fix: auth bug"',
        timestamp: new Date().toISOString()
      });

      expect(id1).not.toBe(id2);
      const nodes = db.getNodesByNamespace('base');
      expect(nodes.length).toBe(2);
    });
  });
});
