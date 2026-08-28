import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.env.WORK_DIR || path.join(HERE, '.work');
const URL = process.env.APP_URL || 'http://127.0.0.1:5273';
const DL = process.env.DL_DIR || path.join(WORK, 'downloads');
const SHOTS = process.env.SHOT_DIR || path.join(WORK, 'shots');
fs.mkdirSync(DL, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
for (const f of fs.readdirSync(DL)) fs.rmSync(path.join(DL, f), { force: true });

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDownload(timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const files = fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload'));
    if (files.length) { await sleep(150); return path.join(DL, files.sort().pop()); }
    await sleep(150);
  }
  return null;
}
const clearDownloads = () => { for (const f of fs.readdirSync(DL)) fs.rmSync(path.join(DL, f), { force: true }); };

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[browser error]', m.text()); });

  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => document.body && document.body.innerText.includes('TIMELINE'), { timeout: 15000 });
  check('app loaded', true);

  // --- switch to TIMELINE view ---------------------------------------
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'TIMELINE');
    b && b.click();
  });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'CUES'), { timeout: 8000 });
  check('timeline view + CUES/LUFS toggles present', true);

  const clickByText = (t) => page.evaluate((txt) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === txt);
    if (!b) return false; b.click(); return true;
  }, t);

  const clickTransport = (idx) => page.evaluate((i) => {
    const cluster = [...document.querySelectorAll('div')].find(
      (d) => d.querySelector('.text-green-500.tracking-widest') && d.querySelectorAll(':scope > button').length === 3,
    );
    cluster && cluster.querySelectorAll(':scope > button')[i].click();
  }, idx);

  // --- CUE LIST -----------------------------------------------------
  await clickByText('CUES');
  await page.waitForFunction(() => document.body.innerText.includes('CUE LIST'), { timeout: 5000 });
  check('cue list panel opened', true);

  // roll the transport so successive cues get distinct timecodes
  await clickTransport(1);
  await sleep(2500);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('ADD CUE @ PLAYHEAD'));
      b && b.click();
    });
    await sleep(700);
  }
  await clickTransport(0);

  const cueRows = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('div')].find((d) => d.textContent.startsWith('CUE LIST'));
    return [...panel.querySelectorAll('input')].map((inp) => {
      const row = inp.closest('div');
      return { name: inp.value, tc: row.querySelector('span.font-mono')?.textContent || '' };
    });
  });
  check('3 cues listed', cueRows.length === 3, JSON.stringify(cueRows));
  check('cues have distinct timecodes', new Set(cueRows.map((r) => r.tc)).size === 3, cueRows.map((r) => r.tc).join(' '));

  // rename the first cue with real keyboard input, commit with Enter
  const firstInput = await page.evaluateHandle(() => {
    const panel = [...document.querySelectorAll('div')].find((d) => d.textContent.startsWith('CUE LIST'));
    return panel.querySelector('input');
  });
  await firstInput.asElement().click();
  await firstInput.asElement().evaluate((el) => el.select());
  await page.keyboard.type('Opening VT');
  await page.keyboard.press('Enter');
  await sleep(400);
  const renamed = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('div')].find((d) => d.textContent.startsWith('CUE LIST'));
    return panel.querySelector('input').value;
  });
  check('cue rename accepted', renamed === 'Opening VT', renamed);

  // export as-run CSV
  clearDownloads();
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('EXPORT CSV'));
    b && b.click();
  });
  const csvPath = await waitDownload();
  const csvText = csvPath ? fs.readFileSync(csvPath, 'utf8') : '';
  check('cue CSV downloaded', !!csvPath, csvPath ? path.basename(csvPath) : 'no file');
  check('cue CSV header correct', csvText.startsWith('Cue,Name,Timecode,Seconds,WallClock'), csvText.split('\n')[0]);
  check('cue CSV has 3 data rows', csvText.trim().split('\n').length === 4, JSON.stringify(csvText.trim().split('\n')));
  check('renamed cue reached the store (export reads store)', /^1,Opening VT,/m.test(csvText), csvText.trim().split('\n')[1]);

  await page.screenshot({ path: path.join(SHOTS, 'cue-list.png') });

  // --- LOUDNESS STRIP --------------------------------------------
  await clickByText('LUFS');
  await page.waitForFunction(() => document.body.innerText.includes('LUFS LOG'), { timeout: 5000 });
  check('loudness strip opened', true);

  await clickTransport(1);
  await sleep(4000);

  const strip = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('div')].find((d) => d.textContent.startsWith('LUFS LOG'));
    const readout = panel.querySelector('.font-mono')?.textContent || panel.innerText;
    const paths = panel.querySelectorAll('svg path').length;
    const targetBtns = [...panel.querySelectorAll('button')].filter((b) => ['-14', '-23', '-24'].includes(b.textContent.trim()));
    const active = targetBtns.find((b) => b.className.includes('cyan-600'))?.textContent.trim();
    return { readout, paths, hasReadoutNumber: /-?\d+\.\d/.test(readout), activeTarget: active };
  });
  check('loudness readout shows live numbers', strip.hasReadoutNumber, strip.readout.replace(/\s+/g, ' ').trim());
  check('loudness strip drew S/I paths', strip.paths >= 2, `paths=${strip.paths}`);
  check('default target is -14', strip.activeTarget === '-14', String(strip.activeTarget));

  await page.evaluate(() => {
    const panel = [...document.querySelectorAll('div')].find((d) => d.textContent.startsWith('LUFS LOG'));
    const b = [...panel.querySelectorAll('button')].find((x) => x.textContent.trim() === '-23');
    b && b.click();
  });
  await sleep(500);
  const t2 = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('div')].find((d) => d.textContent.startsWith('LUFS LOG'));
    const b = [...panel.querySelectorAll('button')].filter((x) => ['-14', '-23', '-24'].includes(x.textContent.trim()));
    return b.find((x) => x.className.includes('cyan-600'))?.textContent.trim();
  });
  check('target switch to -23 reflected', t2 === '-23', String(t2));

  await clickTransport(0);

  // export compliance report
  clearDownloads();
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('REPORT REGION'));
    b && b.click();
  });
  const repPath = await waitDownload();
  const repText = repPath ? fs.readFileSync(repPath, 'utf8') : '';
  check('loudness report downloaded', !!repPath, repPath ? path.basename(repPath) : 'no file');
  check('report has compliance summary', /# AES67-Deck loudness compliance report/.test(repText) && /# result: (PASS|FAIL)/.test(repText),
    repText.split('\n').slice(0, 8).join(' | '));
  check('report has sample rows', repText.trim().split('\n').some((l) => /^\d{4}-\d\d-\d\dT/.test(l)));

  await page.screenshot({ path: path.join(SHOTS, 'loudness-strip.png') });
  await page.screenshot({ path: path.join(SHOTS, 'timeline-full.png') });

  // --- Phase 3e: region / loop / punch --------------------------------
  // Park the playhead at 0 (scrub the far-left of the ruler) so REGION spans
  // a known [0, gridSize*8] window.
  const surf = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await page.mouse.click(surf.x + 3, surf.y + 8);
  await sleep(200);
  await clickByText('REGION');
  await sleep(250);
  const loopReady = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'LOOP');
    return b ? !b.disabled : null;
  });
  check('REGION creates a region and enables LOOP', loopReady === true, String(loopReady));

  await clickByText('LOOP');
  await sleep(200);
  await clickTransport(1);           // roll well past the ~8 s region
  await sleep(11000);
  const tcWhileLooping = await page.evaluate(() =>
    [...document.querySelectorAll('.text-green-500.tracking-widest')][0]?.textContent || '');
  await clickTransport(0);
  const secs = Number((tcWhileLooping.match(/00:00:(\d\d):/) || [])[1]);
  check('LOOP wraps the transport inside the region', Number.isFinite(secs) && secs < 8, tcWhileLooping);

  await clickByText('PUNCH');
  await sleep(200);
  const punchOn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'PUNCH');
    return b ? b.className.includes('bg-red-600') : null;
  });
  check('PUNCH toggles on', punchOn === true, String(punchOn));
  await page.screenshot({ path: path.join(SHOTS, 'region-loop-punch.png') });

  // --- Phase 3e: server-timed auto-punch ----------------------------
  await clickByText('LOOP');  // disable loop so the take isn't split each pass
  await sleep(150);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].filter((x) => x.textContent.trim() === 'A' && x.className.includes('w-5'));
    b[0]?.click();            // arm track 1
  });
  await sleep(300);
  const recBtnClass = () => page.evaluate(() => {
    const cluster = [...document.querySelectorAll('div')].find(
      (d) => d.querySelector('.text-green-500.tracking-widest') && d.querySelectorAll(':scope > button').length === 3);
    return cluster?.querySelectorAll(':scope > button')[2]?.className || '';
  });
  await page.mouse.click(surf.x + 3, surf.y + 8);   // playhead → 0
  await sleep(150);
  await clickTransport(1);
  await sleep(3000);
  const recInside = (await recBtnClass()).includes('bg-red-600');
  await sleep(7000);                                 // past the 8 s out-point
  const recAfter = (await recBtnClass()).includes('bg-red-600');
  await clickTransport(0);
  check('auto-punch drops IN over the region', recInside, String(recInside));
  check('auto-punch drops OUT after the region', !recAfter, String(recAfter));

  // --- Phase 4: undo / redo ------------------------------------------
  await page.evaluate(() => document.querySelector('div[tabindex="0"]')?.focus());
  const cueCount = () => page.evaluate(() => {
    const p = [...document.querySelectorAll('div')].find((d) => d.textContent.startsWith('CUE LIST'));
    return p ? p.querySelectorAll('input').length : -1;
  });
  const n0 = await cueCount();
  await page.keyboard.press('KeyM'); await sleep(450);   // spaced so each is its own history step
  await page.keyboard.press('KeyM'); await sleep(450);
  const nAdd = await cueCount();
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
  await sleep(250);
  const nUndo = await cueCount();
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('KeyZ');
  await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await sleep(250);
  const nRedo = await cueCount();
  check('two markers added', nAdd === n0 + 2, `${n0} -> ${nAdd}`);
  check('Ctrl+Z undoes the last marker', nUndo === nAdd - 1, `${nAdd} -> ${nUndo}`);
  check('Ctrl+Shift+Z redoes it', nRedo === nAdd, `${nUndo} -> ${nRedo}`);

  console.log('\n--- cue CSV ---\n' + csvText);
  console.log('--- report head ---\n' + repText.split('\n').slice(0, 12).join('\n'));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
