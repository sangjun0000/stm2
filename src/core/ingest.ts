import type { StmDatabase } from './database.js';
import { AutoLinker } from './auto-link.js';
import type { IngestEvent, MemoryType } from './types.js';

export class IngestPipeline {
  private autoLinker: AutoLinker;

  constructor(private db: StmDatabase) {
    this.autoLinker = new AutoLinker(db);
  }

  ingest(event: IngestEvent, namespace = 'base'): string | null {
    // Sanitize input: cap length, strip null bytes
    event.data = this.sanitize(event.data, 2000);
    if (event.output) event.output = this.sanitize(event.output, 1000);

    const parsed = this.parseEvent(event);
    if (!parsed) return null;

    // Deduplicate: if a similar memory exists, just bump it instead of creating a new one
    const dedupeKey = this.getDedupeKey(event, parsed);
    if (dedupeKey) {
      const existing = this.db.findDuplicate(namespace, parsed.type, dedupeKey);
      if (existing) {
        this.db.touchNode(existing.id);
        return existing.id;
      }
    }

    const node = this.db.insertNode(
      namespace,
      parsed.type,
      parsed.content,
      parsed.tags,
      parsed.summary
    );

    // Auto-link after insert
    try {
      this.autoLinker.linkNode(node.id);
    } catch { /* non-blocking */ }

    return node.id;
  }

  private getDedupeKey(event: IngestEvent, parsed: { type: string; content: string }): string | null {
    switch (event.type) {
      case 'edit': {
        // Dedupe by filename: "Edited: server.ts" repeated → same node
        const filePath = this.extractFilePath(event.data);
        return filePath ? `Edited: ${filePath}` : null;
      }
      case 'error': {
        // Dedupe by first line of error
        const firstLine = (event.output || event.data).split('\n')[0].slice(0, 100);
        return firstLine || null;
      }
      case 'test': {
        // Dedupe by pass/fail result
        const output = event.output || event.data;
        return /pass/i.test(output) && !/fail/i.test(output) ? 'Test: PASSED' : 'Test: FAILED';
      }
      // commits, decisions, tasks, milestones are always unique
      default:
        return null;
    }
  }

  private parseEvent(event: IngestEvent): {
    type: MemoryType;
    content: string;
    tags: string[];
    summary: string;
  } | null {
    switch (event.type) {
      case 'edit':
        return this.parseEdit(event);
      case 'commit':
        return this.parseCommit(event);
      case 'error':
        return this.parseError(event);
      case 'test':
        return this.parseTest(event);
      case 'decision':
        return this.parseDecision(event);
      case 'fix':
        return this.parseFix(event);
      case 'task':
        return { type: 'task', content: event.data, tags: ['task'], summary: event.data.slice(0, 80) };
      case 'milestone':
        return { type: 'milestone', content: event.data, tags: ['milestone'], summary: event.data.slice(0, 80) };
      case 'context':
        return { type: 'context', content: event.data, tags: ['context'], summary: event.data.slice(0, 80) };
      default:
        return null;
    }
  }

  private parseEdit(event: IngestEvent): { type: MemoryType; content: string; tags: string[]; summary: string } {
    const filePath = this.extractFilePath(event.data);
    const tags = filePath ? [filePath] : [];

    return {
      type: 'context',
      content: `File edited: ${event.data}`,
      tags,
      summary: `Edit: ${filePath || event.data.slice(0, 80)}`
    };
  }

  private parseCommit(event: IngestEvent): { type: MemoryType; content: string; tags: string[]; summary: string } {
    const message = this.extractCommitMessage(event.data);
    const type: MemoryType = message.startsWith('feat') ? 'milestone'
      : message.startsWith('fix') ? 'error'
      : 'context';

    return {
      type,
      content: `Git commit: ${message}`,
      tags: ['git'],
      summary: `Commit: ${message.slice(0, 80)}`
    };
  }

  private parseError(event: IngestEvent): { type: MemoryType; content: string; tags: string[]; summary: string } {
    const errorText = event.output || event.data;
    const firstLine = errorText.split('\n')[0].slice(0, 200);

    return {
      type: 'error',
      content: errorText.slice(0, 500),
      tags: ['error'],
      summary: `Error: ${firstLine.slice(0, 80)}`
    };
  }

  private parseTest(event: IngestEvent): { type: MemoryType; content: string; tags: string[]; summary: string } {
    const output = event.output || event.data;
    const passed = /pass/i.test(output) && !/fail/i.test(output);

    return {
      type: passed ? 'milestone' : 'error',
      content: `Test result: ${output.slice(0, 500)}`,
      tags: ['test'],
      summary: `Test: ${passed ? 'PASSED' : 'FAILED'} — ${output.split('\n')[0].slice(0, 60)}`
    };
  }

  private parseDecision(event: IngestEvent): { type: MemoryType; content: string; tags: string[]; summary: string } {
    return {
      type: 'decision',
      content: event.data,
      tags: ['decision'],
      summary: event.data.slice(0, 80)
    };
  }

  private parseFix(event: IngestEvent): { type: MemoryType; content: string; tags: string[]; summary: string } {
    return {
      type: 'error',
      content: `Fix applied: ${event.data}`,
      tags: ['fix'],
      summary: `Fix: ${event.data.slice(0, 80)}`
    };
  }

  private extractFilePath(data: string): string | null {
    const match = data.match(/(?:src|lib|app|pages|components)\/[\w/.-]+\.\w+/);
    return match ? match[0] : null;
  }

  private extractCommitMessage(data: string): string {
    const match = data.match(/-m\s+["'](.+?)["']/);
    return match ? match[1] : data.slice(0, 200);
  }

  private sanitize(input: string, maxLen: number): string {
    return input
      .replace(/\0/g, '')        // strip null bytes
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // strip control chars (keep \n \r \t)
      .slice(0, maxLen);
  }
}
