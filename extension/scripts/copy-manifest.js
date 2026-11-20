import fs from 'fs';
import path from 'path';

const srcManifest = path.resolve('manifest.json');
const distManifest = path.resolve('dist', 'manifest.json');

if (fs.existsSync(srcManifest) && fs.existsSync(path.resolve('dist'))) {
  fs.copyFileSync(srcManifest, distManifest);
  console.log('[Build] Copied manifest.json to dist/manifest.json');
}
