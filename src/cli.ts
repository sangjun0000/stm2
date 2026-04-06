#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import { StmDatabase } from './core/database.js';
import { ClaudeMdUpdater } from './core/claude-md.js';
import { IngestPipeline } from './core/ingest.js';
import { AutoLinker } from './core/auto-link.js';
import type { IngestEvent } from './core/types.js';

const STM_DIR = '.stm';
const DB_FILE = 'stm2.db';

function getProjectDir(): string {
  return process.cwd();
}

function getStmDir(): string {
  return path.join(getProjectDir(), STM_DIR);
}

function getDbPath(): string {
  return path.join(getStmDir(), DB_FILE);
}

function ensureStmDir(): void {
  const stmDir = getStmDir();
  if (!fs.existsSync(stmDir)) {
    fs.mkdirSync(stmDir, { recursive: true });
  }
}

async function openDb(): Promise<StmDatabase> {
  ensureStmDir();
  const db = new StmDatabase(getDbPath());
  await db.ensureReady();
  return db;
}

function appendLog(entry: string): void {
  const logPath = path.join(getStmDir(), 'base', 'log.md');
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.appendFileSync(logPath, `## [${timestamp}] ${entry}\n`, 'utf-8');
}

// --- Commands ---

async function cmdInit(): Promise<void> {
  ensureStmDir();
  const dirs = ['base', 'base/decisions', 'base/errors', 'base/context', 'base/tasks', 'agents'];
  for (const d of dirs) {
    const full = path.join(getStmDir(), d);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
  }

  const db = await openDb();
  db.close();

  console.log(`STM2 initialized in ${getStmDir()}`);
  console.log('Directories created: base/, agents/');
  console.log('Database created: stm2.db');
}

async function cmdIngest(type: string, data: string, output?: string): Promise<void> {
  const db = await openDb();
  const pipeline = new IngestPipeline(db);

  const event: IngestEvent = {
    type: type as IngestEvent['type'],
    data,
    output,
    timestamp: new Date().toISOString()
  };

  const nodeId = pipeline.ingest(event);
  if (nodeId) {
    appendLog(`${type} | ${data.slice(0, 100)}`);
    console.log(`Ingested: ${nodeId}`);
  } else {
    console.log('Nothing to ingest');
  }

  db.close();
}

async function cmdSummarizeSession(): Promise<void> {
  const db = await openDb();

  const nodes = db.getNodesByNamespace('base', 50);
  if (nodes.length === 0) {
    console.log('No memories to summarize');
    db.close();
    return;
  }

  const decisions = nodes.filter(n => n.type === 'decision').map(n => n.summary || n.content);
  const errors = nodes.filter(n => n.type === 'error').map(n => n.summary || n.content);
  const tasks = nodes.filter(n => n.type === 'task').map(n => n.summary || n.content);
  const milestones = nodes.filter(n => n.type === 'milestone').map(n => n.summary || n.content);

  const parts: string[] = [];
  if (milestones.length > 0) parts.push(`Completed: ${milestones.slice(0, 3).join('; ')}`);
  if (decisions.length > 0) parts.push(`Decisions: ${decisions.slice(0, 3).join('; ')}`);
  if (errors.length > 0) parts.push(`Errors fixed: ${errors.slice(0, 3).join('; ')}`);
  if (tasks.length > 0) parts.push(`Open tasks: ${tasks.slice(0, 3).join('; ')}`);

  const summary = parts.join('. ').slice(0, 500);

  const session = db.startSession();
  db.endSession(session.id, summary);
  db.insertNode('base', 'summary', summary, ['session-summary'], summary.slice(0, 80));

  appendLog(`session-end | ${summary.slice(0, 100)}`);
  console.log(`Session summarized: ${summary.slice(0, 100)}`);

  db.close();
}

async function cmdUpdateClaudeMd(): Promise<void> {
  const db = await openDb();
  const updater = new ClaudeMdUpdater(db, getProjectDir());
  updater.update();
  console.log('CLAUDE.md updated with STM2 context');
  db.close();
}

async function cmdUpdateIndex(): Promise<void> {
  const db = await openDb();
  const nodes = db.getNodesByNamespace('base', 200);

  const indexPath = path.join(getStmDir(), 'base', 'index.md');
  let content = `# Memory Index\nLast updated: ${new Date().toISOString()}\n\n`;

  const byType = new Map<string, typeof nodes>();
  for (const n of nodes) {
    const list = byType.get(n.type) || [];
    list.push(n);
    byType.set(n.type, list);
  }

  const typeLabels: Record<string, string> = {
    decision: 'Decisions', context: 'Context', error: 'Errors',
    task: 'Open Tasks', milestone: 'Milestones', observation: 'Observations',
    summary: 'Session Summaries'
  };

  for (const [type, label] of Object.entries(typeLabels)) {
    const items = byType.get(type);
    if (items && items.length > 0) {
      content += `## ${label} (${items.length})\n`;
      for (const item of items.slice(0, 20)) {
        const date = item.createdAt.split('T')[0];
        const text = item.summary || item.content.slice(0, 80);
        content += `- ${text} [${date}]\n`;
      }
      content += '\n';
    }
  }

  fs.writeFileSync(indexPath, content, 'utf-8');
  console.log(`Index updated: ${nodes.length} memories indexed`);
  db.close();
}

async function cmdOrbit(): Promise<void> {
  const db = await openDb();
  const linker = new AutoLinker(db);
  const result = linker.linkAll();
  console.log(`Orbit complete: checked ${result.checked} nodes, created ${result.edgesCreated} edges`);
  db.close();
}

async function cmdBriefing(): Promise<void> {
  const db = await openDb();
  const sessions = db.getRecentSessions(3);
  const decisions = db.getNodesByType('base', 'decision', 5);
  const tasks = db.getNodesByType('base', 'task', 5);
  const errors = db.getNodesByType('base', 'error', 3);

  const parts: string[] = [];

  if (sessions.length > 0) {
    const lines = sessions.filter(s => s.summary)
      .map(s => `- [${s.startedAt.split('T')[0]}] ${(s.summary || '').slice(0, 100)}`);
    if (lines.length > 0) parts.push(`Recent sessions:\n${lines.join('\n')}`);
  }
  if (tasks.length > 0) {
    parts.push(`Open tasks:\n${tasks.map(t => `- ${(t.summary || t.content).slice(0, 80)}`).join('\n')}`);
  }
  if (decisions.length > 0) {
    parts.push(`Key decisions:\n${decisions.map(d => `- ${(d.summary || d.content).slice(0, 80)}`).join('\n')}`);
  }
  if (errors.length > 0) {
    parts.push(`Recent errors:\n${errors.map(e => `- ${(e.summary || e.content).slice(0, 80)}`).join('\n')}`);
  }

  if (parts.length > 0) {
    console.log(`STM2 Memory Briefing:\n${parts.join('\n\n')}`);
  }
  db.close();
}

async function cmdStatus(): Promise<void> {
  const db = await openDb();
  const stats = db.getStats();
  const sessions = db.getRecentSessions(1);

  console.log('STM2 Status');
  console.log('───────────');
  console.log(`Memories:   ${stats.totalNodes}`);
  console.log(`Edges:      ${stats.totalEdges}`);
  console.log(`Sessions:   ${stats.totalSessions}`);
  console.log(`Namespaces: ${stats.namespaces.join(', ') || 'none'}`);
  if (sessions.length > 0 && sessions[0].summary) {
    console.log(`Last session: ${sessions[0].summary.slice(0, 80)}`);
  }
  db.close();
}

async function cmdAuthorize(agentId: string): Promise<void> {
  const db = await openDb();
  db.getOrCreateAgent(agentId);
  db.authorizeAgent(agentId);
  console.log(`Agent ${agentId} authorized to write to base`);
  db.close();
}

// --- Main ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'init':
        await cmdInit();
        break;
      case 'ingest': {
        const type = args[args.indexOf('--type') + 1];
        const data = args[args.indexOf('--data') + 1];
        const outputIdx = args.indexOf('--output');
        const output = outputIdx !== -1 ? args[outputIdx + 1] : undefined;
        if (!type || !data) {
          console.error('Usage: stm2 ingest --type <type> --data <json>');
          process.exit(1);
        }
        await cmdIngest(type, data, output);
        break;
      }
      case 'summarize-session':
        await cmdSummarizeSession();
        break;
      case 'update-claude-md':
        await cmdUpdateClaudeMd();
        break;
      case 'update-index':
        await cmdUpdateIndex();
        break;
      case 'briefing':
        await cmdBriefing();
        break;
      case 'orbit':
        await cmdOrbit();
        break;
      case 'status':
        await cmdStatus();
        break;
      case 'authorize': {
        const agentId = args[1];
        if (!agentId) {
          console.error('Usage: stm2 authorize <agent-id>');
          process.exit(1);
        }
        await cmdAuthorize(agentId);
        break;
      }
      default:
        console.log('STM2 — Collective Intelligence Memory for AI Agents\n');
        console.log('Commands:');
        console.log('  init                Initialize .stm/ directory and database');
        console.log('  ingest              Ingest a raw event into memory');
        console.log('  summarize-session   Generate session summary');
        console.log('  update-claude-md    Update CLAUDE.md dynamic section');
        console.log('  update-index        Regenerate index.md from database');
        console.log('  briefing            Output session briefing (for hooks)');
        console.log('  status              Show memory system health');
        console.log('  authorize <id>      Authorize agent to write to base');
        break;
    }
  } catch (err: any) {
    const errLog = path.join(getStmDir(), 'errors.log');
    const errMsg = `[${new Date().toISOString()}] ${command}: ${err.message}\n`;
    try { fs.appendFileSync(errLog, errMsg, 'utf-8'); } catch { /* ignore */ }
    console.error(`STM2 error: ${err.message}`);
    process.exit(0); // Exit 0 — hooks must never block
  }
}

main();
