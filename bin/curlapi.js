#!/usr/bin/env node
/**
 * Launcher. Deliberately plain JavaScript with no imports of its own.
 *
 * The rest of the tool is TypeScript that Node runs directly, which needs Node
 * 24. On an older Node that source cannot even be loaded — the failure is
 * "Unknown file extension .ts" or a SyntaxError on a type annotation, neither of
 * which tells anyone what to actually do. This file parses and runs everywhere,
 * so the version check happens before anything that could fail, and the real
 * entry point is imported dynamically only once the check passes.
 */

const major = Number(process.versions.node.split('.')[0]);

if (major < 24) {
  console.error(
    `curlapi needs Node 24 or newer — this is Node ${process.versions.node}.\n\n` +
      'Node 24 runs TypeScript directly and includes the SQLite database captures\n' +
      'are stored in, which is why this tool has no build step and no native\n' +
      'dependencies to compile.\n\n' +
      'Install it from https://nodejs.org, or with a version manager:\n' +
      '  nvm install 24 && nvm use 24     (macOS / Linux)\n' +
      '  winget install OpenJS.NodeJS     (Windows)',
  );
  process.exit(1);
}

import('../src/cli.ts').catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
