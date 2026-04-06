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
    // Get top memories by importance (decay × recall boost)
    const topNodes = this.db.getNodesByImportance('base', 30);

    // Group by type
    const byType = new Map<string, typeof topNodes>();
    for (const n of topNodes) {
      const list = byType.get(n.type) || [];
      list.push(n);
      byType.set(n.type, list);
    }

    const fmt = (n: typeof topNodes[0]) => (n.summary || n.content).slice(0, 80);

    // Project summary from top context nodes
    const contexts = byType.get('context') || [];
    const projectSummary = contexts.slice(0, 3).map(fmt).join('. ').slice(0, 200);

    // Recent sessions (still time-based — sessions don't have importance)
    const sessions = this.db.getRecentSessions(3);
    const recentSessions = sessions
      .filter(s => s.summary)
      .map(s => {
        const date = s.startedAt.split('T')[0];
        return `[${date}] ${(s.summary || '').slice(0, 100)}`;
      });

    const openTasks = (byType.get('task') || []).map(fmt);
    const keyDecisions = (byType.get('decision') || []).map(fmt);
    const recentErrors = (byType.get('error') || []).map(fmt);

    return { projectSummary, recentSessions, openTasks, keyDecisions, recentErrors };
  }

  private truncateToFit(data: ClaudeMdSection): string {
    // Fill within budget — importance already sorted, just fit what we can
    let section = `${SECTION_START}\n\n`;

    const addIfFits = (heading: string, items: string[], prefix = '- '): boolean => {
      if (items.length === 0) return true;
      // Try adding items one by one until budget is hit
      const fittingItems: string[] = [];
      for (const item of items) {
        const candidate = `${prefix}${item}\n`;
        const headingSize = fittingItems.length === 0 ? `### ${heading}\n`.length : 0;
        if (section.length + headingSize + fittingItems.join('').length + candidate.length + 2 + SECTION_END.length <= MAX_CHARS) {
          fittingItems.push(candidate);
        } else {
          break;
        }
      }
      if (fittingItems.length > 0) {
        section += `### ${heading}\n${fittingItems.join('')}\n`;
      }
      return fittingItems.length > 0;
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
