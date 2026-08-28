import puppeteer from 'puppeteer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import ffmpegPath from 'ffmpeg-static';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.env.WORK_DIR || path.join(HERE, '.work');
const APP = process.env.APP_URL || 'http://127.0.0.1:5274';
const OUT = process.env.OUT_DIR || path.join(WORK, 'showcase');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const VW = 1920, VH = 1080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(`  ${s}`);
let shotN = 0;
const shots = [];
const frames = [];
let castOn = false;

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb', `--window-size=${VW},${VH}`],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[browser error]', m.text()); });

  const client = await page.createCDPSession();
  client.on('Page.screencastFrame', async (f) => {
    if (castOn) frames.push({ data: Buffer.from(f.data, 'base64'), ts: Date.now() });
    try { await client.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* ignore */ }
  });

  async function shot(name, caption) {
    shotN += 1;
    const base = `${String(shotN).padStart(2, '0')}-${name}`;
    await page.screenshot({ path: path.join(OUT, `${base}.png`) });
    await page.screenshot({ path: path.join(OUT, `${base}.jpg`), type: 'jpeg', quality: 82 });
    shots.push({ file: `${base}.png`, jpg: `${base}.jpg`, caption });
    log(`shot ${base}.png — ${caption}`);
  }

  // ---- DOM-precise helpers (synthesized events, no timing races) --------
  // The finder source is injected into the page as a function; every strip is
  // located by its route-indicator text: CH<n> / BUS / MON / MST.
  const FIND = `function stripEl(lab){
    const ind=[...document.querySelectorAll('div')].find(d=>d.childElementCount===0&&d.textContent.trim()===lab&&d.className.includes('tracking-widest'));
    if(!ind)return null; let s=ind;
    for(let i=0;i<6&&s;i++){s=s.parentElement;if(s&&s.className.includes('rounded-t-md'))return s;}
    return null;}`;

  const selectStrip = (lab) => page.evaluate((f, l) => { eval(f); const s = stripEl(l); s && s.click(); }, FIND, lab);

  const stripButton = (lab, txt) => page.evaluate((f, l, t) => {
    eval(f); const s = stripEl(l); if (!s) return false;
    const b = [...s.querySelectorAll('button')].find((x) => x.textContent.trim() === t);
    if (!b) return false; b.click(); return true;
  }, FIND, lab, txt);

  const setFader = (lab, pos) => page.evaluate((f, l, p) => {
    eval(f); const s = stripEl(l); if (!s) return false;
    const trk = s.querySelector('.cursor-pointer'); if (!trk) return false;
    const r = trk.getBoundingClientRect();
    const clientY = r.top + 24 + (1 - p) * (r.height - 48);
    trk.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + r.width / 2, clientY }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  }, FIND, lab, pos);

  const renameStrip = async (lab, name) => {
    const ok = await page.evaluate((f, l) => {
      eval(f); const s = stripEl(l); if (!s) return false;
      const lbl = s.querySelector('.cursor-text'); if (!lbl) return false;
      lbl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    }, FIND, lab);
    if (!ok) return;
    await sleep(80);
    await page.evaluate((f, l, n) => {
      eval(f); const s = stripEl(l); if (!s) return;
      const inp = s.querySelector('input'); if (!inp) return;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(inp, n);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      inp.blur();
    }, FIND, lab, name);
    await sleep(60);
  };

  const clickText = (txt, exact = true) => page.evaluate((t, ex) => {
    const el = [...document.querySelectorAll('button,[role=button],a')]
      .find((x) => (ex ? x.textContent.trim() === t : x.textContent.includes(t)));
    if (!el) return false; el.click(); return true;
  }, txt, exact);

  const addEffect = async (category, pluginName) => {
    await clickText('INSERT EFFECT', false);
    await sleep(250);
    if (category) {
      await page.evaluate((c) => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().toUpperCase() === c.toUpperCase());
        b && b.click();
      }, category);
      await sleep(200);
    }
    const added = await page.evaluate((n) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n);
      if (!b) return false; b.click(); return true;
    }, pluginName);
    await sleep(400);
    return added;
  };

  const openSlot = (name) => page.evaluate((n) => {
    const el = [...document.querySelectorAll('span,div')].find((x) => x.childElementCount === 0 && x.textContent.trim() === n);
    (el?.closest('[draggable="true"]') || el?.parentElement)?.click();
  }, name);

  // ====================================================================
  await page.goto(APP, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => document.body.innerText.includes('MIXER'), { timeout: 15000 });
  await sleep(1800);
  // Select a channel up front so the FX-rack / sends zone is never the empty
  // "NO CHANNEL SELECTED" placeholder in the wide shots.
  await selectStrip('CH1');
  await sleep(500);

  await client.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: VW, maxHeight: VH, everyNthFrame: 1 });
  castOn = true;
  await sleep(1000);

  log('1 — overview');
  await shot('mixer-overview', 'The console: 16 input strips (bank 1) + 8 aux buses + Monitor + Master, live VU on every strip; top zone is the selected channel’s FX rack + sends');

  log('2 — label + build a mix');
  for (const [id, n] of [['CH1', 'KICK'], ['CH2', 'SNARE'], ['CH3', 'BASS'], ['CH4', 'GTR L'], ['CH5', 'GTR R'], ['CH6', 'LEAD VOX'], ['CH7', 'BGV'], ['CH8', 'KEYS']]) {
    await renameStrip(id, n);
  }
  for (const [id, p] of [['CH1', 0.85], ['CH2', 0.72], ['CH3', 0.78], ['CH4', 0.6], ['CH5', 0.62], ['CH6', 0.9], ['CH7', 0.52], ['CH8', 0.67], ['CH100', 0.8]]) {
    await setFader(id === 'CH100' ? 'MST' : id, p);
  }
  await sleep(200);
  await shot('labels-and-faders', 'Rename via the tape label (double-click); faders ride to the engine live');

  log('3 — channel states');
  await stripButton('CH3', 'S');
  await stripButton('CH5', 'M');
  await stripButton('CH1', 'REC');
  await stripButton('CH2', 'REC');
  await stripButton('CH4', 'ø');
  await sleep(300);
  await shot('channel-states', 'Per strip: S solo · M mute · REC record-arm · ø polarity invert');
  await stripButton('CH3', 'S'); // clear the solo before moving on

  log('4 — select a channel → FX rack + aux sends');
  await selectStrip('CH6');
  await sleep(500);
  await shot('fx-and-sends', 'Selecting a strip opens its insert FX rack (left) and its 8 aux sends (right)');

  log('5 — insert effects');
  await addEffect('Dynamics', 'Calf Compressor');
  await addEffect('Equalizer', 'Calf 8-Band EQ');
  await shot('fx-rack', 'Live insert chain: Calf Compressor → 8-Band EQ, per channel, no dropouts');

  log('6 — analog editors');
  await openSlot('Calf 8-Band EQ');
  await sleep(700);
  await shot('editor-eq', '8-Band EQ editor: draggable band nodes over a colour RTA spectrum');
  await openSlot('Calf Compressor');
  await sleep(700);
  await shot('editor-comp', 'Compressor editor: transfer curve, live operating point, gain-reduction meter');

  // Close-up: turn a knob slowly so the LED level ring sweeps on camera.
  const knobBay = await page.evaluate(() => {
    const ks = [...document.querySelectorAll('[role="slider"]')];
    if (!ks.length) return null;
    const r = ks.map((k) => k.getBoundingClientRect());
    const x = Math.min(...r.map((b) => b.x)) - 24;
    const y = Math.min(...r.map((b) => b.y)) - 40;
    const w = Math.max(...r.map((b) => b.right)) + 24 - x;
    const h = Math.max(...r.map((b) => b.bottom)) + 18 - y;
    const first = r[0];
    return { clip: { x, y, width: w, height: h }, knob: { x: first.x + first.width / 2, y: first.y + first.height / 2 } };
  });
  if (knobBay) {
    const { x, y } = knobBay.knob;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let d = 0; d <= 90; d += 6) { await page.mouse.move(x, y - d); await sleep(45); }   // wind up
    for (let d = 90; d >= -70; d -= 6) { await page.mouse.move(x, y - d); await sleep(45); }  // sweep down
    await sleep(250);
    await page.screenshot({ path: path.join(OUT, `${String(shotN + 1).padStart(2, '0')}-knob-closeup.png`), clip: knobBay.clip });
    await page.screenshot({ path: path.join(OUT, `${String(shotN + 1).padStart(2, '0')}-knob-closeup.jpg`), type: 'jpeg', quality: 88, clip: knobBay.clip });
    shotN += 1;
    shots.push({ file: `${String(shotN).padStart(2, '0')}-knob-closeup.png`, jpg: `${String(shotN).padStart(2, '0')}-knob-closeup.jpg`,
      caption: 'Rotary knob close-up — LED level ring + chromed cap, accent per plugin category, readout floats while turning' });
    log(`shot ${String(shotN).padStart(2, '0')}-knob-closeup.png — LED ring sweep`);
    await page.mouse.up();
    await sleep(200);
  }

  log('7 — built-in FX chain library');
  await clickText('LOAD', true);             // FX rack LOAD → chain library
  await sleep(500);
  await shot('fx-chain-library', 'Built-in Calf FX chains — per-source starting points for vocals, guitars, drums, broadcast');
  await page.mouse.click(1250, 400);         // click the popover backdrop to dismiss it
  await sleep(300);

  log('8 — master / mastering suite');
  await selectStrip('MST');
  await sleep(800);
  await shot('mastering', 'Master selected: spectrum, goniometer, correlation, BS.1770 M/S/I/TP, mastering preset browser');

  log('9 — apply a mastering chain');
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('*')].find((x) => x.childElementCount <= 3 && /^Streaming\s*[-−]14/.test(x.textContent.trim()));
    (row?.closest('button') || row)?.click();
  });
  await sleep(300);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /LOAD\s*[→>]\s*MASTER/i.test(x.textContent));
    b && b.click();
  });
  await sleep(700);
  await shot('mastering-applied', 'Streaming −14 chain (EQ8 → Glue Comp → Limiter) applied to the Master insert rack');

  log('10 — second input bank');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /CH\s*17\s*-\s*32/.test(x.textContent));
    b && b.click();
  });
  await sleep(500);
  await shot('bank-2', 'Input bank 2 (CH 17–32) — 32 inputs across two banks of 16');

  log('11 — scenes');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'CH 1-16');
    b && b.click();
  });
  await sleep(300);
  await clickText('SAVE SCENE', false);
  await sleep(500);
  await shot('scene-save', 'Scenes: a full mixer + patchbay snapshot, saved and recalled from the toolbar');
  await page.keyboard.press('Escape');
  await sleep(200);

  castOn = false;
  await sleep(150);
  try { await client.send('Page.stopScreencast'); } catch { /* ignore */ }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(shots, null, 2));

// ---- encode the 720p screen capture (H.264 MP4 via ffmpeg-static) -----
let reelOk = false;
if (frames.length > 4) {
  try {
    const FPS = 15;
    const t0 = frames[0].ts;
    const endT = frames[frames.length - 1].ts - t0;
    // Resample to a constant frame rate while keeping the tour's real pacing.
    const picked = [];
    let idx = 0;
    for (let t = 0; t <= endT; t += 1000 / FPS) {
      while (idx + 1 < frames.length && frames[idx + 1].ts - t0 <= t) idx += 1;
      picked.push(frames[idx]);
    }
    log(`reel: ${frames.length} raw → ${picked.length} frames @ ${FPS}fps`);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-'));
    picked.forEach((f, i) => fs.writeFileSync(path.join(tmp, `f${String(i).padStart(5, '0')}.jpg`), f.data));
    const mp4 = path.join(OUT, 'mixer-showcase.mp4');
    execFileSync(ffmpegPath, [
      '-y', '-framerate', String(FPS),
      '-i', path.join(tmp, 'f%05d.jpg'),
      '-vf', 'scale=1280:720:flags=lanczos',
      '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-crf', '20', '-preset', 'slow', '-movflags', '+faststart',
      mp4,
    ], { stdio: 'ignore' });
    fs.rmSync(tmp, { recursive: true, force: true });

    const mb = (fs.statSync(mp4).size / 1e6).toFixed(1);
    reelOk = true;
    log(`reel: mixer-showcase.mp4 1280x720 @ ${FPS}fps ${mb} MB`);
    // Refresh the committed copy the README embeds.
    const committed = path.join(HERE, '..', '..', 'docs', 'media', 'mixer-showcase.mp4');
    fs.mkdirSync(path.dirname(committed), { recursive: true });
    fs.copyFileSync(mp4, committed);
    log('reel: copied to docs/media/mixer-showcase.mp4');
  } catch (e) {
    log(`reel failed: ${e.message}`);
  }
}

// ---- self-contained showcase page (data URIs) --------------------------
try {
  const b64 = (f) => fs.readFileSync(path.join(OUT, f)).toString('base64');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const steps = shots.map((s, i) => `
      <figure class="step">
        <span class="step__n">${String(i + 1).padStart(2, '0')}</span>
        <img loading="lazy" alt="${esc(s.caption)}" src="data:image/jpeg;base64,${b64(s.jpg)}">
        <figcaption>${esc(s.caption)}</figcaption>
      </figure>`).join('\n');
  const reelBlock = reelOk ? `
    <figure class="reel">
      <div class="reel__frame"><video src="data:video/mp4;base64,${b64('mixer-showcase.mp4')}" autoplay muted loop playsinline controls></video></div>
      <figcaption><span class="rec"></span> The full run — every step below, in sequence · 1280 &times; 720</figcaption>
    </figure>` : '';

  const html = `<title>The Console, Strip by Strip</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root{
    color-scheme:light dark;
    --ground:#eceef0; --panel:#f7f8f9; --rule:#d3d7dc; --ink:#1a1d21; --dim:#5c626b;
    --accent:#1f6fd6; --live:#0a8f6f; --hot:#c23b3b;
    --frame:#0b0c0e;
    --shadow:0 1px 2px rgba(20,24,30,.06),0 8px 28px rgba(20,24,30,.08);
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --ground:#0b0c0e; --panel:#14161a; --rule:#282c33; --ink:#e7e9ec; --dim:#949aa4;
      --accent:#5aa2f0; --live:#37c79b; --hot:#e06a6a;
      --frame:#000;
      --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 36px rgba(0,0,0,.5);
    }
  }
  :root[data-theme="dark"]{
    --ground:#0b0c0e; --panel:#14161a; --rule:#282c33; --ink:#e7e9ec; --dim:#949aa4;
    --accent:#5aa2f0; --live:#37c79b; --hot:#e06a6a;
    --frame:#000;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 36px rgba(0,0,0,.5);
  }

  *,*::before,*::after{box-sizing:border-box}
  body{
    margin:0; background:var(--ground); color:var(--ink);
    font:16px/1.6 "IBM Plex Sans","Helvetica Neue",Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:1000px;margin:0 auto;padding:0 24px}

  header{padding:72px 0 40px;border-bottom:1px solid var(--rule)}
  .eyebrow{
    font:500 12px/1 "IBM Plex Mono",monospace; letter-spacing:.22em; text-transform:uppercase;
    color:var(--accent); margin:0 0 18px;
  }
  h1{
    font:700 clamp(38px,7vw,68px)/.98 "Barlow Condensed","Arial Narrow",sans-serif;
    letter-spacing:.005em; text-transform:uppercase; text-wrap:balance;
    margin:0 0 16px;
  }
  .lede{max-width:60ch;margin:0;color:var(--dim);font-size:17px}
  .spec{
    display:flex;flex-wrap:wrap;gap:8px 10px;margin:28px 0 0;padding:0;list-style:none;
    font:500 11.5px/1 "IBM Plex Mono",monospace;letter-spacing:.08em;text-transform:uppercase;
  }
  .spec li{border:1px solid var(--rule);border-radius:2px;padding:7px 10px;color:var(--dim)}

  main{padding:44px 0 96px;display:flex;flex-direction:column;gap:64px}

  figure{margin:0}
  .reel__frame{
    background:var(--frame);border:1px solid var(--rule);border-radius:6px;
    padding:10px;box-shadow:var(--shadow);
  }
  .reel video,.reel img,.step img{width:100%;display:block;border-radius:3px}
  .reel video{border:1px solid rgba(255,255,255,.06);background:#000}
  figcaption{margin-top:14px;color:var(--dim);font-size:14.5px;max-width:64ch}
  .rec{
    display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--hot);
    margin-right:8px;vertical-align:1px;box-shadow:0 0 0 3px color-mix(in srgb,var(--hot) 22%,transparent);
  }

  .steps{display:flex;flex-direction:column;gap:56px}
  .step{position:relative}
  .step__n{
    font:600 13px/1 "IBM Plex Mono",monospace;color:var(--accent);
    display:block;margin-bottom:10px;letter-spacing:.05em;
  }
  .step img{border:1px solid var(--rule);background:var(--frame);box-shadow:var(--shadow)}
  .step figcaption{font-size:15px;color:var(--ink)}

  @media (min-width:900px){
    .step{padding-left:64px}
    .step__n{position:absolute;left:0;top:2px;margin:0;text-align:right;width:44px}
  }
  @media (prefers-reduced-motion:reduce){*{animation:none!important}}

  footer{border-top:1px solid var(--rule);padding:28px 0 60px;color:var(--dim);
    font:500 11.5px/1.5 "IBM Plex Mono",monospace;letter-spacing:.06em;text-transform:uppercase}
</style>

<header><div class="wrap">
  <p class="eyebrow">AES67-Deck / Mixer panel</p>
  <h1>The console,<br>strip by strip</h1>
  <p class="lede">A scripted tour of the mixing surface — channel strips, insert racks and analog
  plug-in editors, aux sends, the BS.1770 mastering suite, banks and scenes. Captured headless
  against the running UI with an animated stand-in engine feeding every meter.</p>
  <ul class="spec">
    <li>${shots.length} steps</li>
    <li>headless capture</li>
    <li>live React UI</li>
    <li>720p &middot; mp4 + stills</li>
  </ul>
</div></header>

<main class="wrap">
  ${reelBlock}
  <div class="steps">
${steps}
  </div>
</main>

<footer><div class="wrap">test/browser/showcase.sh &mdash; npm run showcase</div></footer>`;

  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  log(`page: index.html (${(fs.statSync(path.join(OUT, 'index.html')).size / 1e6).toFixed(1)} MB)`);
} catch (e) {
  log(`page build failed: ${e.message}`);
}

console.log(`\n${shots.length} screenshots${reelOk ? ' + 720p mp4' : ''} + page → ${OUT}`);
