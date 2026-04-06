import fs from 'node:fs';
import path from 'node:path';

export function generateHooksConfig(projectDir: string): object {
  const hooksDir = path.join(projectDir, '.claude', 'hooks');

  return {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit',
          hooks: [{
            type: 'command',
            command: `node ${projectDir}/dist/cli.js ingest --type edit --data "$(cat | jq -r '.tool_input.file_path // empty')"`,
            timeout: 5000
          }]
        },
        {
          matcher: 'Bash',
          hooks: [{
            type: 'command',
            command: path.join(projectDir, '.stm', 'hooks', 'post-tool-use.sh'),
            timeout: 5000
          }]
        }
      ],
      SessionEnd: [
        {
          hooks: [{
            type: 'command',
            command: path.join(projectDir, '.stm', 'hooks', 'session-end.sh'),
            timeout: 30000
          }]
        }
      ],
      PreCompact: [
        {
          matcher: 'auto|manual',
          hooks: [{
            type: 'command',
            command: path.join(projectDir, '.stm', 'hooks', 'pre-compact.sh'),
            timeout: 10000
          }]
        }
      ],
      SessionStart: [
        {
          matcher: 'startup|resume|compact',
          hooks: [{
            type: 'command',
            command: path.join(projectDir, '.stm', 'hooks', 'session-start.sh'),
            timeout: 5000
          }]
        }
      ]
    }
  };
}

export function installHooks(projectDir: string): void {
  const hooksDir = path.join(projectDir, '.stm', 'hooks');
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  // Copy hook scripts from src/hooks to .stm/hooks
  const srcHooksDir = path.join(projectDir, 'src', 'hooks');
  if (fs.existsSync(srcHooksDir)) {
    for (const file of fs.readdirSync(srcHooksDir)) {
      if (file.endsWith('.sh')) {
        const src = path.join(srcHooksDir, file);
        const dest = path.join(hooksDir, file);
        fs.copyFileSync(src, dest);
        try { fs.chmodSync(dest, 0o755); } catch { /* Windows */ }
      }
    }
  }
}

export function printHooksConfig(projectDir: string): void {
  const config = generateHooksConfig(projectDir);
  console.log('\nAdd this to your .claude/settings.json:');
  console.log(JSON.stringify(config, null, 2));
}
