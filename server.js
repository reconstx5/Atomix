#!/usr/bin/env node
// Atomix — start with `npm start` (or `node server.js`).
import os from 'node:os';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Atomix needs Node.js 22.13 or newer (you have ${process.version}).`);
  console.error('Download the current LTS from https://nodejs.org and try again.');
  process.exit(1);
}

const { createApp } = await import('./src/app.js');

let app;
try {
  app = await createApp();
  const address = await app.start();
  const port = address.port;
  const lines = [`  Local:   http://localhost:${port}`];
  if (app.config.host === '0.0.0.0' || app.config.host === '::') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) lines.push(`  Network: http://${net.address}:${port}`);
      }
    }
  }
  console.log(`\n  Atomix ${app.core.version} is running\n\n${lines.join('\n')}\n`);
  console.log(`  Data folder: ${app.config.dataDir}\n  Press Ctrl+C to stop.\n`);
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${err.port} is already in use. Stop the other program or set ATOMIX_PORT to another port.`);
  } else {
    console.error(err);
  }
  process.exit(1);
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) process.exit(1);
  stopping = true;
  console.log(`\n${signal} received, shutting down…`);
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  try {
    await app.stop();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
