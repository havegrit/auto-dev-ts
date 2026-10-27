import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const sourceRoot = join(root, 'src');
const budgetPath = join(root, 'size-budget.json');
const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
const currentFiles = new Map();
const failures = [];

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(path);
    } else if (entry.isFile() && path.endsWith('.ts')) {
      const name = relative(root, path).split('\\').join('/');
      const lines = readFileSync(path, 'utf8').split('\n');
      currentFiles.set(name, lines.length - (lines.at(-1) === '' ? 1 : 0));
    }
  }
}

if (!statSync(sourceRoot).isDirectory()) throw new Error(`Source directory not found: ${sourceRoot}`);
visit(sourceRoot);

for (const [file, lines] of currentFiles) {
  const baseline = budget.files[file];
  if (baseline === undefined) {
    if (lines > budget.limit) failures.push(`${file}: ${lines} lines exceeds ${budget.limit}; add an approved baseline.`);
    continue;
  }
  if (lines < baseline) {
    failures.push(`${file}: shrank from ${baseline} to ${lines}; lower its baseline in size-budget.json.`);
  } else if (lines > baseline + budget.maxGrowth) {
    failures.push(`${file}: ${lines} lines exceeds baseline ${baseline} by more than ${budget.maxGrowth}.`);
  }
}

for (const file of Object.keys(budget.files)) {
  if (!currentFiles.has(file)) failures.push(`${file}: registered size-budget file no longer exists.`);
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Size budget passed for ${currentFiles.size} TypeScript files.\n`);
}
