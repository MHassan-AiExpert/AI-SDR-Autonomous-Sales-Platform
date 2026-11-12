// Loads every workflow in /workflows into n8n before the main instance starts,
// so the repository is the single source of truth for workflows.
//
// - Each file carries a fixed workflow id, so importing again updates the
//   workflow instead of creating a copy.
// - Workflows marked "active": true are published after import.
// Runs as a one-shot container with the same n8n image and database settings.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ID_PATTERN = /^[A-Za-z0-9]{16}$/;

/** Reads and checks workflow files; returns what to import and publish. */
export function planImport(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const seen = new Set();
  const workflows = files.map((file) => {
    const wf = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (typeof wf.id !== 'string' || !ID_PATTERN.test(wf.id)) throw new Error(`${file}: "id" must be 16 letters or digits`);
    if (seen.has(wf.id)) throw new Error(`${file}: id ${wf.id} is used by another workflow`);
    if (typeof wf.name !== 'string' || !wf.name.trim()) throw new Error(`${file}: "name" is required`);
    if (!Array.isArray(wf.nodes) || !wf.nodes.length) throw new Error(`${file}: "nodes" is empty`);
    if (typeof wf.active !== 'boolean') throw new Error(`${file}: "active" must be true or false`);
    seen.add(wf.id);
    return { file, id: wf.id, name: wf.name, active: wf.active };
  });
  return {
    workflows,
    commands: [
      ...(workflows.length ? [['import:workflow', '--separate', `--input=${dir}`]] : []),
      ...workflows.filter((w) => w.active).map((w) => ['publish:workflow', `--id=${w.id}`]),
    ],
  };
}

function main() {
  const dir = process.env.WORKFLOWS_DIR || '/workflows';
  const { workflows, commands } = planImport(dir);
  console.log(JSON.stringify({ level: 'info', message: 'importing workflows', count: workflows.length, names: workflows.map((w) => w.name) }));
  for (const args of commands) {
    const r = spawnSync('n8n', args, { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(JSON.stringify({ level: 'error', message: 'workflow import step failed', step: args.join(' '), status: r.status }));
      process.exit(1);
    }
  }
  console.log(JSON.stringify({ level: 'info', message: 'workflows ready', published: workflows.filter((w) => w.active).length }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
