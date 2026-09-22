import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';

const server = await createServer();
await server.listen();
const env = { ...process.env, CODEX_DESK_DEV_URL: 'http://127.0.0.1:5178' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env, windowsHide: true });
const close = async () => { child.kill(); await server.close(); };
process.on('SIGINT', close);
process.on('SIGTERM', close);
child.on('error', async (error) => { console.error(error.message); await close(); process.exitCode = 1; });
child.on('exit', async (code) => { await server.close(); process.exitCode = code ?? 0; });
