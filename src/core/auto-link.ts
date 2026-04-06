import type { StmDatabase } from './database.js';
import type { MemoryNode, EdgeType } from './types.js';

// Entity patterns for auto-detection
const FILE_PATH_RE = /(?:src|lib|app|pages|components|tests|config)\/[\w/.-]+\.\w+/g;
const TECH_NAMES_RE = /\b(Redis|PostgreSQL|TypeScript|JavaScript|React|Next\.js|Express|JWT|OAuth|Docker|Kubernetes|GraphQL|REST|API|SQL|MongoDB|Prisma|Vitest|Jest|ESLint|Webpack|Vite|Node\.js|Python|Go|Rust)\b/gi;
const TICKET_RE = /(?:#\d+|[A-Z]+-\d+)/g;

interface ExtractedEntities {
  filePaths: string[];
  techNames: string[];
  tickets: string[];
}

export class AutoLinker {
  constructor(private db: StmDatabase) {}

  /**
   * Run auto-linking for a newly inserted node.
   * Finds related nodes by entity overlap and tag matching.
   */
  linkNode(nodeId: string): number {
    const node = this.db.getNode(nodeId);
    if (!node) return 0;

    const entities = this.extractEntities(node.content);
    const candidates = this.findCandidates(node, entities);

    let edgesCreated = 0;

    for (const candidate of candidates) {
      if (candidate.id === nodeId) continue;

      const edgeType = this.determineEdgeType(node, candidate, entities);
      if (edgeType) {
        this.db.insertEdge(nodeId, candidate.id, edgeType);
        edgesCreated++;
      }
    }

    // Supersedes detection: same type + high content overlap
    if (node.type === 'decision') {
      edgesCreated += this.detectSupersedes(node);
    }

    return edgesCreated;
  }

  /**
   * Run auto-linking across ALL nodes (for orbit/rebuild).
   */
  linkAll(): { checked: number; edgesCreated: number } {
    const allNodes = this.db.getNodesByNamespace('base', 1000);
    let totalEdges = 0;

    for (let i = 0; i < allNodes.length; i++) {
      for (let j = i + 1; j < allNodes.length; j++) {
        const a = allNodes[i];
        const b = allNodes[j];

        // Check existing edge
        const existingFrom = this.db.getEdgesFrom(a.id);
        if (existingFrom.some(e => e.toNode === b.id)) continue;

        const existingTo = this.db.getEdgesTo(a.id);
        if (existingTo.some(e => e.fromNode === b.id)) continue;

        const entitiesA = this.extractEntities(a.content);
        const entitiesB = this.extractEntities(b.content);

        const overlap = this.entityOverlap(entitiesA, entitiesB);
        if (overlap >= 1) {
          this.db.insertEdge(a.id, b.id, 'related_to');
          totalEdges++;
        }
      }
    }

    return { checked: allNodes.length, edgesCreated: totalEdges };
  }

  private extractEntities(content: string): ExtractedEntities {
    return {
      filePaths: [...content.matchAll(FILE_PATH_RE)].map(m => m[0].toLowerCase()),
      techNames: [...content.matchAll(TECH_NAMES_RE)].map(m => m[0].toLowerCase()),
      tickets: [...content.matchAll(TICKET_RE)].map(m => m[0])
    };
  }

  private findCandidates(node: MemoryNode, entities: ExtractedEntities): MemoryNode[] {
    const candidates: MemoryNode[] = [];

    // Search by tech names and file paths
    const searchTerms = [...entities.techNames, ...entities.filePaths, ...entities.tickets];

    for (const term of searchTerms.slice(0, 5)) {
      const results = this.db.searchContent(term, node.namespace, 10);
      for (const r of results) {
        if (!candidates.some(c => c.id === r.id)) {
          candidates.push(r);
        }
      }
    }

    // Also check by shared tags
    if (node.tags.length > 0) {
      for (const tag of node.tags.slice(0, 3)) {
        const results = this.db.searchContent(tag, node.namespace, 10);
        for (const r of results) {
          if (!candidates.some(c => c.id === r.id)) {
            candidates.push(r);
          }
        }
      }
    }

    return candidates;
  }

  private entityOverlap(a: ExtractedEntities, b: ExtractedEntities): number {
    let overlap = 0;

    for (const fp of a.filePaths) {
      if (b.filePaths.includes(fp)) overlap++;
    }
    for (const tn of a.techNames) {
      if (b.techNames.includes(tn)) overlap++;
    }
    for (const t of a.tickets) {
      if (b.tickets.includes(t)) overlap++;
    }

    return overlap;
  }

  private determineEdgeType(node: MemoryNode, candidate: MemoryNode, entities: ExtractedEntities): EdgeType | null {
    const candidateEntities = this.extractEntities(candidate.content);
    const overlap = this.entityOverlap(entities, candidateEntities);

    if (overlap === 0) return null;

    // Error caused by decision
    if (node.type === 'error' && candidate.type === 'decision') return 'caused_by';
    if (candidate.type === 'error' && node.type === 'decision') return 'caused_by';

    // Task depends on context
    if (node.type === 'task' && candidate.type === 'context') return 'depends_on';
    if (candidate.type === 'task' && node.type === 'context') return 'depends_on';

    // Same file path = part_of
    if (entities.filePaths.some(fp => candidateEntities.filePaths.includes(fp))) return 'part_of';

    // Default: related
    if (overlap >= 1) return 'related_to';

    return null;
  }

  private detectSupersedes(node: MemoryNode): number {
    const decisions = this.db.getNodesByType(node.namespace, 'decision', 20);
    let edgesCreated = 0;

    for (const d of decisions) {
      if (d.id === node.id) continue;

      // Simple word overlap check (v1: no embeddings)
      const nodeWords = new Set(node.content.toLowerCase().split(/\s+/));
      const dWords = new Set(d.content.toLowerCase().split(/\s+/));

      let shared = 0;
      for (const w of nodeWords) {
        if (w.length > 3 && dWords.has(w)) shared++;
      }

      const overlapRatio = shared / Math.min(nodeWords.size, dWords.size);
      if (overlapRatio > 0.3 && node.createdAt > d.createdAt) {
        this.db.insertEdge(node.id, d.id, 'supersedes');
        edgesCreated++;
      }
    }

    return edgesCreated;
  }
}
