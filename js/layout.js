(function () {
'use strict';
// Layout analysis: find where the systems (groups of staves) are on each page, and where a page can
// be cut without slicing through any ink. The viewer then packs whole systems onto each screen.
//
// Everything works from a low-resolution picture of the page, so it needs no knowledge of the file
// format: staff lines show up as long, regularly spaced horizontal lines.
//
// Result (units = the reader's page units, e.g. PDF points):
//   { v, x0, x1, pages: [{ w, h }], blocks: [{ p, y0, y1, kind }], staves: [{ p, top, d, n, x0, x1, th }] }
//   staves: every staff found; its n lines are at y = top + i*d (page units), x0..x1 wide, th thick
//   kind: 'music' (contains staves), 'header' / 'footer' (no staves, above the first / below the last
//   system of a page that has music), or 'text' (a page with no staves in the middle of the music, e.g. a lyric sheet; such pages before the
//   first or after the last music count as header / footer)
//   blocks are in reading order; block i covers page p from y0 to y1 and holds `st` staves.
//   x0..x1 is the widest horizontal extent of any ink on any page.

const LAYOUT_VERSION = 6;
const MAX_SIDE = 2400;       // analysis picture: longest side in pixels
const INK = 200;             // luminance below this counts as ink

function toInk(data, W, H) {
  const ink = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < ink.length; i++, j += 4) {
    const lum = (data[j] * 3 + data[j + 1] * 6 + data[j + 2]) / 10;
    ink[i] = lum < INK ? 1 : 0;
  }
  return ink;
}

// Everything we learn from one page picture.
function scanPage(ink, W, H) {
  const rowCount = new Int32Array(H);
  const runStart = new Int32Array(H).fill(-1);
  const runEnd = new Int32Array(H).fill(-1);
  const runLen = new Int32Array(H);
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  const GAP = 2;                                    // tolerate tiny breaks inside a line
  for (let y = 0; y < H; y++) {
    const base = y * W;
    let count = 0, best = 0, bs = -1, be = -1, cs = -1, last = -100;
    for (let x = 0; x < W; x++) {
      if (!ink[base + x]) continue;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (cs < 0 || x - last > GAP + 1) {
        if (cs >= 0 && last - cs + 1 > best) { best = last - cs + 1; bs = cs; be = last; }
        cs = x;
      }
      last = x;
    }
    if (cs >= 0 && last - cs + 1 > best) { best = last - cs + 1; bs = cs; be = last; }
    rowCount[y] = count;
    if (count) { if (y < y0) y0 = y; y1 = y; }
    runLen[y] = best; runStart[y] = bs; runEnd[y] = be;
  }
  if (y1 < 0) return { empty: true, rowCount, W, H };
  const boxW = x1 - x0 + 1;

  // 1. rows that look like part of a long horizontal line
  const need = Math.max(0.3 * boxW, 0.15 * W);
  const clusters = [];
  let cur = null;
  for (let y = y0; y <= y1; y++) {
    if (runLen[y] >= need) {
      if (cur && y - cur.last <= 2) { cur.last = y; cur.sum += y; cur.n++; cur.left = Math.min(cur.left, runStart[y]); cur.right = Math.max(cur.right, runEnd[y]); }
      else { cur = { first: y, last: y, sum: y, n: 1, left: runStart[y], right: runEnd[y] }; clusters.push(cur); }
    }
  }
  const lines = clusters.filter(c => c.n <= 8).map(c => ({ y: c.sum / c.n, left: c.left, right: c.right, th: c.n }));

  // 2. staves = runs of 4-6 equally spaced lines
  const staves = [];
  let i = 0;
  while (i < lines.length - 3) {
    let d = lines[i + 1].y - lines[i].y;
    let j = i + 1;
    while (j + 1 < lines.length && Math.abs((lines[j + 1].y - lines[j].y) - d) <= 0.3 * d) {
      j++;
      d = (lines[j].y - lines[i].y) / (j - i);
    }
    const n = j - i + 1;
    if (n >= 4 && n <= 6 && d >= 3) {
      const grp = lines.slice(i, j + 1);
      staves.push({ top: grp[0].y, bottom: grp[n - 1].y, d, th: grp.reduce((a, l) => a + l.th, 0) / n, left: Math.min(...grp.map(l => l.left)), right: Math.max(...grp.map(l => l.right)) });
      i = j + 1;
    } else i++;
  }

  // 3. is a staff joined to the next one by a barline at its left edge?
  for (let k = 0; k + 1 < staves.length; k++) {
    const a = staves[k], b = staves[k + 1];
    let rows = 0, hit = 0;
    for (let y = Math.ceil(a.bottom) + 2; y < Math.floor(b.top) - 1; y++) {
      rows++;
      let any = false;
      for (let x = Math.max(0, a.left - 2); x <= a.left + 3 && !any; x++) if (ink[y * W + x]) any = true;
      if (any) hit++;
    }
    a.joinedBelow = rows > 0 && hit / rows >= 0.85;
  }
  findStructure(ink, W, staves);
  return { empty: false, rowCount, W, H, box: { x0, x1, y0, y1 }, staves };
}

// What the eraser must leave alone: the barlines, and the clef / key signature / time signature at the start of each
// staff. (Analysis-picture pixels; assemble() converts to page units.)
//  - a barline is a thin column of ink running exactly from the top staff line to the bottom one, without sticking out
//    beyond them (a stem does; so do chords) except where it joins the staff above/below;
//  - the start-of-staff zone is the clef plus the run of key/time-signature marks that follow it closely, ending at the
//    first mark that looks like a note head (a solid blob) or is followed by a bigger gap.
function findStructure(ink, W, staves) {
  const H = ink.length / W;
  const at = (x, y) => (x >= 0 && x < W && y >= 0 && y < H) ? ink[y * W + x] : 0;
  staves.forEach((st, k) => {
    const d = st.d, yt = Math.round(st.top), yb = Math.round(st.bottom), rows = yb - yt + 1;
    const x0 = Math.max(0, Math.floor(st.left)), x1 = Math.min(W - 1, Math.ceil(st.right));
    const joinedAbove = k > 0 && !!staves[k - 1].joinedBelow, joinedBelow = !!st.joinedBelow;
    st.bars = []; st.prefix = null;
    const lineRows = new Uint8Array(H);
    for (let i = 0; i < Math.max(4, Math.round((st.bottom - st.top) / d) + 1); i++) {
      const ly = Math.round(st.top + i * d), r = Math.max(1, Math.ceil(st.th * 0.8));
      for (let y = ly - r; y <= ly + r; y++) if (y >= 0 && y < H) lineRows[y] = 1;
    }
    const full = new Uint8Array(W);
    for (let x = x0; x <= x1; x++) { let c = 0; for (let y = yt; y <= yb; y++) c += at(x, y); full[x] = c >= rows * 0.97 ? 1 : 0; }
    for (let x = x0; x <= x1; x++) {
      if (!full[x]) continue;
      let b = x; while (b + 1 <= x1 && full[b + 1]) b++;
      const a = x; x = b;
      if (b - a + 1 > 1.4 * d) continue;                                     // too wide to be a barline
      // a barline stands clear of everything: a stem has its note head / beam / flag attached right beside it
      let attached = false;
      for (let o = 1; o <= Math.max(1, Math.round(0.2 * d)) && !attached; o++)
        for (let y = yt; y <= yb && !attached; y++) if (!lineRows[y] && (at(a - o, y) || at(b + o, y))) attached = true;
      if (attached) continue;
      const cx = (a + b) >> 1, up = Math.round(yt - 0.35 * d), up2 = Math.round(yt - 0.6 * d), dn = Math.round(yb + 0.35 * d), dn2 = Math.round(yb + 0.6 * d);
      // A line that carries on past the staff is only a barline if it runs all the way to the neighbouring staff (grand
      // staff); otherwise it is a stem (or a chord) and belongs to a note.
      const run = (ya, yz) => { let ok = 0, tot = 0; for (let y = ya; y <= yz; y++) { tot++; ok += at(cx, y); } return tot > 0 && ok / tot >= 0.9; };
      let top = yt, end = yb;
      if (joinedAbove && k > 0 && run(Math.round(staves[k - 1].bottom), yt)) top = Math.round(staves[k - 1].bottom);
      else if (at(cx, up) && at(cx, up2)) continue;                          // sticks out above: a stem, not a barline
      if (joinedBelow && staves[k + 1] && run(yb, Math.round(staves[k + 1].top))) end = Math.round(staves[k + 1].top);
      else if (at(cx, dn) && at(cx, dn2)) continue;                          // sticks out below
      st.bars.push({ x0: a, x1: b, y0: yt, y1: end });   // (the part above the staff is the neighbour's own barline)
    }
    // start-of-staff zone
    const first = st.bars.find(b => b.x0 <= st.left + 1.2 * d);
    const start = Math.max(x0, first ? first.x1 + 1 : x0);
    const ya = Math.max(0, Math.round(yt - 2 * d)), yz = Math.min(H - 1, Math.round(yb + 2 * d)), lim = Math.min(x1, Math.round(start + 14 * d));
    const content = new Uint8Array(W);
    for (let x = start; x <= lim; x++) {
      if (full[x]) continue;
      for (let y = ya; y <= yz; y++) if (!lineRows[y] && at(x, y)) { content[x] = 1; break; }
    }
    const clusters = []; const split = Math.max(2, 0.45 * d);
    for (let x = start; x <= lim; x++) {
      if (!content[x]) continue;
      let b = x, gap = 0;
      for (let q = x + 1; q <= lim && gap <= split; q++) { if (content[q]) { b = q; gap = 0; } else gap++; }
      clusters.push({ a: x, b }); x = b;
    }
    const wy = Math.max(2, Math.round(0.55 * d)), wx = Math.max(2, Math.round(0.75 * d));
    const noteLike = (c) => {                                               // a solid blob the size of a filled note head
      for (let y = ya; y + wy <= yz; y++) for (let x = c.a; x + wx <= c.b + 1; x++) {
        let ok = true;
        for (let j = 0; j < wy && ok; j++) for (let i = 0; i < wx; i++) if (!at(x + i, y + j)) { ok = false; break; }
        if (ok) return true;
      }
      return false;
    };
    if (!clusters.length || clusters[0].b - clusters[0].a < 1.2 * d) return;   // no clef-sized mark first: nothing to protect
    let end = clusters[0].b;
    for (let i = 1; i < clusters.length; i++) {
      const c = clusters[i];
      if (c.a - end > 1.2 * d || noteLike(c)) break;
      end = c.b;
    }
    st.prefix = Math.round(end + 0.4 * d);
  });
}

function cleanRuns(rowCount, from, to) {
  const runs = [];
  let s = -1;
  for (let y = from; y <= to; y++) {
    if (rowCount[y] === 0) { if (s < 0) s = y; }
    else if (s >= 0) { runs.push({ start: s, end: y - 1 }); s = -1; }
  }
  if (s >= 0) runs.push({ start: s, end: to });
  return runs;
}

// Staves -> systems. A system is a set of staves that must stay on one screen.
function groupSystems(staves, thr) {
  const systems = [];
  for (let k = 0; k < staves.length; k++) {
    const s = staves[k];
    const prev = systems[systems.length - 1];
    const gap = k ? (s.top - staves[k - 1].bottom) / s.d : Infinity;
    if (prev && (staves[k - 1].joinedBelow || gap < thr)) { prev.bottom = s.bottom; prev.n++; }
    else systems.push({ top: s.top, bottom: s.bottom, n: 1 });
  }
  return systems;
}

// Gaps between staves that are NOT joined by a barline fall into two groups: small ones (e.g. a vocal
// staff above its piano part) and big ones (between systems). Find the dividing size, if there is one.
function systemGapThreshold(pageScans) {
  const gaps = [];
  for (const p of pageScans) {
    if (p.empty) continue;
    for (let k = 0; k + 1 < p.staves.length; k++) {
      if (!p.staves[k].joinedBelow) gaps.push((p.staves[k + 1].top - p.staves[k].bottom) / p.staves[k + 1].d);
    }
  }
  if (gaps.length < 2) return 0;
  gaps.sort((a, b) => a - b);
  let best = 1, at = -1;
  for (let k = 0; k + 1 < gaps.length; k++) {
    const r = gaps[k + 1] / Math.max(gaps[k], 0.01);
    if (r > best) { best = r; at = k; }
  }
  return best >= 1.35 ? Math.sqrt(gaps[at] * gaps[at + 1]) : 0;
}

// Split one page into segments [{y0,y1}] (picture pixels) that can be cut apart without touching ink.
// Blank space between segments is dropped (a small margin is kept around each).
function pageCuts(p, thr) {
  const { rowCount, box, staves, H } = p;
  const systems = groupSystems(staves, thr);
  const ds = staves.map(s => s.d).sort((x, y) => x - y);
  const d = ds.length ? ds[ds.length >> 1] : 6;
  const margin = Math.max(1.2 * d, 10);
  const MIN_GAP = 3;                                        // narrower blank bands are not safe to cut (antialiasing)
  const top = box.y0 - margin, bottom = box.y1 + 1 + margin; // may extend past the page edge: that part draws white
  const gaps = [];                                          // clean runs where we cut
  const bestRun = (from, to, minLen, early = false) => {
    if (to < from) return null;
    const runs = cleanRuns(rowCount, from, to).filter(r => r.end - r.start + 1 >= minLen);
    if (!runs.length) return null;
    const longest = runs.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    if (!early) return longest;
    // Between two systems: chord names/diagrams/tempo marks belong to the system BELOW, so take the
    // earliest blank band that is comparable to the biggest one (not one that splits them from their staff).
    return runs.find(r => r.end - r.start >= 0.5 * (longest.end - longest.start)) || longest;
  };
  if (systems.length) {
    const first = systems[0], last = systems[systems.length - 1];
    let g = bestRun(box.y0, Math.floor(first.top) - 1, 3 * d);            // far-away header
    if (g) gaps.push(g);
    for (let k = 0; k + 1 < systems.length; k++) {
      g = bestRun(Math.ceil(systems[k].bottom) + 1, Math.floor(systems[k + 1].top) - 1, MIN_GAP, true);
      if (g) gaps.push(g);                                  // none: keep the two systems together
    }
    g = bestRun(Math.ceil(last.bottom) + 1, box.y1, 3 * d);               // far-away footer
    if (g) gaps.push(g);
  } else {
    for (const r of cleanRuns(rowCount, box.y0, box.y1)) if (r.end - r.start + 1 >= MIN_GAP) gaps.push(r);
  }
  const segs = [];
  let y0 = top;
  for (const g of gaps) {
    const m = Math.min(margin, (g.end - g.start + 1) / 2 - 0.5);
    segs.push({ y0, y1: g.start + m });
    y0 = g.end + 1 - m;
  }
  segs.push({ y0, y1: bottom });
  const out = segs.filter(x => x.y1 - x.y0 > 0.5);
  for (const g of out) {
    if (!systems.length) { g.kind = 'text'; continue; }
    const hasMusic = systems.some(sy => sy.bottom >= g.y0 && sy.top <= g.y1);
    g.kind = hasMusic ? 'music' : (g.y1 <= systems[0].top ? 'header' : 'footer');
  }
  return { segs: out, systems: systems.length };
}

async function analyzeDocument(doc, onProgress) {
  const scans = [];
  for (let n = 1; n <= doc.pageCount; n++) {
    onProgress?.(n, doc.pageCount);
    const { width, height } = await doc.getPageSize(n);
    const s = Math.min(MAX_SIDE / Math.max(width, height), 4);
    const c = document.createElement('canvas');
    await doc.renderRegion(n, c, { x: 0, y: 0, w: width, h: height, scale: s, dpr: 1 });
    const img = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
    const scan = scanPage(toInk(img.data, c.width, c.height), c.width, c.height);
    scan.width = width; scan.height = height; scan.s = c.width / width;
    scans.push(scan);
    await new Promise(r => setTimeout(r));                // let the UI breathe
  }
  return assemble(scans);
}

function assemble(scans) {
  const thr = systemGapThreshold(scans);
  const blocks = [];
  const staves = [];
  const pages = [];
  let gx0 = Infinity, gx1 = -Infinity;
  scans.forEach((p, idx) => {
    pages.push({ w: p.width, h: p.height });
    if (p.empty) return;                                   // blank page: nothing to show
    gx0 = Math.min(gx0, p.box.x0 / p.s);
    gx1 = Math.max(gx1, (p.box.x1 + 1) / p.s);
    for (const st of p.staves) {
      staves.push({ p: idx + 1, top: (st.top + 0.5) / p.s, d: st.d / p.s, n: Math.round((st.bottom - st.top) / st.d) + 1,
        x0: st.left / p.s, x1: (st.right + 1) / p.s, th: Math.max(st.th, 1) / p.s,
        bars: (st.bars || []).map(b => [b.x0 / p.s, (b.x1 + 1) / p.s, (b.y1 + 0.5) / p.s]),       // [x0, x1, bottom] of each barline
        prefix: st.prefix != null ? st.prefix / p.s : null });                                      // right edge of clef + key + time signature
    }
    const { segs, systems } = pageCuts(p, thr);
    for (const g of segs) blocks.push({ p: idx + 1, y0: g.y0 / p.s, y1: g.y1 / p.s, kind: g.kind });
  });
  if (!blocks.length) throw new Error('nothing to lay out');
  // Text-only pages before the first music (cover, copyright notice) or after the last music are
  // front/back matter, like headers and footers. Text pages in the middle (lyric sheets) stay.
  const firstMusic = blocks.findIndex(b => b.kind === 'music');
  const lastMusic = blocks.map(b => b.kind).lastIndexOf('music');
  if (firstMusic >= 0) blocks.forEach((b, i) => {
    if (b.kind === 'text') b.kind = i < firstMusic ? 'header' : (i > lastMusic ? 'footer' : 'text');
  });
  const pad = 3;
  const w = Math.max(...pages.map(p => p.w));
  return { v: LAYOUT_VERSION, x0: Math.max(0, gx0 - pad), x1: Math.min(w, gx1 + pad), pages, blocks, staves };
}

// Fill screens with whole blocks. scale = CSS px per page unit, vh = usable height in CSS px.
function packScreens(blocks, scale, vh) {
  const screens = [];
  let cur = [], h = 0;
  blocks.forEach((b, i) => {
    const bh = (b.y1 - b.y0) * scale;
    if (cur.length && h + bh > vh + 0.5) { screens.push(cur); cur = []; h = 0; }
    cur.push(i);
    h += bh;
  });
  if (cur.length) screens.push(cur);
  return screens;
}

Object.assign(MB, { LAYOUT_VERSION, analyzeDocument, packScreens, _layoutInternals: { findStructure, scanPage, groupSystems, systemGapThreshold, pageCuts, toInk } });
})();
