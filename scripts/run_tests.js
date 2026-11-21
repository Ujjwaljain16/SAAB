import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const testDir = path.resolve('test');
if (!fs.existsSync(testDir)) {
  console.error('Test directory not found:', testDir);
  process.exit(1);
}

const files = fs.readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join('test', f));

if (files.length === 0) {
  console.log('No test files found in test/');
  process.exit(0);
}

const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.on('exit', (code) => {
  process.exit(code ?? 0);
});
