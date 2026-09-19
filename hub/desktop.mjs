import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function createDesktop() {
  if (process.platform !== 'linux') throw new Error('Virtual desktop requires Linux with Xvfb, xdotool and ImageMagick');
  const child = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const display = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Xvfb startup timed out')); }, 10000);
    let out = '';
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Xvfb exited')); });
    child.stdout.on('data', chunk => {
      out += chunk.toString();
      if (/^\d+\s*$/.test(out)) { clearTimeout(timer); resolve(`:${out.trim()}`); }
    });
    child.stderr.resume();
  });
  const env = { ...process.env, DISPLAY: display };
  return { env,
    async invoke(name, args) {
      if (name === 'computer_screenshot') {
        const { stdout } = await exec('import', ['-window', 'root', 'png:-'], { env, encoding: 'buffer', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
        return { content: [{ type: 'image', mimeType: 'image/png', data: stdout.toString('base64') }] };
      }
      let argv;
      if (name === 'computer_click') argv = ['mousemove', '--sync', String(args.x), String(args.y), 'click', String(args.button ?? 1)];
      else if (name === 'computer_type') argv = ['type', '--clearmodifiers', '--', args.text];
      else if (name === 'computer_key') {
        if (!/^[A-Za-z0-9_+ -]{1,80}$/.test(args.key)) throw new Error('Invalid key combination');
        argv = ['key', '--clearmodifiers', '--', args.key];
      } else throw new Error('Unknown desktop tool');
      await exec('xdotool', argv, { env, timeout: 15000 });
      return { content: [{ type: 'text', text: 'OK' }] };
    },
    async close() {
      if (child.exitCode !== null) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    },
  };
}
