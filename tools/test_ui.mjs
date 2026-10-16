// 画面の検査: ヘッドレスの Edge（なければ Chrome）で index.html を開き、押して確かめて、撮影する
// - このフォルダだけを配る小さなサーバーを 127.0.0.1 に立てる（外へは出ない）
// - 音は鳴らさない（--mute-audio）。ブラウザの記録は一時フォルダに作って最後に消す
// - 撮影は shots/v0.1/ に保存する（公開しない）
// 使い方: python tools/build_pages.py のあとで node tools/test_ui.mjs   （ブラウザの場所は BROWSER_PATH でも指定できる）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SHOTS = path.join(ROOT, 'shots', 'v0.1');
const KEY = 'dice-timer.v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 記録 ---------- */
let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) pass++; else fails.push(name + (detail ? ' … ' + detail : ''));
  console.log((cond ? '  通った   ' : '  通らない ') + name + (!cond && detail ? ' … ' + detail : ''));
}
function section(t) { console.log('\n■ ' + t); }

/* ---------- 小さなサーバー（読むだけ） ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
function serve() {
  const srv = http.createServer((req, res) => {
    let p = '/';
    try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400).end('bad'); return; }
    if (p === '/') p = '/index.html';
    const file = path.resolve(ROOT, '.' + p);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end('no'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

/* ---------- ブラウザ ---------- */
function findBrowser() {
  const pf86 = process.env['ProgramFiles(x86)'], pf = process.env.ProgramFiles, local = process.env.LOCALAPPDATA;
  const list = [
    process.env.BROWSER_PATH,
    pf86 && path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    pf && path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    pf && path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  return list.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
}
async function launch(browser, profile) {
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--disable-extensions', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 120; i++) {
    try {
      const lines = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
      const port = Number(lines[0]);
      if (port && lines[1]) return { proc, port, browserPath: lines[1] };
    } catch (e) { /* まだ */ }
    await sleep(150);
  }
  stopTree(proc);
  throw new Error('ブラウザが起動しなかった');
}
// ブラウザを子プロセスごと止める（Windows の proc.kill() は親しか止めないので、木ごと止める）
function stopTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else proc.kill('SIGKILL');
}
// まず CDP で行儀よく閉じる。3秒たっても残っていたら木ごと止める
async function closeBrowser(proc, port, browserPath) {
  try {
    const ws = new WebSocket('ws://127.0.0.1:' + port + browserPath);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(rej, 2000); });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  } catch (e) { /* つながらなければ下で止める */ }
  for (let i = 0; i < 30 && proc.exitCode === null; i++) await sleep(100);
  stopTree(proc);
}
async function removeDir(dir) {
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (e) { await sleep(250); }
  }
  return false;
}
class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = []; this.mobile = true; }
  static async open(port) {
    const r = await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' });
    const info = await r.json();
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const p = new Page(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && p.waiting.has(msg.id)) { p.waiting.get(msg.id)(msg); p.waiting.delete(msg.id); }
      else if (msg.method) p.handlers.forEach((h) => h(msg));
    };
    return p;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(fn) { this.handlers.push(fn); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('ページの中でエラー: ' + JSON.stringify((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
  }
  async waitFor(expr, timeout = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await this.eval('!!(' + expr + ')')) return true;
      await sleep(30);
    }
    return false;
  }
  async viewport(w, h, mobile) {
    this.mobile = mobile;
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile, screenOrientation: w > h ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 } });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
  }
  async load(url) {
    await this.send('Page.navigate', { url });
    await sleep(200);
    await this.waitFor("document.readyState === 'complete' && !!window.DTEngine", 6000);
    await sleep(250);
  }
  async reload() { await this.send('Page.reload', { ignoreCache: true }); await sleep(200); await this.waitFor("document.readyState === 'complete' && !!window.DTEngine", 6000); await sleep(250); }
  // 押す: スマホの大きさは指のタップ、PC はマウスのクリック
  async press(x, y) {
    if (this.mobile) {
      // 指で触れて離す（synthesizeTapGesture はヘッドレスだと click まで届かないので使わない）
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await sleep(25);
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    await sleep(40);
  }
  async box(sel) {
    return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
      if (el.closest('#sheet')) el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, l: r.left, t: r.top }; })()`);
  }
  async pressEl(sel) {
    const b = await this.box(sel);
    if (!b || !b.w) throw new Error('押すものが見えない: ' + sel);
    await this.press(b.x, b.y);
  }
  async shot(name) {
    fs.mkdirSync(SHOTS, { recursive: true });
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
    console.log('  撮影     ' + name);
  }
}

/* ---------- ページの様子を読む ---------- */
const STATE = `(() => { const a = document.getElementById('app'), s = document.getElementById('dice-stage'), o = document.getElementById('once-label');
  let saved = null; try { saved = JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}) || 'null'); } catch (e) { saved = 'error'; }
  return { mode: a.dataset.mode, rolling: a.dataset.rolling || '0', rolls: Number(s.dataset.rolls), count: Number(s.dataset.count),
    dice: document.querySelectorAll('#dice-stage .die').length, shape: s.dataset.shape || '',
    faces: [...document.querySelectorAll('#dice-stage .die')].map((d) => Number(d.dataset.face)),
    phase: a.dataset.phase, idx: Number(a.dataset.idx), round: Number(a.dataset.round), blink: a.dataset.blink || '',
    num: document.getElementById('t-num').textContent, pc: a.style.getPropertyValue('--pc'),
    once: o.hidden ? '' : o.textContent, countText: document.getElementById('count-num').textContent,
    pressed: [...document.querySelectorAll('.q-btn')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.id),
    usual: [...document.querySelectorAll('.q-btn.is-usual')].map((b) => b.id),
    sheetOpen: !document.getElementById('sheet').hidden && document.getElementById('sheet').classList.contains('open'),
    sheetHidden: document.getElementById('sheet').hidden, saved }; })()`;
const MEASURE = `(() => {
  const de = document.documentElement, b = document.body, vw = de.clientWidth, vh = de.clientHeight;
  const bad = [];
  const where = (el, r) => (el.id || el.className || el.tagName) + ' [' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') + ']';
  document.querySelectorAll('#app button, #app .die, #app .t-num, #app .chip, #dice-stage, #timer-pane, #quick, #bar, #sheet, #sheet button, #sheet input, #sheet label').forEach((el) => {
    if (el.closest('[hidden]')) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    // 設定シートの中はスクロールする場所。上下は切れてよく、横にはみ出さないことだけ見る
    if (el.closest('.sheet-body')) {
      const sb = document.querySelector('.sheet-body').getBoundingClientRect();
      if (r.left < sb.left - 0.5 || r.right > sb.right + 0.5) bad.push(where(el, r));
      return;
    }
    if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) bad.push(where(el, r));
  });
  const inner = [];
  ['.t-top', '.t-foot', '.t-sub', '.t-list', '.bar', '.sheet-body', '.p-row', '.seg', '.seg label'].forEach((s) => document.querySelectorAll(s).forEach((el) => {
    if (el.closest('[hidden]') || !el.offsetParent) return;
    if (el.scrollWidth > el.clientWidth + 1) inner.push(s + ' ' + el.scrollWidth + '>' + el.clientWidth);
  }));
  const num = document.getElementById('t-num'), box = num.closest('.t-numbox');
  let numFit = true;
  if (box.offsetParent) { const nr = num.getBoundingClientRect(), br = box.getBoundingClientRect(); numFit = nr.left >= br.left - 0.5 && nr.right <= br.right + 0.5 && nr.top >= br.top - 0.5 && nr.bottom <= br.bottom + 0.5; }
  // ふちの線（外から 3〜13px）の内側に部品が収まっているか
  let ringClear = true;
  const ring = document.getElementById('ring-wrap');
  if (!ring.hidden) {
    const rr = ring.getBoundingClientRect();
    ['#bar', '#timer-pane', '#dice-pane', '#quick'].forEach((s) => { const el = document.querySelector(s); if (!el || el.hidden) return; const r = el.getBoundingClientRect();
      if (r.left < rr.left + 13 || r.top < rr.top + 13 || r.right > rr.right - 13 || r.bottom > rr.bottom - 13) ringClear = false; });
  }
  return { scrollX: Math.max(de.scrollWidth - de.clientWidth, b.scrollWidth - b.clientWidth), scrollY: Math.max(de.scrollHeight - de.clientHeight, b.scrollHeight - b.clientHeight), bad, inner, numFit, ringClear,
    numFont: parseFloat(getComputedStyle(num).fontSize) || 0, dieSize: (document.querySelector('.die') || { offsetWidth: 0 }).offsetWidth };
})()`;

/* ---------- 本番 ---------- */
const browser = findBrowser();
if (!browser) { console.error('Edge か Chrome が見つからない（BROWSER_PATH で場所を指定できる）'); process.exit(2); }
const srv = await serve();
const base = 'http://127.0.0.1:' + srv.address().port + '/';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dice-timer-ui-'));
const { proc, port, browserPath } = await launch(browser, profile);
const page = await Page.open(port);
const errors = [];
const outside = [];
page.on((m) => {
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) errors.push('console.' + m.params.type + ': ' + JSON.stringify(m.params.args.map((a) => a.value || a.description)));
  if (m.method === 'Runtime.exceptionThrown') errors.push('例外: ' + ((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('ログ: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  if (m.method === 'Network.requestWillBeSent') { const u = m.params.request.url; if (!u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('about:')) outside.push(u); }
});
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Log.enable');
await page.send('Network.enable');
// 試験だけの仕掛け（本体は変えない）: window.__skip を足すと時刻が先へ進む／音の部品（オシレーター）を作った数を window.__osc に数える
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__skip = 0; window.__osc = 0;
  (function () { var real = performance.now.bind(performance); performance.now = function () { return real() + window.__skip; }; })();
  (function () { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; var make = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function () { window.__osc++; return make.apply(this, arguments); }; })();
` });
const oscNow = () => page.eval('window.__osc');
const state = () => page.eval(STATE);
const notRolling = () => page.waitFor("document.getElementById('app').dataset.rolling !== '1'", 3000);
const setSaved = (obj) => page.eval(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(obj))}); true`);

try {
  /* ===== 390×844 ===== */
  section('スマホ縦（390×844）: サイコロ');
  await page.viewport(390, 844, true);
  await page.load(base + 'index.html');
  await page.eval('localStorage.clear(); true');
  await page.reload();
  let s = await state();
  ok('はじめて開くと「サイコロ」の画面・2個', s.mode === 'dice' && s.dice === 2 && s.count === 2 && s.countText === '2個', JSON.stringify(s));
  ok('2個は縦に2つ（参考の画面どおり）', s.shape === 'col', s.shape);
  ok('早押しの列の「いつも」の印は2', JSON.stringify(s.usual) === '["quick-2"]', JSON.stringify(s.usual));
  await page.shot('01_サイコロ2個.png');

  const st = await page.box('#dice-stage');
  await page.press(st.x, st.y);
  await sleep(60);
  const s1 = await state();
  await page.press(st.x, st.y);
  await page.press(st.x + 30, st.y - 40);
  const s2 = await state();
  ok('画面を押すとサイコロが振れる（転がり中）', s1.rolling === '1' && s1.rolls === 1, JSON.stringify([s1.rolling, s1.rolls]));
  ok('転がり中の連打は無視（振った回数は1回のまま）', s2.rolls === 1, String(s2.rolls));
  await notRolling();
  s = await state();
  ok('止まると 1〜6 の目が出る', s.rolling === '0' && s.faces.length === 2 && s.faces.every((f) => f >= 1 && f <= 6), JSON.stringify(s.faces));
  const barEmpty = await page.box('#bar');
  await page.press(barEmpty.l + barEmpty.w * 0.62, barEmpty.y);
  await sleep(60);
  ok('上の帯の空いているところを押しても振れる', (await state()).rolls === 2);
  await notRolling();

  await page.pressEl('#quick-4');
  await sleep(60);
  s = await state();
  ok('早押し［4］で、その回だけ4個になって振れる', s.dice === 4 && s.rolling === '1' && s.once === 'この回だけ 4個' && JSON.stringify(s.pressed) === '["quick-4"]', JSON.stringify([s.dice, s.rolling, s.once, s.pressed]));
  await notRolling();
  s = await state();
  ok('… 4個とも目が出る・並べ方は 2×2', s.faces.length === 4 && s.shape === 'square', JSON.stringify([s.faces, s.shape]));
  await page.shot('02_早押し4個の直後.png');
  await page.press(st.x, st.y);
  await sleep(60);
  s = await state();
  ok('次にふつうに押すと、いつもの2個に戻って振れる', s.dice === 2 && s.once === '' && s.pressed.length === 0 && s.rolling === '1', JSON.stringify([s.dice, s.once, s.pressed]));
  await notRolling();

  await page.pressEl('#count-minus');
  s = await state();
  ok('［−］でいつもの個数が1に・保存される', s.count === 1 && s.dice === 1 && s.countText === '1個' && s.saved && s.saved.count === 1, JSON.stringify([s.count, s.countText, s.saved && s.saved.count]));
  ok('… 1個のときの［−］は押せない', await page.eval("document.getElementById('count-minus').disabled"));
  await page.press(st.x, st.y);
  await notRolling();
  await page.shot('03_サイコロ1個.png');
  for (let i = 0; i < 5; i++) await page.pressEl('#count-plus');
  s = await state();
  ok('［＋］5回で6個・保存される・「いつも」の印も6へ', s.count === 6 && s.dice === 6 && s.saved && s.saved.count === 6 && JSON.stringify(s.usual) === '["quick-6"]', JSON.stringify([s.count, s.saved && s.saved.count, s.usual]));
  await page.press(st.x, st.y);
  await notRolling();
  s = await state();
  ok('6個は 2×3 に並ぶ', s.shape === 'tall', s.shape);
  await page.shot('04_サイコロ6個.png');
  await page.reload();
  s = await state();
  ok('読み直しても いつもの個数（6個）を覚えている', s.count === 6 && s.dice === 6 && s.countText === '6個', JSON.stringify([s.count, s.countText]));
  for (let i = 0; i < 4; i++) await page.pressEl('#count-minus');
  ok('（2個に戻す）', (await state()).count === 2);

  section('動きを減らす設定（prefers-reduced-motion）');
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const t0 = Date.now();
  await page.press(st.x, st.y);
  const anims = await page.eval("document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.classList && a.effect.target.classList.contains('die')).length");
  await notRolling();
  const took = Date.now() - t0;
  ok('転がりが短い（' + took + 'ms）・回転の動きなし', took < 700 && anims === 0, JSON.stringify({ took, anims }));
  await page.send('Emulation.setEmulatedMedia', { features: [] });

  section('キーボード');
  await page.eval("document.getElementById('count-plus').blur(); document.body.focus(); true");
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const focusInfo = await page.eval("(() => { const el = document.activeElement; const cs = getComputedStyle(el); return { id: el.id, outline: cs.outlineStyle, width: cs.outlineWidth }; })()");
  ok('Tab で移ったところに見える枠が出る（' + focusInfo.id + '）', focusInfo.outline !== 'none' && parseFloat(focusInfo.width) >= 2, JSON.stringify(focusInfo));
  const before = (await state()).rolls;
  await page.eval("document.getElementById('dice-stage').focus(); true");
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(60);
  ok('サイコロの場所で Enter を押しても振れる', (await state()).rolls === before + 1);
  await notRolling();

  section('設定シートとモード');
  await page.pressEl('#open-settings');
  ok('右上のサイコロの絵で設定シートが開く', await page.waitFor("!document.getElementById('sheet').hidden && document.getElementById('sheet').classList.contains('open')"));
  await sleep(350);
  ok('サイコロの画面では、タイマーの設定は出さない', await page.eval("document.getElementById('timer-fields').hidden"));
  await page.pressEl('label[for="mode-both"]');
  await sleep(200);
  s = await state();
  ok('モードを「サイコロ＋タイマー」にすると切り替わる・保存される', s.mode === 'both' && s.saved && s.saved.mode === 'both', JSON.stringify([s.mode, s.saved && s.saved.mode]));
  await page.eval("document.querySelector('.sheet-body').scrollTop = 0; true");
  await sleep(100);
  await page.shot('09_設定シート.png');
  await page.pressEl('#sheet-close');
  ok('［閉じる］で設定シートが閉じる', await page.waitFor("document.getElementById('sheet').hidden"));
  await page.pressEl('#open-settings');
  await page.waitFor("document.getElementById('sheet').classList.contains('open')");
  await sleep(300);
  await page.press(195, 30);   // シートの外（暗いところ）
  ok('シートの外を押しても閉じる（サイコロは振れない）', await page.waitFor("document.getElementById('sheet').hidden") && (await state()).rolling === '0');
  await page.reload();
  s = await state();
  ok('読み直してもモード（サイコロ＋タイマー）を覚えている', s.mode === 'both' && s.dice === 2 && s.shape === 'row', JSON.stringify([s.mode, s.shape]));
  await page.shot('17_サイコロ＋タイマー_スタート前.png');

  section('サイコロ＋タイマー（手番タイマー）');
  const rollsBefore = s.rolls;
  ok('スタート前は「タップでスタート」・1番（赤）・20', s.phase === 'idle' && s.idx === 0 && s.num === '20' && (await page.eval("document.getElementById('t-hint').textContent")) === 'タップでスタート', JSON.stringify([s.phase, s.idx, s.num]));
  await page.pressEl('#timer-pane .t-top');
  await sleep(80);
  s = await state();
  ok('タイマー欄を押すとスタート', s.phase === 'running' && s.idx === 0, JSON.stringify([s.phase, s.idx]));
  await page.pressEl('#timer-pane .t-top');
  await sleep(60);
  ok('スタート直後（0.4秒以内）の押しは無視', (await state()).idx === 0);
  await sleep(500);
  await page.pressEl('#t-num');
  await sleep(80);
  s = await state();
  ok('タイマー欄を押すと次の人（2番・青）へ', s.idx === 1 && s.pc.includes('blue'), JSON.stringify([s.idx, s.pc]));
  ok('タイマー欄を押してもサイコロは振れない', s.rolls === rollsBefore, String(s.rolls));
  const sub = await page.eval("document.getElementById('t-sub').textContent");
  ok('次の人と周を出す（「次 白 20」・1周目）', sub === '次 白 20' && s.round === 1, JSON.stringify([sub, s.round]));
  await page.pressEl('#t-pause');
  await sleep(80);
  s = await state();
  const n1 = s.num;
  await sleep(1300);
  const s3 = await state();
  ok('一時停止で止まる（「一時停止中」）', s.phase === 'paused' && s3.num === n1 && (await page.eval("document.getElementById('t-hint').textContent")).startsWith('一時停止中'), JSON.stringify([s.phase, n1, s3.num]));
  await page.pressEl('#timer-pane .t-top');
  await sleep(80);
  s = await state();
  ok('一時停止中にタイマー欄を押すと再開（次へは進まない）', s.phase === 'running' && s.idx === 1, JSON.stringify([s.phase, s.idx]));
  await page.pressEl('#t-back');
  await sleep(80);
  s = await state();
  ok('［1人戻す］で前の人（1番）の20秒から', s.idx === 0 && s.num === '20', JSON.stringify([s.idx, s.num]));
  await sleep(500);
  await page.pressEl('#timer-pane .t-top');
  await sleep(2600);
  await page.shot('05_サイコロ＋タイマー_途中.png');

  // 1番を5秒にして最初から → 残り3秒の点滅を撮る
  await page.pressEl('#open-settings');
  await page.waitFor("document.getElementById('sheet').classList.contains('open')");
  await sleep(300);
  for (let i = 0; i < 3; i++) await page.pressEl('#p-minus-1');
  ok('［−5］で1番の秒数が 20→5', (await page.eval("document.getElementById('p-time-1').value")) === '5');
  await page.pressEl('#reset-timer');
  ok('ゲーム中の［最初から］は、もう一度押してもらう', await page.eval("document.getElementById('reset-timer').hasAttribute('data-armed') && !document.getElementById('confirm-note').hidden"));
  await page.pressEl('#reset-timer');
  await page.waitFor("document.getElementById('sheet').hidden");
  s = await state();
  ok('もう一度押すと、止めて1番・スタート前（5秒）', s.phase === 'idle' && s.idx === 0 && s.num === '5', JSON.stringify([s.phase, s.idx, s.num]));
  await page.pressEl('#t-num');
  ok('残り3秒になると点滅が始まる', await page.waitFor("document.getElementById('app').dataset.blink === 'on' && document.getElementById('t-num').textContent === '3'", 4000));
  await page.shot('06_サイコロ＋タイマー_残り3秒点滅.png');
  ok('… 1秒の後ろ半分は薄くなる（点滅）', await page.waitFor("document.getElementById('app').dataset.blink === 'off'", 1500));
  ok('0秒になると自動で次の人（2番・青）へ', await page.waitFor("document.getElementById('app').dataset.idx === '1'", 4000) && (await state()).pc.includes('blue'));

  section('タイマーだけ');
  await page.pressEl('#open-settings');
  await page.waitFor("document.getElementById('sheet').classList.contains('open')");
  await sleep(300);
  for (let i = 0; i < 3; i++) await page.pressEl('#p-plus-1');
  await page.pressEl('label[for="mode-timer"]');
  await page.pressEl('#sheet-close');
  await page.waitFor("document.getElementById('sheet').hidden");
  s = await state();
  ok('タイマーだけの画面になる（サイコロと早押しの列は出さない）', s.mode === 'timer' && (await page.eval("document.getElementById('dice-pane').hidden && document.getElementById('quick').hidden")), s.mode);
  const i0 = s.idx;
  await sleep(450);
  await page.press(120, 40);      // 上のすみ（設定ボタン以外）
  await sleep(450);
  const i1 = (await state()).idx;
  await page.press(195, 420);     // まん中
  await sleep(450);
  const i2 = (await state()).idx;
  await page.press(60, 790);      // 左下（ボタン以外）
  await sleep(80);
  const i3 = (await state()).idx;
  const nA = 4;
  ok('タイマーだけの画面では、どこを押しても次へ（上・まん中・下）', i1 === (i0 + 1) % nA && i2 === (i1 + 1) % nA && i3 === (i2 + 1) % nA, JSON.stringify([i0, i1, i2, i3]));
  await sleep(2300);
  await page.shot('07_タイマーだけ.png');

  section('持ち時間（将棋式）');
  await page.pressEl('#open-settings');
  await page.waitFor("document.getElementById('sheet').classList.contains('open')");
  await sleep(300);
  await page.pressEl('label[for="mode-both"]');
  await page.pressEl('label[for="ttype-clock"]');
  await page.pressEl('label[for="byo-30"]');
  s = await state();
  ok('種類を持ち時間にすると、止めて1番・スタート前（10:00）', s.phase === 'idle' && s.idx === 0 && s.num === '10:00', JSON.stringify([s.phase, s.num]));
  await page.pressEl('#apply-start');
  await page.waitFor("document.getElementById('sheet').hidden");
  await page.pressEl('#timer-pane .t-top');
  await sleep(1300);
  await page.pressEl('#timer-pane .t-top');
  await sleep(900);
  await page.pressEl('#timer-pane .t-top');
  await sleep(1600);
  s = await state();
  const chips = await page.eval("[...document.querySelectorAll('#t-list .chip')].map((c) => c.textContent)");
  ok('今の人（3番）の残りを m:ss で大きく・ほかの3人の残りを一覧（次の人から）', s.idx === 2 && /^\d+:\d\d$/.test(s.num) && chips.length === 3 && chips[0] === '10:00', JSON.stringify([s.idx, s.num, chips]));
  ok('… 下の段に秒読みの設定（秒読み 30秒）', (await page.eval("document.getElementById('t-sub').textContent")) === '秒読み 30秒');
  await page.shot('08_持ち時間_将棋式.png');

  section('持ち時間の秒読みと時間切れ（時刻を先へ送って確かめる）');
  await setSaved({ mode: 'both', ttype: 'clock', nB: 2, mins: [1, 1, 1, 1, 1, 1], byo: 10, count: 2 });
  await page.reload();
  const oStartB = await oscNow();
  await page.pressEl('#t-num');
  await sleep(100);
  ok('持ち時間: スタートで「ポポポーン」（音の部品3つ）', (await oscNow()) - oStartB === 3, String((await oscNow()) - oStartB));
  await page.eval('window.__skip += 62000; true');
  await sleep(200);
  s = await state();
  const whoByo = await page.eval("document.getElementById('t-who').textContent");
  ok('持ち時間が0になると秒読み（「秒読み」と出て、秒だけで数える）', whoByo.includes('秒読み') && /^\d{1,2}$/.test(s.num) && Number(s.num) <= 8, JSON.stringify([whoByo, s.num]));
  await page.shot('16_持ち時間_秒読み.png');
  await setSaved({ mode: 'both', ttype: 'clock', nB: 3, mins: [1, 1, 1, 1, 1, 1], byo: 0, count: 2 });
  await page.reload();
  await page.pressEl('#t-num');
  await page.eval('window.__skip += 58600; true');
  await page.waitFor("document.getElementById('t-num').textContent === '0:01'", 2000);
  await sleep(150);
  const oBefore = await oscNow();
  ok('時間切れになると時計が止まる', await page.waitFor("document.getElementById('app').dataset.phase === 'flagged'", 2500));
  await sleep(200);
  s = await state();
  const hintOut = await page.eval("document.getElementById('t-hint').textContent");
  ok('… 「時間切れ」と大きく出す・押すと次へと出す', s.num === '時間切れ' && hintOut === '時間切れ ・ タップで次の人へ', JSON.stringify([s.num, hintOut]));
  ok('… 時間切れの音（ピピピッ＝音の部品6つ）', (await oscNow()) - oBefore === 6, String((await oscNow()) - oBefore));
  await page.shot('15_持ち時間_時間切れ.png');
  await sleep(1200);
  ok('… 止まったまま（1秒たっても時間切れのまま）', (await state()).phase === 'flagged');
  const oNextB = await oscNow();
  await page.pressEl('#timer-pane .t-top');
  await sleep(150);
  ok('持ち時間: 押して次の人へで「ピロン」（音の部品2つ）', (await oscNow()) - oNextB === 2, String((await oscNow()) - oNextB));
  s = await state();
  const chipsOut = await page.eval("[...document.querySelectorAll('#t-list .chip')].map((c) => c.textContent + (c.classList.contains('is-out') ? '*' : ''))");
  ok('押すと次の人（2番）の時計が動き、1番は一覧で「時間切れ」のまま', s.phase === 'running' && s.idx === 1 && chipsOut[1] === '時間切れ*', JSON.stringify([s.phase, s.idx, chipsOut]));

  section('音の合図（音の部品を作った数で確かめる。ブラウザは消音で動かしている）');
  await setSaved({ mode: 'both', ttype: 'turn', nA: 2, secs: [20, 20, 20, 20, 20, 20], count: 2 });
  await page.reload();
  const dz = await page.box('#dice-stage');
  let o0 = await oscNow();
  const tPress = Date.now();
  await page.press(dz.x, dz.y);
  await sleep(250);
  ok('転がっている間は音を作らない', (await oscNow()) - o0 === 0, String((await oscNow()) - o0));
  await notRolling();
  const tookRoll = Date.now() - tPress;
  await sleep(100);
  ok('全部止まった瞬間に「カタン」を1回だけ作る（音の部品3つ）', (await oscNow()) - o0 === 3, String((await oscNow()) - o0));
  ok('目が出るまで 0.55秒ほど（' + tookRoll + 'ms）', tookRoll >= 500 && tookRoll < 900, String(tookRoll));
  o0 = await oscNow();
  await page.pressEl('#t-num');
  await sleep(100);
  ok('手番: スタートで「ポポポーン」（音の部品3つ）', (await oscNow()) - o0 === 3, String((await oscNow()) - o0));
  await page.eval('window.__skip += 9600; true');
  o0 = await oscNow();
  await page.waitFor("document.getElementById('t-num').textContent === '10'", 2000);
  await sleep(200);
  ok('残り半分（10秒）で「ポーン」（音の部品3つ）', (await oscNow()) - o0 === 3, String((await oscNow()) - o0));
  await page.eval('window.__skip += 6500; true');
  o0 = await oscNow();
  const counts = [];
  for (const n of ['3', '2', '1']) {
    await page.waitFor("document.getElementById('t-num').textContent === '" + n + "'", 2000);
    await sleep(120);
    counts.push((await oscNow()) - o0);
  }
  ok('残り 3・2・1 で「ピッ」（1回に音の部品2つ）', JSON.stringify(counts) === '[2,4,6]', JSON.stringify(counts));
  o0 = await oscNow();
  await page.waitFor("document.getElementById('app').dataset.idx === '1'", 2000);
  await sleep(200);
  ok('0秒の切り替わり（自動で次の人へ）で「ピーーッ」（音の部品3つ）', (await oscNow()) - o0 === 3, String((await oscNow()) - o0));
  await sleep(500);
  o0 = await oscNow();
  await page.pressEl('#timer-pane .t-top');
  await sleep(200);
  ok('押して次へ進んだときは「ピロン」（音の部品2つ）', (await state()).idx === 0 && (await oscNow()) - o0 === 2, String((await oscNow()) - o0));
  await sleep(500);
  o0 = await oscNow();
  await page.pressEl('#t-back');
  await sleep(150);
  ok('［1人戻す］では鳴らさない', (await oscNow()) - o0 === 0, String((await oscNow()) - o0));
  await setSaved({ mode: 'timer', ttype: 'turn', nA: 3, secs: [10, 20, 30, 20, 20, 20] });
  await page.reload();
  await page.pressEl('#t-num');
  o0 = await oscNow();
  await page.eval('window.__skip += 603200; true');   // 10分3.2秒すすんだ（1周60秒）＝隠れて戻ったとき
  await sleep(200);
  s = await state();
  ok('時刻が10分とんでも、経過から正しい人・残り・周を出す（1番・7・11周目）', s.idx === 0 && s.num === '7' && s.round === 11, JSON.stringify([s.idx, s.num, s.round]));
  ok('… 通り過ぎた音はまとめて鳴らさない', (await oscNow()) - o0 === 0, String((await oscNow()) - o0));
  await setSaved({ mode: 'both', ttype: 'turn', nA: 2, secs: [5, 5, 20, 20, 20, 20], count: 2, sound: false });
  await page.reload();
  o0 = await oscNow();
  await page.press((await page.box('#dice-stage')).x, (await page.box('#dice-stage')).y);
  await notRolling();
  await page.pressEl('#t-num');
  await page.waitFor("document.getElementById('app').dataset.idx === '1'", 7000);
  ok('「音を出す」がオフなら、サイコロもタイマーも音を作らない', (await oscNow()) - o0 === 0, String((await oscNow()) - o0));

  /* ===== 横向き・PC ===== */
  section('横向き（844×390）と PC（1280×800）');
  await setSaved({ mode: 'both', ttype: 'turn', count: 2 });
  await page.viewport(844, 390, true);
  await page.reload();
  await page.pressEl('#t-num');
  await page.press((await page.box('#dice-stage')).x, (await page.box('#dice-stage')).y);
  await notRolling();
  await sleep(1800);
  const land = await page.eval("(() => { const t = document.getElementById('timer-pane').getBoundingClientRect(), d = document.getElementById('dice-pane').getBoundingClientRect(); return { timerRight: t.right, diceLeft: d.left }; })()");
  ok('横向きのサイコロ＋タイマーは左にタイマー・右にサイコロ', land.timerRight <= land.diceLeft, JSON.stringify(land));
  await page.shot('10_横向き_サイコロ＋タイマー_844x390.png');
  await page.viewport(1280, 800, false);
  await page.reload();
  await page.pressEl('#t-num');
  await page.press((await page.box('#dice-stage')).x, (await page.box('#dice-stage')).y);
  await notRolling();
  await sleep(1800);
  await page.shot('11_PC_1280x800.png');

  /* ===== はみ出し ===== */
  section('4つの大きさで、横にも縦にもはみ出さない');
  const sizes = [[390, 844, true], [360, 740, true], [844, 390, true], [1280, 800, false]];
  const configs = [
    { name: 'サイコロ2個', s: { mode: 'dice', count: 2 } },
    { name: 'サイコロ6個', s: { mode: 'dice', count: 6 } },
    { name: 'サイコロ＋手番', s: { mode: 'both', ttype: 'turn', count: 2, nA: 4 }, start: true, shot360: '13_サイコロ＋タイマー_360x740.png' },
    { name: 'サイコロ＋持ち時間6人・秒読み', s: { mode: 'both', ttype: 'clock', count: 3, nB: 6, byo: 30 }, start: true, next: 2, shot360: '14_持ち時間6人_360x740.png' },
    { name: 'タイマーだけ（手番 90秒）', s: { mode: 'timer', ttype: 'turn', nA: 2, secs: [90, 90, 20, 20, 20, 20] }, start: true },
    { name: 'タイマーだけ（持ち時間 180分・6人）', s: { mode: 'timer', ttype: 'clock', nB: 6, mins: [180, 180, 180, 180, 180, 180] }, start: true },
  ];
  for (const [w, h, mobile] of sizes) {
    await page.viewport(w, h, mobile);
    for (const c of configs) {
      await setSaved(c.s);
      await page.reload();
      if (c.start) {
        await page.pressEl('#t-num');
        for (let k = 0; k < (c.next || 0); k++) { await sleep(450); await page.pressEl('#t-num'); }
        await sleep(150);
      }
      const r = await page.eval(MEASURE);
      const good = r.scrollX <= 0 && r.scrollY <= 0 && r.bad.length === 0 && r.inner.length === 0 && r.numFit && r.ringClear;
      ok(w + '×' + h + ' ' + c.name + '（数字 ' + Math.round(r.numFont) + 'px・サイコロ ' + r.dieSize + 'px）', good, JSON.stringify(r));
      if (w === 360 && c.shot360) await page.shot(c.shot360);
    }
    await page.pressEl('#open-settings');
    await page.waitFor("document.getElementById('sheet').classList.contains('open')");
    await sleep(350);
    const r = await page.eval(MEASURE);
    ok(w + '×' + h + ' 設定シート（中だけがスクロールする）', r.scrollX <= 0 && r.scrollY <= 0 && r.bad.length === 0 && r.inner.length === 0, JSON.stringify(r));
    if (w === 360) await page.shot('12_設定シート_360x740.png');
  }

  section('コンソールと外への通信');
  ok('コンソールのエラー 0', errors.length === 0, errors.slice(0, 5).join(' ／ '));
  ok('外への通信 0（このフォルダのサーバー以外に取りに行かない）', outside.length === 0, outside.slice(0, 5).join(' ／ '));
} catch (e) {
  fails.push('途中で止まった: ' + (e && e.stack || e));
  console.log('途中で止まった: ' + (e && e.stack || e));
} finally {
  try { page.ws.close(); } catch (e) { /* もう閉じている */ }
  await closeBrowser(proc, port, browserPath);
  srv.close();
  if (!(await removeDir(profile))) console.log('（ブラウザの一時の記録を消せなかった: ' + path.basename(profile) + '）');
}

console.log('\n' + (fails.length ? '通らなかった: ' + fails.length + ' 件 ／ 通った: ' + pass + ' 件' : 'すべて通った: ' + pass + ' 件'));
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
