// エンジン（dice-timer.html の <script id="engine">）の単体テスト
// 本体から engine の部分だけを取り出し、Node の vm で動かす。時刻は引数で渡すので、時間を早送りして確かめられる
// 使い方: node tools/test_engine.mjs   （dice-timer フォルダで実行。全部通ると終了コード 0）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'dice-timer.html'), 'utf8');
const m = html.match(/<script id="engine">([\s\S]*?)<\/script>/);
if (!m) { console.error('<script id="engine"> が見つからない'); process.exit(2); }
const sandbox = { crypto: webcrypto, console };
vm.createContext(sandbox);
vm.runInContext(m[1], sandbox, { filename: 'engine' });
const E = sandbox.DTEngine;
if (!E) { console.error('window.DTEngine が出ていない'); process.exit(2); }

let pass = 0;
const fails = [];
const J = (v) => JSON.stringify(v);
function ok(name, cond, detail) {
  if (cond) pass++; else fails.push(name + (detail ? ' … ' + detail : ''));
  console.log((cond ? '  通った   ' : '  通らない ') + name + (!cond && detail ? ' … ' + detail : ''));
}
function eq(name, got, want) { ok(name, J(got) === J(want), '期待 ' + J(want) + ' ／ 実際 ' + J(got)); }
function section(t) { console.log('\n■ ' + t); }
// from の次から to まで step ミリ秒ずつ進めて、出てきた合図を集める（時間は前にしか進めない）
function collect(t, from, to, step = 10) {
  const out = [];
  for (let x = from + step; x < to; x += step) out.push(...t.tick(x));
  out.push(...t.tick(to));
  return out;
}
const sounds = (evs) => evs.filter((e) => e.type === 'half' || e.type === 'count').map((e) => [e.type, e.n || 0, Math.round(e.at)]);

/* ================= A. 手番タイマー ================= */
section('A. 手番タイマー（くり返し）');
{
  const t = new E.TurnTimer({ n: 4, secs: [20, 20, 20, 20, 20, 20] });
  let v = t.view(0);
  eq('スタート前は 1番・20秒・1周目', [v.phase, v.idx, v.remain, v.round], ['idle', 0, 20000, 1]);
  eq('スタート前に押すとスタート', t.tap(1000), 'start');
  v = t.view(6000);
  eq('5秒後は 1番の残り15秒', [v.phase, v.idx, v.remain], ['running', 0, 15000]);
  const evs = collect(t, 6000, 21100);
  eq('0秒で自動で次の人（2番）へ。切り替わりは 21000', evs.filter((e) => e.type === 'turn').map((e) => [e.idx, e.at, !!e.auto]), [[1, 21000, true]]);
  v = t.view(21100);
  eq('次の人は自分の秒数の最初から（0.1秒後に残り19.9秒）', [v.idx, v.remain], [1, 19900]);
  collect(t, 21100, 81100);
  v = t.view(81100);
  eq('最後の人（4番）の次は1番・2周目', [v.idx, v.round], [0, 2]);
  collect(t, 81100, 81100 + 240000, 50);
  v = t.view(81100 + 240000);
  eq('押さなくても、ずっとくり返す（さらに3周で1番・5周目）', [v.idx, v.round, v.phase], [0, 5, 'running']);
}
{
  const t = new E.TurnTimer({ n: 3, secs: [10, 20, 30] });
  t.tap(0);
  eq('スタートから0.4秒以内の押しは無視', t.tap(300), 'ignored');
  eq('0.4秒たてば次へ', t.tap(5000), 'next');
  let v = t.view(5000);
  eq('次へで2番。余った秒は捨てて20秒から', [v.idx, v.remain], [1, 20000]);
  eq('前の次へから0.4秒以内の押しは無視（2人飛ばない）', t.tap(5399), 'ignored');
  eq('0.4秒ちょうどなら押せる', t.tap(5400), 'next');
  v = t.view(5400);
  eq('3番・30秒', [v.idx, v.remain], [2, 30000]);
  t.back(6000);
  v = t.view(6000);
  eq('1人戻すと前の人（2番）の秒数の最初から', [v.idx, v.remain, v.round], [1, 20000, 1]);
  t.back(7000);
  t.back(8000);
  v = t.view(8000);
  eq('1番から戻すと最後の人（3番）', [v.idx, v.remain], [2, 30000]);
}
{
  const t = new E.TurnTimer({ n: 2, secs: [10, 10] });
  t.tap(0);
  collect(t, 0, 20100);   // 1番→2番→1番（2周目）
  let v = t.view(20100);
  eq('（準備）2周目の1番', [v.idx, v.round], [0, 2]);
  t.back(20500);
  v = t.view(20500);
  eq('周の途中で1番から戻すと、前の周の最後の人（2番・1周目）', [v.idx, v.round, v.remain], [1, 1, 10000]);
}
{
  const t = new E.TurnTimer({ n: 3, secs: [10, 10, 10] });
  t.tap(0);
  collect(t, 0, 3000);
  ok('自動の切り替え（0秒）から0.4秒以内の押しは無視', (() => {
    collect(t, 3000, 10100);           // 10000 で 2番へ
    return t.tap(10300) === 'ignored' && t.view(10300).idx === 1;
  })());
  eq('自動の切り替えから0.4秒たてば次へ', [t.tap(10400), t.view(10400).idx], ['next', 2]);
}
{
  const t = new E.TurnTimer({ n: 2, secs: [20, 20] });
  t.tap(0);
  eq('一時停止', t.pause(5000), true);
  let v = t.view(60000);
  eq('一時停止中は減らない', [v.phase, v.remain, v.warn], ['paused', 15000, false]);
  eq('一時停止中に押すと「再開」（次へには進まない）', [t.tap(60000), t.view(60000).idx], ['resume', 0]);
  eq('再開から0.4秒以内の押しは無視', t.tap(60200), 'ignored');
  v = t.view(61000);
  eq('再開したら続きから減る', [v.phase, v.idx, v.remain], ['running', 0, 14000]);
  t.togglePause(62000);
  t.back(63000);
  v = t.view(70000);
  eq('一時停止中に1人戻すと、止まったまま前の人の最初', [v.phase, v.idx, v.remain], ['paused', 1, 20000]);
}
{
  const t = new E.TurnTimer({ n: 5, secs: [10, 20, 30, 15, 19] });
  let v = t.view(0);
  eq('次の人の表示（スタート前）: 2番・20秒', [v.nextIdx, v.nextLen], [1, 20000]);
  t.tap(0);
  [1000, 2000, 3000, 4000].forEach((x) => t.next(x));
  v = t.view(4000);
  eq('5番の次は1番・10秒（まだ1周目）', [v.idx, v.nextIdx, v.nextLen, v.round], [4, 0, 10000, 1]);
  t.next(5000);
  v = t.view(5000);
  eq('1番に戻ると2周目', [v.idx, v.round], [0, 2]);
}
{
  const t = new E.TurnTimer({ n: 1, secs: [20] });
  t.tap(0);
  collect(t, 0, 60100, 20);
  const v = t.view(60100);
  eq('1人なら毎回「回目」が増える（0秒を3回で4回目）', [v.idx, v.round, v.n], [0, 4, 1]);
}
{
  const t = new E.TurnTimer({ n: 3, secs: [20, 20, 20] });
  t.tap(0);
  t.setConfig({ secs: [5, 40, 20] });
  let v = t.view(1000);
  eq('ゲーム中に秒数を変えても今の手番はそのまま（1番は20秒のまま）', [v.idx, v.len, v.remain], [0, 20000, 19000]);
  eq('次の人の表示は新しい秒数（2番・40秒）', v.nextLen, 40000);
  collect(t, 1000, 20100);
  v = t.view(20100);
  eq('次の手番から新しい秒数（2番は40秒）', [v.idx, v.len], [1, 40000]);
  collect(t, 20100, 80100, 20);
  v = t.view(80100);
  eq('その次の1番も新しい秒数（5秒）', [v.idx, v.len, v.round], [0, 5000, 2]);
}
{
  const t = new E.TurnTimer({ n: 5, secs: [10, 10, 10, 10, 10, 10] });
  t.tap(0);
  [1000, 2000, 3000, 4000].forEach((x) => t.next(x));   // 5番
  t.setConfig({ n: 4 });
  let v = t.view(5000);
  eq('人数を5→4に減らしても、今の手番（5番）はそのまま続く', [v.idx, v.remain, v.n], [4, 9000, 4]);
  eq('新しい人数を超えた5番の次は1番', v.nextIdx, 0);
  collect(t, 5000, 14100);
  v = t.view(14100);
  eq('5番の手番が終わると1番・2周目', [v.idx, v.round], [0, 2]);
}
{
  const t = new E.TurnTimer({ n: 4, secs: [10, 10, 10, 10, 10, 10] });
  t.tap(0);
  t.next(1000);
  t.next(2000);   // 3番
  t.setConfig({ n: 2 });
  eq('4→2人で3番がはみ出したら、次へで1番・2周目', [t.tap(3000), t.view(3000).idx, t.view(3000).round], ['next', 0, 2]);
  const u = new E.TurnTimer({ n: 4, secs: [10, 10, 10, 10, 10, 10] });
  u.tap(0);
  u.next(1000);
  u.next(2000);
  u.setConfig({ n: 2 });
  u.back(3000);
  eq('はみ出した番号から1人戻すと、新しい人数の最後の人（2番）', u.view(3000).idx, 1);
}
{
  const secs = [10, 20, 30, 15, 19];   // 1周 94秒
  const t = new E.TurnTimer({ n: 5, secs });
  t.tap(0);
  t.tick(1000);
  const T = 10 * 3600 * 1000 + 12345;   // 画面が隠れていて、10時間と12.345秒後に戻ってきた
  const evs = t.tick(T);
  const v = t.view(T);
  const cyc = 94000, c = Math.floor(T / cyc);
  let r = T - c * cyc, idx = 0;
  while (r >= secs[idx] * 1000) { r -= secs[idx] * 1000; idx++; }
  eq('隠れて戻ったら、経過時間から何人分でも先へ（番号・残り・周）', [v.idx, v.remain, v.round], [idx, secs[idx] * 1000 - r, c + 1]);
  ok('通り過ぎた音はまとめて鳴らさない（返る合図は直近0.3秒のものだけ）', evs.every((e) => e.at > T - 300), J(evs));
  ok('… 返る合図は多くても数個', evs.length <= 3, String(evs.length));
  const u = new E.TurnTimer({ n: 2, secs: [20, 20] });
  u.tap(0);
  u.tick(1000);
  const evs2 = u.tick(19000 + 100);   // 17・18・19秒の合図をまたいで戻った
  eq('… 戻った直後に、0.3秒以内に過ぎた合図だけは鳴らす（19秒の「1」）', sounds(evs2), [['count', 1, 19000]]);
}
{
  const t = new E.TurnTimer({ n: 2, secs: [20, 20], countFrom: 3 });
  t.tap(0);
  const evs = collect(t, 0, 20000, 10);
  eq('20秒: 半分（10秒）と 3・2・1 の時刻', sounds(evs), [['half', 0, 10000], ['count', 3, 17000], ['count', 2, 18000], ['count', 1, 19000]]);
  ok('0秒（20000）は自動の turn だけ（画面側がこれで「ピーーッ」を鳴らす）', evs.filter((e) => e.at === 20000).every((e) => e.type === 'turn') && evs.some((e) => e.at === 20000), J(evs.filter((e) => e.at >= 19500)));
  const evs2 = collect(t, 20000, 40000, 33);   // 次の手番も、刻みが違っても同じ時刻に1回ずつ
  eq('次の手番も同じ時刻に1回ずつ（刻み33ミリ秒でも）', sounds(evs2), [['half', 0, 30000], ['count', 3, 37000], ['count', 2, 38000], ['count', 1, 39000]]);
}
{
  const t = new E.TurnTimer({ n: 2, secs: [20, 20], countFrom: 5 });
  t.tap(0);
  eq('カウント5秒の設定なら 5・4・3・2・1', sounds(collect(t, 0, 20000, 7)), [['half', 0, 10000], ['count', 5, 15000], ['count', 4, 16000], ['count', 3, 17000], ['count', 2, 18000], ['count', 1, 19000]]);
}
{
  const run = (sec, from) => { const t = new E.TurnTimer({ n: 1, secs: [sec], countFrom: from }); t.tap(0); return sounds(collect(t, 0, sec * 1000 - 1, 5)); };
  eq('6秒・カウント3: 半分（3秒）がカウントの始まり以下なので半分は鳴らさない', run(6, 3), [['count', 3, 3000], ['count', 2, 4000], ['count', 1, 5000]]);
  eq('7秒・カウント3: 半分（3.5秒）は鳴らす', run(7, 3), [['half', 0, 3500], ['count', 3, 4000], ['count', 2, 5000], ['count', 1, 6000]]);
  eq('10秒・カウント5: 半分（5秒）は鳴らさない', run(10, 5), [['count', 5, 5000], ['count', 4, 6000], ['count', 3, 7000], ['count', 2, 8000], ['count', 1, 9000]]);
  eq('2秒・カウント3: 手番の始まりと重なる「2」は鳴らさず「1」だけ', run(2, 3), [['count', 1, 1000]]);
  eq('1秒: 何も鳴らさない', run(1, 3), []);
}

/* ================= B. 持ち時間 ================= */
section('B. 持ち時間（将棋式）');
{
  const t = new E.ClockTimer({ n: 2, mins: [10, 10], byo: 0 });
  let v = t.view(0);
  eq('スタート前は 1番 10:00', [v.phase, v.idx, E.formatTime(v.remain, 'clock')], ['idle', 0, '10:00']);
  t.tap(0);
  v = t.view(30000);
  eq('30秒たつと 1番の持ち時間は 9:30', [v.idx, v.remain, v.players[0].main, E.formatTime(v.remain, 'clock')], [0, 570000, 570000, '9:30']);
  eq('次へ', t.tap(30000), 'next');
  v = t.view(50000);
  eq('次へで1番の時計は止まり、2番の時計が減る', [v.idx, v.players[0].main, v.players[1].main], [1, 570000, 580000]);
  t.tap(50000);
  v = t.view(60000);
  eq('持ち時間は戻らない（1番は 9:30 の続きから）', [v.idx, v.remain], [0, 560000]);
  eq('ほかの人の一覧（次の人から）', v.order, [1]);
}
{
  const t = new E.ClockTimer({ n: 2, mins: [1, 1], byo: 10 });
  t.tap(0);
  const evs = collect(t, 0, 60500);
  ok('持ち時間が0で秒読みへ（60000。切り替わりでは音なし）', evs.some((e) => e.type === 'byo' && e.at === 60000) && !evs.some((e) => e.type === 'timeout'), J(evs));
  let v = t.view(60500);
  eq('秒読み中は秒読みの残りを大きく出す（線も秒読みの長さで）', [v.inByo, v.remain, v.len, v.players[0].main], [true, 9500, 10000, 0]);
  t.tap(64000);
  collect(t, 64000, 70000);
  t.tap(70000);
  v = t.view(70000);
  eq('次の手番では秒読みが元の10秒に戻る', [v.idx, v.inByo, v.remain], [0, true, 10000]);
  const evs2 = collect(t, 70000, 80001);
  eq('秒読み（10秒）も半分（5秒・カウント3より長いので鳴る）と 3・2・1、0で時間切れ', evs2.filter((e) => e.type !== 'turn').map((e) => [e.type, e.n || 0, e.at]), [['half', 0, 75000], ['count', 3, 77000], ['count', 2, 78000], ['count', 1, 79000], ['timeout', 0, 80000]]);
  const t5 = new E.ClockTimer({ n: 2, mins: [1, 1], byo: 10, countFrom: 5 });
  t5.tap(0);
  collect(t5, 0, 60000);
  eq('秒読み10秒・カウント5なら、半分（5秒）は鳴らさない', sounds(collect(t5, 60000, 69999)), [['count', 5, 65000], ['count', 4, 66000], ['count', 3, 67000], ['count', 2, 68000], ['count', 1, 69000]]);
}
{
  const t = new E.ClockTimer({ n: 2, mins: [1, 1], byo: 0 });
  t.tap(0);
  const evs = collect(t, 0, 61000);
  eq('秒読みなし: 半分（30秒）・3・2・1、0で時間切れの合図', evs.filter((e) => e.type !== 'turn').map((e) => [e.type, e.n || 0, e.at]), [['half', 0, 30000], ['count', 3, 57000], ['count', 2, 58000], ['count', 1, 59000], ['timeout', 0, 60000]]);
  let v = t.view(80000);
  eq('時間切れで時計が止まる（20秒たっても止まったまま）', [v.phase, v.out, v.remain, v.idx], ['flagged', true, 0, 0]);
  eq('時間切れのあと押すと次の人へ', t.tap(80000), 'next');
  v = t.view(81000);
  eq('2番の時計が動く', [v.phase, v.idx, v.remain], ['running', 1, 59000]);
  t.tap(82000);
  const evs2 = collect(t, 82000, 140000).filter((e) => e.type !== 'turn');
  v = t.view(140000);
  eq('時間切れの人の番が来ても時間切れのまま（時計は動かず、音の合図も出ない）', [v.idx, v.out, v.remain, v.phase, evs2.length], [0, true, 0, 'running', 0]);
  eq('… 押すと次の人へ進む', t.tap(140000), 'next');
  v = t.view(140000);
  eq('… ほかの人の一覧にも「時間切れ」が残る', [v.idx, v.players[0].out, v.players[1].out], [1, true, false]);
}
{
  const t = new E.ClockTimer({ n: 3, mins: [10, 10, 10] });
  t.tap(0);
  t.tap(20000);
  t.tap(25000);   // 2番が押しまちがえた（5秒使った）→ 3番
  t.back(27000);
  const v = t.view(27000);
  eq('1人戻す: 前の人（2番）の時計が続きから', [v.idx, v.remain], [1, 595000]);
  eq('… 戻した人（3番）がこの手番で使った時間は返す', v.players[2].main, 600000);
  t.pause(30000);
  eq('一時停止中は減らない', t.view(90000).remain, 592000);
  eq('一時停止中に押すと再開', t.tap(90000), 'resume');
}
{
  const t = new E.ClockTimer({ n: 2, mins: [10, 10] });
  t.setConfig({ mins: [5, 7] });
  eq('スタート前に分を変えたら、すぐ入る', t.view(0).players.slice(0, 2).map((p) => p.main), [300000, 420000]);
  t.tap(0);
  t.setConfig({ mins: [30, 30], n: 3 });
  const v = t.view(1000);
  eq('始まってからの分の変更は入れない（最初から で入る）・人数は次の手番から', [v.remain, v.order], [299000, [1, 2]]);
  t.reset();
  eq('最初からで1番・スタート前・新しい分', [t.view(0).phase, t.view(0).idx, t.view(0).remain], ['idle', 0, 1800000]);
}

/* ================= 乱数 ================= */
section('乱数（crypto.getRandomValues・はみ出しを捨てる）');
{
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 60000; i++) counts[E.rollDie()]++;
  ok('6万回で 1〜6 以外は出ない', counts[0] === 0 && counts.slice(1).reduce((a, b) => a + b, 0) === 60000);
  const worst = Math.max(...counts.slice(1).map((c) => Math.abs(c - 10000) / 10000));
  ok('6万回で各目が 1/6 から ±5% 以内（最大のずれ ' + (worst * 100).toFixed(2) + '%）', worst <= 0.05, counts.slice(1).join(' / '));
  let calls = 0;
  const seq = [0xFFFFFFFF, 0xFFFFFFFC, 7];
  const fake = (arr) => { arr[0] = seq[calls++]; return arr; };
  eq('割り切れない端数（4294967292 以上）は捨てて引き直す', [E.randomInt(6, fake), calls], [1, 3]);
  calls = 0;
  const seq2 = [0xFFFFFFFB];
  eq('端数の手前（4294967291）は使う', E.randomInt(6, (arr) => { arr[0] = seq2[calls++]; return arr; }), 0xFFFFFFFB % 6);
}

/* ================= 並べ方 ================= */
section('並べ方（1〜6個）');
{
  const check = (n, W, H, opt) => {
    const L = E.layoutDice(n, W, H, opt);
    const s = L.size, g = L.gap;
    let inside = true, apart = true;
    L.items.forEach((p, i) => {
      if (p.x - s / 2 < -0.01 || p.y - s / 2 < -0.01 || p.x + s / 2 > W + 0.01 || p.y + s / 2 > H + 0.01) inside = false;
      L.items.forEach((q, j) => { if (j > i && Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)) < s + g - 0.01) apart = false; });
    });
    return { L, inside, apart };
  };
  const xs = (L) => [...new Set(L.items.map((p) => Math.round(p.x)))].sort((a, b) => a - b);
  const ys = (L) => [...new Set(L.items.map((p) => Math.round(p.y)))].sort((a, b) => a - b);
  for (let n = 1; n <= 6; n++) {
    for (const [W, H] of [[358, 600], [800, 280], [340, 340]]) {
      const r = check(n, W, H, { maxSize: 180 });
      ok(n + '個（' + W + '×' + H + '）: ' + n + '個並ぶ・はみ出さない・重ならない・上限180以下', r.L.items.length === n && r.inside && r.apart && r.L.size <= 180, J(r.L));
    }
  }
  let L = E.layoutDice(1, 358, 600, {});
  eq('1個は中央に大きく（上限なしなら幅いっぱい 358/1.2）', [L.items[0].x, L.items[0].y, Math.round(L.size * 100) / 100], [179, 300, 298.33]);
  eq('… 上限があれば上限の大きさ', E.layoutDice(1, 358, 600, { maxSize: 180 }).size, 180);
  L = E.layoutDice(2, 358, 600, { maxSize: 180 });
  eq('2個（縦長）は縦に2つ', [L.shape, xs(L).length, ys(L).length], ['col', 1, 2]);
  L = E.layoutDice(2, 358, 330, { maxSize: 180, only: 'row' });
  eq('2個（サイコロ＋タイマーの画面）は横に2つ', [L.shape, xs(L).length, ys(L).length], ['row', 2, 1]);
  L = E.layoutDice(2, 800, 280, { maxSize: 180 });
  eq('2個（横長）は横に2つ', L.shape, 'row');
  L = E.layoutDice(3, 358, 600, { maxSize: 180 });
  eq('3個（縦長）は三角（上に1つ・下に2つ）', [L.shape, Math.round(L.items[0].x), ys(L).length], ['triangle', 179, 2]);
  eq('3個（横長）は横一列', E.layoutDice(3, 800, 220, { maxSize: 180 }).shape, 'row');
  L = E.layoutDice(4, 358, 600, { maxSize: 180 });
  eq('4個は 2×2', [L.shape, xs(L).length, ys(L).length], ['square', 2, 2]);
  L = E.layoutDice(5, 358, 600, { maxSize: 180 });
  eq('5個は 2・1・2（まん中は中央）', [L.shape, Math.round(L.items[2].x), ys(L).length, xs(L).length], ['five', 179, 3, 3]);
  eq('5個（横長）は横向きの 2・1・2', E.layoutDice(5, 800, 280, { maxSize: 180 }).shape, 'five-wide');
  L = E.layoutDice(6, 358, 600, { maxSize: 180 });
  eq('6個（縦長）は 2×3', [L.shape, xs(L).length, ys(L).length], ['tall', 2, 3]);
  L = E.layoutDice(6, 800, 280, { maxSize: 180 });
  eq('6個（横長）は 3×2', [L.shape, xs(L).length, ys(L).length], ['wide', 3, 2]);
}

/* ================= 時間の書き方 ================= */
section('時間の書き方');
eq('手番: 20秒は「20」・60秒は「1:00」・999秒は「16:39」・0.2秒は「1」', ['turn', 'turn', 'turn', 'turn'].map((s, i) => E.formatTime([20000, 60000, 999000, 200][i], s)), ['20', '1:00', '16:39', '1']);
eq('持ち時間: 10分は「10:00」・42秒は「0:42」・3時間は「3:00:00」', [E.formatTime(600000, 'clock'), E.formatTime(42000, 'clock'), E.formatTime(10800000, 'clock')], ['10:00', '0:42', '3:00:00']);
eq('残りは切り上げで出す（19.2秒は「20」）', E.formatTime(19200, 'turn'), '20');

console.log('\n' + (fails.length ? '通らなかった: ' + fails.length + ' 件 ／ 通った: ' + pass + ' 件' : 'すべて通った: ' + pass + ' 件'));
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
