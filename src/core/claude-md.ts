import fs from 'node:fs';
import path from 'node:path';
import type { StmDatabase } from './database.js';
import type { ClaudeMdSection } from './types.js';

const SECTION_START = '## STM2 Context (auto-generated, do not edit manually)';
const SECTION_END = '<!-- /STM2 -->';
const MAX_TOKENS = 500;
const CHARS_PER_TOKEN = 4;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

export class ClaudeMdUpdater {
  constructor(
    private db: StmDatabase,
    private projectDir: string
  ) {}

  update(): void {
    const section = this.generateSection();
    const claudeMdPath = path.join(this.projectDir, 'CLAUDE.md');

    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      const updated = this.replaceSection(content, section);
      fs.writeFileSync(claudeMdPath, updated, 'utf-8');
    } else {
      fs.writeFileSync(claudeMdPath, section + '\n', 'utf-8');
    }
  }

  generateSection(): string {
    const data = this.gatherData();
    let section = `${SECTION_START}\n\n`;

    if (data.projectSummary) {
      section += `### Project\n${data.projectSummary}\n\n`;
    }

    if (data.recentSessions.length > 0) {
      section += `### Recent Sessions\n`;
      for (const s of data.recentSessions) {
        section += `- ${s}\n`;
      }
      section += '\n';
    }

    if (data.openTasks.length > 0) {
      section += `### Open Tasks\n`;
      for (const t of data.openTasks) {
        section += `- [ ] ${t}\n`;
      }
      section += '\n';
    }

    if (data.keyDecisions.length > 0) {
      section += `### Key Decisions\n`;
      for (const d of data.keyDecisions) {
        section += `- ${d}\n`;
      }
      section += '\n';
    }

    if (data.recentErrors.length > 0) {
      section += `### Recent Errors\n`;
      for (const e of data.recentErrors) {
        section += `- ${e}\n`;
      }
      section += '\n';
    }

    section += SECTION_END;

    // Truncate if over budget
    if (section.length > MAX_CHARS) {
      section = this.truncateToFit(data);
    }

    return section;
  }

  private gatherData(): ClaudeMdSection {
    // Project summary from context memories
    const contexts = this.db.getNodesByType('base', 'context', 5);
    const projectSummary = contexts
      .map(n => n.summary || n.content)
      .join('. ')
      .slice(0, 200);

    // Recent sessions
    const sessions = this.db.getRecentSessions(3);
    const recentSessions = sessions
      .filter(s => s.summary)
      .map(s => {
        const date = s.startedAt.split('T')[0];
        const summary = (s.summary || '').slice(0, 100);
        return `[${date}] ${summary}`;
      });

    // Open tasks
    const tasks = this.db.getNodesByType('base', 'task', 10);
    const openTasks = tasks
      .map(t => (t.summary || t.content).slice(0, 80));

    // Key decisions
    const decisions = this.db.getNodesByType('base', 'decision', 5);
    const keyDecisions = decisions
      .map(d => (d.summary || d.content).slice(0, 80));

    // Recent errors
    const errors = this.db.getNodesByType('base', 'error', 3);
    const recentErrors = errors
      .map(e => (e.summary || e.content).slice(0, 80));

    return { projectSummary, recentSessions, openTasks, keyDecisions, recentErrors };
  }

  private truncateToFit(data: ClaudeMdSection): string {
    // Priority: open tasks > decisions > sessions > errors > project summary
    // Drop lowest priority items first until under budget
    let section = `${SECTION_START}\n\n`;

    const addIfFits = (heading: string, items: string[], prefix = '- '): boolean => {
      if (items.length === 0) return true;
      const block = `### ${heading}\n${items.map(i => `${prefix}${i}`).join('\n')}\n\n`;
      if (section.length + block.length + SECTION_END.length <= MAX_CHARS) {
        section += block;
        return true;
      }
      return false;
    };

    addIfFits('Open Tasks', data.openTasks, '- [ ] ');
    addIfFits('Key Decisions', data.keyDecisions);
    addIfFits('Recent Sessions', data.recentSessions);
    addIfFits('Recent Errors', data.recentErrors);

    section += SECTION_END;
    return section;
  }

  private replaceSection(content: string, newSection: string): string {
    const startIdx = content.indexOf(SECTION_START);
    const endIdx = content.indexOf(SECTION_END);

    if (startIdx !== -1 && endIdx !== -1) {
      return content.slice(0, startIdx) + newSection + content.slice(endIdx + SECTION_END.length);
    }

    // Append if section doesn't exist yet
    return content.trimEnd() + '\n\n' + newSection + '\n';
  }
}
