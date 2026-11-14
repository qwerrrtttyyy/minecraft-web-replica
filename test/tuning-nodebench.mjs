import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function timeSync(cmd, label) {
  const t0 = performance.now();
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
  const t1 = performance.now();
  console.log(`${label}: ${Math.round(t1 - t0)}ms`);
  return t1 - t0;
}

const distExists = fs.existsSync(path.join(ROOT, 'dist', 'index.html'));
if (!distExists) {
  timeSync('npm run build', 'initial build');
}

timeSync('npm run test:snapshot', 'test:snapshot');
timeSync('npm run test:logic', 'test:logic');
timeSync('npm run test:light', 'test:light');
timeSync('npm run test:mesher', 'test:mesher');
timeSync('npm run test:services', 'test:services');
timeSync('npm run build', 'rebuild (typecheck + vite)');
