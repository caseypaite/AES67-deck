// Minimal REAPER project (.rpp) reader/writer for AES67-Deck's multitrack
// recording projects. Writes a project REAPER (and most DAWs that read .rpp)
// can open directly, with WavPack sources; parses back the subset the deck
// timeline needs (tracks, items, fades, gain, source files, markers).
//
// .rpp is a line-oriented, brace-nested text format. `<TAG args` opens a
// block, a bare `>` closes it, everything else is `KEY tok tok ...`. Strings
// are quoted with ", ' or ` (REAPER picks whichever the value doesn't
// contain); we only ever emit values safe for double quotes.

export interface RppItem {
  id?: string;        // REAPER item GUID, lowercased, braces stripped
  name: string;
  position: number;   // seconds on the timeline
  length: number;     // seconds
  soffs: number;      // seconds into the source file
  gain: number;       // linear (item VOLPAN volume)
  fadeIn: number;     // seconds
  fadeOut: number;    // seconds
  file: string;       // source filename, relative to the .rpp
}

export interface RppTrack {
  name: string;
  trackId?: number;   // parsed from a leading integer in the name, if any
  height?: number;
  items: RppItem[];
}

export interface RppProject {
  sampleRate: number;
  tempo: number;
  tracks: RppTrack[];
  markers: { position: number; name: string }[];
}

// --- writing ---

function q(s: string): string {
  return `"${String(s).replace(/"/g, "'")}"`;
}

function guidUpper(id?: string): string {
  const base = (id || crypto.randomUUID()).replace(/[{}]/g, '').toUpperCase();
  return `{${base}}`;
}

export function buildRpp(p: RppProject): string {
  const L: string[] = [];
  const ts = Math.floor(Date.now() / 1000);
  L.push(`<REAPER_PROJECT 0.1 "7.0/aes67-deck" ${ts}`);
  L.push('  RIPPLE 0');
  L.push('  GROUPOVERRIDE 0 0 0');
  L.push('  AUTOXFADE 1');
  L.push('  ENVATTACH 3');
  L.push('  MIXERUIFLAGS 11 48');
  L.push('  PEAKGAIN 1');
  L.push('  FEEDBACK 0');
  L.push('  PANLAW 1');
  L.push('  PROJOFFS 0 0 0');
  L.push('  MAXPROJLEN 0 0');
  L.push('  GRID 3199 8 1 8 1 0 0 0');
  L.push('  TIMEMODE 5 5 -1 30 0 0 -1');
  L.push('  PANMODE 3');
  L.push('  CURSOR 0');
  L.push('  ZOOM 100 0 0');
  L.push('  LOOP 0');
  L.push('  LOOPGRAN 0 4');
  L.push('  RECORD_PATH "" ""');
  L.push('  TIMELOCKMODE 1');
  L.push('  TEMPOENVLOCKMODE 1');
  L.push('  ITEMMIX 1');
  L.push(`  SAMPLERATE ${p.sampleRate || 48000} 0 0`);
  L.push('  LOCK 1');
  L.push('  GLOBAL_AUTO -1');
  L.push(`  TEMPO ${p.tempo || 120} 4 4`);
  L.push('  PLAYRATE 1 0 0.25 4');
  L.push('  SELECTION 0 0');
  L.push('  SELECTION2 0 0');
  for (let i = 0; i < p.markers.length; i++) {
    const m = p.markers[i];
    L.push(`  MARKER ${i + 1} ${fmt(m.position)} ${q(m.name)} 0 0 1 R {${guidUpper().slice(1, -1)}} 0`);
  }
  L.push('  MASTER_NCH 2');
  L.push('  MASTER_VOLUME 1 0 -1 -1 1');
  L.push('  MASTER_FX 1');
  L.push('  MASTER_SEL 0');

  for (const tr of p.tracks) {
    const g = guidUpper();
    L.push(`  <TRACK ${g}`);
    L.push(`    NAME ${q(tr.name)}`);
    L.push('    PEAKCOL 16576');
    L.push('    BEAT -1');
    L.push('    AUTOMODE 0');
    L.push('    VOLPAN 1 0 -1 -1 1');
    L.push('    MUTESOLO 0 0 0');
    L.push('    IPHASE 0');
    L.push('    PLAYOFFS 0 1');
    L.push('    ISBUS 0 0');
    L.push('    BUSCOMP 0 0 0 0 0');
    L.push('    SHOWINMIX 1 0.6667 0.5 1 0.5 0 0 0');
    L.push('    FREEMODE 0');
    L.push('    SEL 0');
    L.push('    REC 0 0 0 0 0 0 0 0');
    L.push('    VU 2');
    L.push(`    TRACKHEIGHT ${Math.round(tr.height || 0)} 0 0 0 0 0 0`);
    L.push('    INQ 0 0 0 0.5 100 0 0 100');
    L.push('    NCHAN 2');
    L.push('    FX 1');
    L.push(`    TRACKID ${g}`);
    L.push('    PERF 0');
    L.push('    MIDIOUT -1');
    L.push('    MAINSEND 1 0');
    let iid = 1;
    for (const it of tr.items) {
      L.push('    <ITEM');
      L.push(`      POSITION ${fmt(it.position)}`);
      L.push('      SNAPOFFS 0');
      L.push(`      LENGTH ${fmt(it.length)}`);
      L.push('      LOOP 0');
      L.push('      ALLTAKES 0');
      L.push(`      FADEIN 1 ${fmt(it.fadeIn || 0)} 0 1 0 0 0`);
      L.push(`      FADEOUT 1 ${fmt(it.fadeOut || 0)} 0 1 0 0 0`);
      L.push('      MUTE 0 0');
      L.push('      SEL 0');
      L.push(`      IGUID ${guidUpper()}`);
      L.push(`      IID ${iid++}`);
      L.push(`      NAME ${q(it.name)}`);
      L.push(`      VOLPAN ${fmt(it.gain ?? 1)} 0 1 -1`);
      L.push(`      SOFFS ${fmt(it.soffs || 0)}`);
      L.push('      PLAYRATE 1 1 0 -1 0 0.0025');
      L.push('      CHANMODE 0');
      L.push(`      GUID ${guidUpper(it.id)}`);
      const srcTag = /\.wv$/i.test(it.file) ? 'WAVPACK'
        : /\.flac$/i.test(it.file) ? 'FLAC' : 'WAVE';
      L.push(`      <SOURCE ${srcTag}`);
      L.push(`        FILE ${q(it.file)}`);
      L.push('      >');
      L.push('    >');
    }
    L.push('  >');
  }
  L.push('>');
  L.push('');
  return L.join('\n');
}

function fmt(n: number): string {
  if (!isFinite(n)) return '0';
  // trim to a sane precision, drop trailing zeros
  return parseFloat(n.toFixed(10)).toString();
}

// --- parsing ---

interface Block { tag: string; args: string[]; lines: Array<string[]>; children: Block[]; }

function tokenize(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const s = line;
  while (i < s.length) {
    while (i < s.length && s[i] === ' ') i++;
    if (i >= s.length) break;
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const j = s.indexOf(c, i + 1);
      if (j === -1) { out.push(s.slice(i + 1)); break; }
      out.push(s.slice(i + 1, j));
      i = j + 1;
    } else {
      let j = i;
      while (j < s.length && s[j] !== ' ') j++;
      out.push(s.slice(i, j));
      i = j;
    }
  }
  return out;
}

function parseBlocks(text: string): Block | null {
  const root: Block = { tag: 'ROOT', args: [], lines: [], children: [] };
  const stack: Block[] = [root];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '>') { if (stack.length > 1) stack.pop(); continue; }
    if (line.startsWith('<')) {
      const toks = tokenize(line.slice(1));
      const blk: Block = { tag: toks[0] || '', args: toks.slice(1), lines: [], children: [] };
      stack[stack.length - 1].children.push(blk);
      stack.push(blk);
    } else {
      stack[stack.length - 1].lines.push(tokenize(line));
    }
  }
  return root.children[0] || null;
}

function lineVal(b: Block, key: string): string[] | undefined {
  for (const l of b.lines) if (l[0] === key) return l.slice(1);
  return undefined;
}
function num(v: string | undefined, dflt = 0): number {
  const n = v === undefined ? NaN : parseFloat(v);
  return isFinite(n) ? n : dflt;
}
function trackIdFromName(name: string): number | undefined {
  const m = name.match(/(\d+)/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 512 ? n : undefined;
}

export function parseRpp(text: string): RppProject {
  const root = parseBlocks(text);
  const proj: RppProject = { sampleRate: 48000, tempo: 120, tracks: [], markers: [] };
  if (!root || root.tag !== 'REAPER_PROJECT') return proj;

  proj.sampleRate = num(lineVal(root, 'SAMPLERATE')?.[0], 48000) || 48000;
  proj.tempo = num(lineVal(root, 'TEMPO')?.[0], 120) || 120;

  for (const l of root.lines) {
    if (l[0] === 'MARKER' && l.length >= 4 && l[4] !== '1' /* not a region */) {
      proj.markers.push({ position: num(l[2]), name: l[3] || 'Marker' });
    }
  }

  for (const tb of root.children) {
    if (tb.tag !== 'TRACK') continue;
    const name = (lineVal(tb, 'NAME')?.[0]) || 'Track';
    const height = num(lineVal(tb, 'TRACKHEIGHT')?.[0], 0);
    const track: RppTrack = { name, trackId: trackIdFromName(name), height: height || undefined, items: [] };

    for (const ib of tb.children) {
      if (ib.tag !== 'ITEM') continue;
      let file = '';
      for (const sb of ib.children) {
        if (sb.tag === 'SOURCE') {
          const f = lineVal(sb, 'FILE')?.[0];
          if (f) file = f;
        }
      }
      if (!file) continue;
      const guid = (lineVal(ib, 'GUID')?.[0] || '').replace(/[{}]/g, '').toLowerCase();
      track.items.push({
        id: guid || undefined,
        name: (lineVal(ib, 'NAME')?.[0]) || file,
        position: num(lineVal(ib, 'POSITION')?.[0]),
        length: num(lineVal(ib, 'LENGTH')?.[0]),
        soffs: num(lineVal(ib, 'SOFFS')?.[0]),
        gain: num(lineVal(ib, 'VOLPAN')?.[0], 1) || 1,
        fadeIn: num(lineVal(ib, 'FADEIN')?.[1]),
        fadeOut: num(lineVal(ib, 'FADEOUT')?.[1]),
        file,
      });
    }
    proj.tracks.push(track);
  }
  return proj;
}
