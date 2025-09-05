#!/usr/bin/env node
// Node script: replace local "/assets/..." paths with GitHub Pages URLs.
// Usage:
//   node scripts/replace-assets.js        -> dry-run (reports files & matches)
//   node scripts/replace-assets.js --apply -> apply changes and write .bak backups
//
// Safe: creates .bak backups for modified files when --apply is used.

const fs = require('fs').promises;
const path = require('path');

const REPO_BASE = 'https://ali-ezz.github.io/hand-traking-games';
const ASSETS_PREFIX = '/assets/';
const TARGET = `${REPO_BASE}${ASSETS_PREFIX}`;

// File extensions to scan
const EXT = ['.html', '.js', '.css', '.ts', '.jsx', '.tsx', '.md'];

// Directories to ignore
const IGNORE = new Set(['.git', 'node_modules', 'server', 'dist', '.cache']);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

async function walk(dir, cb) {
  const names = await fs.readdir(dir);
  for (const name of names) {
    if (IGNORE.has(name)) continue;
    const full = path.join(dir, name);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) await walk(full, cb);
    else await cb(full);
  }
}

function replaceVariants(content) {
  // Replace common variants: "/assets/ , '/assets/ , ` /assets/ , url(/assets/ , ("/assets/
  // Use a global replace for the substring /assets/ when preceded by quotes, backtick, or ( or url(
  // We'll do two passes for robustness.
  const lookbehindRegex = /(?<=['"`(])\/assets\/([^\s'"`)>\]]+)/g;
  const replaced = content.replace(lookbehindRegex, (m, p1) => `${TARGET}${p1}`);

  // Fallback: replace url(/assets/...) patterns without quotes
  const urlRegex = /url\(\s*\/assets\/([^\s'")]+)\s*\)/g;
  const replaced2 = replaced.replace(urlRegex, (m, p1) => `url(${TARGET}${p1})`);

  // As a last resort, replace absolute /assets/ when it's clearly a string-like occurrence:
  const bareRegex = /(^|[\s="'`(>])\/assets\/([^\s'"`)>\]]+)/g;
  const final = replaced2.replace(bareRegex, (m, g1, p1) => `${g1}${TARGET}${p1}`);

  return final;
}

(async () => {
  const repoRoot = process.cwd();
  const matches = [];
  await walk(repoRoot, async (file) => {
    const ext = path.extname(file).toLowerCase();
    if (!EXT.includes(ext)) return;
    // Skip this script itself if present
    if (file.endsWith('scripts/replace-assets.js')) return;
    let content;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch (e) {
      return;
    }
    if (!content.includes(ASSETS_PREFIX)) return;
    const newContent = replaceVariants(content);
    if (newContent !== content) {
      matches.push({ file, old: content, new: newContent });
    }
  });

  if (matches.length === 0) {
    console.log('No /assets/... occurrences detected in scanned file types.');
    process.exit(0);
  }

  console.log(`Found ${matches.length} files with /assets/ occurrences:`);
  for (const m of matches) {
    console.log(' -', path.relative(repoRoot, m.file));
  }

  if (!APPLY) {
    console.log('\nDry-run mode. Run with --apply to modify files. Sample changes (first file):\n');
    const sample = matches[0];
    const rel = path.relative(repoRoot, sample.file);
    console.log(`--- ${rel} (excerpt) ---`);
    const diffExcerpt = sample.old.split('\n').slice(0, 40).join('\n');
    console.log(diffExcerpt.replace(/\/assets\//g, TARGET));
    process.exit(0);
  }

  // APPLY changes
  for (const m of matches) {
    const bak = m.file + '.bak';
    try {
      await fs.writeFile(bak, m.old, 'utf8');
      await fs.writeFile(m.file, m.new, 'utf8');
      console.log('Updated:', path.relative(repoRoot, m.file), '(backup:', path.relative(repoRoot, bak), ')');
    } catch (e) {
      console.error('Failed to write', m.file, e);
    }
  }

  console.log('\nAll changes applied. Backups saved with .bak extension. Review and git commit as needed.');
})();
