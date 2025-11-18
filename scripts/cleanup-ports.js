#!/usr/bin/env node

/**
 * Cross-platform script to find and kill processes using development ports
 * Usage: node scripts/cleanup-ports.js
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const isWindows = process.platform === 'win32';

const DEVELOPMENT_PORTS = [5000, 5001, 5555, 5173, 4173, 24678];

async function findProcessOnPort(port) {
  try {
    if (isWindows) {
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
      const lines = stdout.split('\n').filter(line => line.includes('LISTENING'));
      
      if (lines.length > 0) {
        const pidMatch = lines[0].match(/\s+(\d+)$/);
        if (pidMatch) {
          const pid = pidMatch[1];
          try {
            const { stdout: taskOutput } = await execAsync(`tasklist | findstr ${pid}`);
            const processName = taskOutput.split(/\s+/)[0];
            return { pid, processName };
          } catch {
            return { pid, processName: 'Unknown' };
          }
        }
      }
    } else {
      // Unix/Linux/macOS
      const { stdout } = await execAsync(`lsof -ti:${port}`);
      const pid = stdout.trim();
      
      if (pid) {
        try {
          const { stdout: psOutput } = await execAsync(`ps -p ${pid} -o comm=`);
          const processName = psOutput.trim();
          return { pid, processName };
        } catch {
          return { pid, processName: 'Unknown' };
        }
      }
    }
  } catch {
    // Port is free
  }
  
  return null;
}

async function killProcess(pid) {
  try {
    if (isWindows) {
      await execAsync(`taskkill /PID ${pid} /F`);
    } else {
      await execAsync(`kill -9 ${pid}`);
    }
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log('🔍 Checking development ports for zombie processes...\n');
  
  let foundProcesses = false;
  
  for (const port of DEVELOPMENT_PORTS) {
    const process = await findProcessOnPort(port);
    
    if (process) {
      foundProcesses = true;
      console.log(`❌ Port ${port}: ${process.processName} (PID: ${process.pid})`);
      
      // Auto-kill Node.js processes on development ports
      if (process.processName.includes('node') || process.processName.includes('Node')) {
        console.log(`   🔫 Killing Node.js process...`);
        const killed = await killProcess(process.pid);
        if (killed) {
          console.log(`   ✅ Process ${process.pid} terminated\n`);
        } else {
          console.log(`   ❌ Failed to kill process ${process.pid}\n`);
        }
      } else {
        console.log(`   ⚠️  Non-Node.js process detected - skipping\n`);
      }
    } else {
      console.log(`✅ Port ${port}: Free`);
    }
  }
  
  if (!foundProcesses) {
    console.log('\n🎉 All development ports are free!');
  }
  
  console.log('\n✨ Port cleanup complete.');
}

main().catch(console.error);
