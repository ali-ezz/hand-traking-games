/**
 * Lightweight test harness for peer-hand flip heuristics.
 * This replicates the decision logic used in js/game.js handlePeerHand
 * and exercises several synthetic origRatio / flipRatio / selfie scenarios.
 *
 * Run: node scripts/test-flip.js
 */

const CASES = [
  { name: 'High orig, selfie=false', origRatio: 0.90, flipRatio: 0.88, selfie: false },
  { name: 'Low orig, flip better, selfie=false', origRatio: 0.15, flipRatio: 0.55, selfie: false },
  { name: 'Low orig, flip better, selfie=true (special-case)', origRatio: 0.12, flipRatio: 0.45, selfie: true },
  { name: 'Moderate orig, flip much better, selfie=false', origRatio: 0.30, flipRatio: 0.65, selfie: false },
  { name: 'Orig equals flip, selfie=true', origRatio: 0.5, flipRatio: 0.5, selfie: true },
  { name: 'Tiny differences under threshold, selfie=false', origRatio: 0.48, flipRatio: 0.50, selfie: false }
];

function decideFlip(origRatio, flipRatio, preferOriginal) {
  // matches logic from js/game.js:
  // if (!preferOriginal && flipRatio > origRatio + 0.03) flip
  // else if (preferOriginal && origRatio < 0.2 && flipRatio > origRatio) flip
  // else keep original
  if (!preferOriginal && flipRatio > origRatio + 0.03) return true;
  if (preferOriginal && origRatio < 0.2 && flipRatio > origRatio) return true;
  return false;
}

console.log('Peer-hand flip heuristic tests');
console.log('--------------------------------');
for (const c of CASES) {
  const preferOriginal = !!c.selfie;
  const willFlip = decideFlip(c.origRatio, c.flipRatio, preferOriginal);
  console.log(`${c.name}: orig=${c.origRatio.toFixed(3)}, flip=${c.flipRatio.toFixed(3)}, selfie=${c.selfie} -> ${willFlip ? 'FLIP' : 'KEEP ORIGINAL'}`);
}
