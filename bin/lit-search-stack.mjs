#!/usr/bin/env node
/**
 * Start the whole lit-search-mcp stack: the seven cyanheads upstream servers in
 * HTTP mode plus the router. One supervisor process, eight children, one shared
 * set for every MCP client on the machine.
 *
 * A child that exits is restarted after a short delay. SIGINT/SIGTERM stop all.
 * Ports and host come from lib/config.mjs (environment overridable).
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, MCP_PATH, ROUTER_PORT, UPSTREAMS, upstreamPort } from '../lib/config.mjs';

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RESTART_DELAY_MS = 3000;

function entryPoint(pkg) {
  const manifestPath = require.resolve(`${pkg}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin ?? {})[0];
  if (!bin) throw new Error(`${pkg} declares no executable`);
  return join(dirname(manifestPath), bin);
}

const children = [
  ...Object.entries(UPSTREAMS).map(([source, { pkg }]) => ({
    name: source,
    script: entryPoint(pkg),
    env: {
      MCP_TRANSPORT_TYPE: 'http',
      MCP_HTTP_HOST: HOST,
      MCP_HTTP_PORT: String(upstreamPort(source)),
      MCP_HTTP_ENDPOINT_PATH: MCP_PATH,
    },
  })),
  { name: 'router', script: join(ROOT, 'index.mjs'), env: {} },
];

let stopping = false;
const running = new Map();

function start(child) {
  const proc = spawn(process.execPath, [child.script], {
    env: { ...process.env, ...child.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(child.name, proc);
  const tag = `[${child.name}]`;
  for (const stream of [proc.stdout, proc.stderr]) {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) if (line) console.log(tag, line);
    });
  }
  proc.on('exit', (code, signal) => {
    running.delete(child.name);
    if (stopping) return;
    console.error(`${tag} exited (${signal ?? code}); restarting in ${RESTART_DELAY_MS / 1000}s`);
    setTimeout(() => { if (!stopping) start(child); }, RESTART_DELAY_MS);
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const proc of running.values()) proc.kill('SIGTERM');
  setTimeout(() => {
    for (const proc of running.values()) proc.kill('SIGKILL');
    process.exit(0);
  }, 5000).unref();
  const check = setInterval(() => {
    if (running.size === 0) { clearInterval(check); process.exit(0); }
  }, 100);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

for (const child of children) start(child);
console.log(`lit-search-mcp stack: ${children.length} processes; router at http://${HOST}:${ROUTER_PORT}${MCP_PATH}`);
