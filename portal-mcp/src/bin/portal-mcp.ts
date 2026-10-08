#!/usr/bin/env node

// STDOUT DISCIPLINE — MUST be the FIRST executable statements before any imports
// that may log on load. Any console.log / .info / .debug / .warn is re-routed to
// stderr to keep stdout pure JSON-RPC for MCP host parsing.
console.log = console.error;
console.info = console.error;
console.debug = console.error;
console.warn = console.error;

import { Command } from 'commander';

import { VERSION } from '../version.js';

const program = new Command();
program.name('portal-mcp').version(VERSION);

program
  .command('serve', { isDefault: true })
  .description(
    'Run as MCP stdio server (default subcommand). Starts or shares the local extension bridge on 127.0.0.1:9224.',
  )
  .action(async () => {
    const { runServer } = await import('../server/index.js');
    await runServer();
  });

program
  .command('install')
  .description('Install Darwinium Portal MCP — writes binary, token, config, and OOB-pairs the extension')
  .action(async () => {
    const { runInstall } = await import('../install/install.js');
    await runInstall({});
  });

program
  .command('doctor')
  .description('Self-diagnostic: pass/fail across binary, token, config, extension, port')
  .option('--json', 'Emit machine-readable JSON for support tickets')
  .action(async (opts: { json?: boolean }) => {
    const { runDoctor } = await import('../install/doctor.js');
    await runDoctor(opts);
  });

program
  .command('rotate-token')
  .description('Generate a new token + fresh OOB pairing code; old token rejects with WS 4401')
  .action(async () => {
    const { runRotateToken } = await import('../install/rotate.js');
    await runRotateToken();
  });

program.parseAsync(process.argv).catch((err) => {
  // Unhandled errors must go to stderr so stdout stays clean.
  console.error(`portal-mcp fatal: ${(err as Error).message}`);
  process.exit(1);
});
