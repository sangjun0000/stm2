export type MemoryType =
  | 'decision'
  | 'context'
  | 'error'
  | 'task'
  | 'milestone'
  | 'observation'
  | 'summary';

export type EdgeType =
  | 'caused_by'
  | 'depends_on'
  | 'supersedes'
  | 'related_to'
  | 'part_of'
  | 'led_to'
  | 'summarizes';

export interface MemoryNode {
  id: string;
  namespace: string;
  type: MemoryType;
  content: string;
  summary: string | null;
  tags: string[];
  mdPath: string | null;
  accessCount: number;
  lastAccessed: string | null;
  createdAt: string;
  updatedAt: string;
  embedding: Buffer | null;
}

export interface MemoryEdge {
  id: string;
  fromNode: string;
  toNode: string;
  edgeType: EdgeType;
  weight: number;
  createdAt: string;
}

export interface Session {
  id: string;
  agentId: string | null;
  namespace: string | null;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
}

export interface Agent {
  id: string;
  namespace: string;
  authorized: boolean;
  createdAt: string;
}

export interface IngestEvent {
  type: 'edit' | 'commit' | 'error' | 'test' | 'decision' | 'fix' | 'task' | 'milestone' | 'context';
  toolName?: string;
  data: string;
  output?: string;
  timestamp: string;
}

export interface SessionSummary {
  currentWork: string;
  decisions: string[];
  nextSteps: string[];
  errorsResolved: string[];
}

export interface RecallOptions {
  query: string;
  scope: 'own' | 'base' | 'all' | 'global';
  detail: boolean;
  limit: number;
  contextBudgetTokens: number;
}

export interface ClaudeMdSection {
  projectSummary: string;
  recentSessions: string[];
  openTasks: string[];
  keyDecisions: string[];
  recentErrors: string[];
}
