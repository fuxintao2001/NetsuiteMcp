#!/usr/bin/env node

/**
 * CLI interface for keeping NetSuite MCP sessions alive via macOS LaunchAgent
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const command = process.argv[2];

async function main() {
  if (!command || ['help', '--help', '-h'].includes(command)) {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case 'install': {
        const { install } = await import('../dist/daemon/installer.js');
        await install();
        break;
      }
      case 'uninstall': {
        const { uninstall } = await import('../dist/daemon/installer.js');
        await uninstall();
        break;
      }
      case 'status': {
        const { status } = await import('../dist/daemon/installer.js');
        await status();
        break;
      }
      case 'run': {
        const { runKeepAlive } = await import('../dist/daemon/keepalive.js');
        await runKeepAlive();
        break;
      }
      default:
        console.error(`❌ Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n❌ Error executing command "${command}":`, err);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
NetSuite MCP Token Keepalive Daemon CLI

Usage:
  npm run daemon:<command>   or   node scripts/daemon.js <command>

Commands:
  install     Install and load the macOS LaunchAgent (runs keepalive every 25 mins)
  uninstall   Unload and uninstall the macOS LaunchAgent
  status      Check the daemon installation and execution status
  run         Run the token keepalive scan immediately (manual refresh)
  help        Print this help guide
  `);
}

void main();
