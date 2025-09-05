#!/usr/bin/env node
/**
 * scripts/replace-assets.js
 *
 * Usage:
 *  node scripts/replace-assets.js --dry-run
 *  node scripts/replace-assets.js --apply
 *  node scripts/replace-assets.js --apply --base "https://ali-ezz.github.io/hand-traking-games/assets/"
 *
 * What it does:
 *  - Recursively scans the project directory (excluding node_modules, .git)
 *  - Replaces quoted occurrences of "/assets/..."/"assets/..." with a provided base URL + "..."
 *  - Supports --dry-run to preview changes
 *  - Creates .bak backups when --apply is used
 *
 * Notes:
 *  - Targets files with extensions: .html, .js, .css, .ts, .json, .md
 *  - Replacement only happens for asset paths inside quotes/backticks to reduce false positives.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run') && !args.includes('--apply');
const APPLY = args.includes('--apply');
const baseArgIndex = args.indexOf('--base');
const BASE = (baseArgIndex !== -1 && args[baseArgIndex + 1]) ? args[baseArgIndex + 1] : 'https://ali-ezz.github.io/hand-traking-games/assets/';

const cwd = process.cwd();
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build']);
const EXT_WHITELIST = new Set(['.html', '.js', '.css', '.ts', '.json', '.md']);

const stats = {
  filesScanned: 0,
  filesModified: 0,
  replacements: 0,
  modifiedFiles: []
};

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    if (!EXT_WHITELIST.has(ext)) continue;
    stats.filesScanned++;
    try {
      processFile(full);
    } catch (err) {
      console.error('Error processing', full, err);
    }
  }
}

function processFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');

  // Regex: find quoted occurrences like "assets/..." or '/assets/...' or `assets/...` or "/assets/..."
  // Captures quote in $1 and the path tail in $2
  const regex = /(['"`])\/?assets\/([^'"`)\s>]+)\1/g;

  let replaced = 0;
  const transformed = original.replace(regex, (match, quote, tail) => {
    replaced++;
    // Ensure base ends with slash
    const base = BASE.endsWith('/') ? BASE : BASE + '/';
    return quote + base + tail + quote;
  });

  if (replaced > 0) {
    stats.replacements += replaced;
    stats.filesModified++;
    stats.modifiedFiles.push({ file: filePath, count: replaced });
    if (APPLY) {
      // backup
      try {
        fs.writeFileSync(filePath + '.bak', original, 'utf8');
      } catch (e) {
        console.warn('Failed to create backup for', filePath, e);
      }
      fs.writeFileSync(filePath, transformed, 'utf8');
      console.log(`[APPLIED] ${filePath} -> ${replaced} replacement(s) (backup: ${path.basename(filePath)}.bak)`);
    } else {
      console.log(`[DRY] ${filePath} -> ${replaced} replacement(s)`);
    }
  }
}

(function main() {
  console.log('Replace /assets -> GitHub Pages URL script');
  console.log('cwd:', cwd);
  console.log('BASE:', BASE);
  console.log('Mode:', APPLY ? 'APPLY' : 'DRY-RUN');
  console.log('');

  walk(cwd);

  console.log('');
  console.log('Summary:');
  console.log('Files scanned:', stats.filesScanned);
  console.log('Files with replacements:', stats.filesModified);
  console.log('Total replacements:', stats.replacements);

  if (!APPLY && stats.filesModified > 0) {
    console.log('');
    console.log('To apply these changes, run:');
    console.log('  node scripts/replace-assets.js --apply');
    console.log('Or with a custom base URL:');
    console.log('  node scripts/replace-assets.js --apply --base "https://username.github.io/repo/assets/"');
  }

  if (APPLY) {
    console.log('');
    console.log('Backups with .bak created for modified files.');
  }
})();
