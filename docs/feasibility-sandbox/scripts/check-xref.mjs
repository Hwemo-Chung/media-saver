// [media-saver] strict xref check for classic-xref PDFs (pdf-mini output): every in-use entry must
// point at "<n> 0 obj" and every row must be exactly 20 bytes. Viewers silently repair broken xrefs.
// usage: node check-xref.mjs a.pdf [b.pdf ...]
import fs from 'node:fs';
import path from 'node:path';

for (const f of process.argv.slice(2)) {
  const s = fs.readFileSync(f).toString('latin1');
  const sx = Number((s.match(/startxref\s+(\d+)\s+%%EOF\s*$/) || [])[1]);
  const tbl = s.slice(sx).match(/^xref\n0 (\d+)\n([\s\S]*?)trailer/);
  if (!tbl) { console.log(path.basename(f), 'no classic xref at startxref'); continue; }
  const rows = tbl[2].match(/[\s\S]{20}/g);
  const bad = rows.filter((r, n) => n > 0 && !s.startsWith(`${n} 0 obj`, Number(r.slice(0, 10)))).length;
  console.log(`${path.basename(f)}: entries=${rows.length - 1} declared=${Number(tbl[1]) - 1} ` +
    `badOffsets=${bad} rowsAre20B=${rows.every((r) => r.length === 20) && rows.length * 20 === tbl[2].length}`);
}
