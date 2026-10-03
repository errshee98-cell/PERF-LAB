// Runs API (port 4000) and Vite (port 5173) together; Ctrl+C stops both.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const procs = [
  ['api', ['--prefix', 'server', 'run', 'dev']],
  ['web', ['--prefix', 'client', 'run', 'dev']],
].map(([name, args]) => {
  const p = spawn(npm, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const tag = (d) => d.toString().split(/\r?\n/).filter(Boolean).map((l) => `[${name}] ${l}`).join('\n') + '\n';
  p.stdout.on('data', (d) => process.stdout.write(tag(d)));
  p.stderr.on('data', (d) => process.stderr.write(tag(d)));
  p.on('exit', (code) => console.log(`[${name}] exited with ${code}`));
  return p;
});
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
