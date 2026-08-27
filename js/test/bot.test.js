/*!
 * 봇 검증 — 크롬 원본 물리를 그대로 옮긴 시뮬레이터에 봇을 붙여 돌린다.
 * 실행: node --test js/test/
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { SimRunner, makeRandom } = require(path.join(__dirname, '..', 'sim', 'dino-sim.js'));
const api = require(path.join(__dirname, '..', 'dino-bot.js'));

const FRAME_MS = 1000 / 60;

/** 봇을 붙여 게임을 돌린다. 죽으면 즉시 멈춘다. */
function play(options) {
  const opts = Object.assign({ seed: 1, frames: 20000, jitter: null, lag: 0 }, options);
  const sim = new SimRunner(opts).install(globalThis);
  const bot = api.createBot(Object.assign({ hud: false, autoRestart: false }, opts.botCfg));
  const rnd = makeRandom(opts.seed * 977 + 13);
  const seen = { jumped: false, ducked: false, ticks: 0 };
  let clock = 0;
  if (opts.setup) opts.setup(sim);

  for (let f = 0; f < opts.frames; f++) {
    if (!opts.lag || rnd() > opts.lag) { bot.tick(clock); seen.ticks++; }
    if (sim.tRex.jumping) seen.jumped = true;
    if (sim.tRex.ducking) seen.ducked = true;
    const dt = opts.jitter ? opts.jitter[0] + rnd() * (opts.jitter[1] - opts.jitter[0]) : FRAME_MS;
    clock += dt;
    if (!sim.step(dt)) break;
    if (opts.until && opts.until(sim)) break;
  }
  return { sim, bot, seen, crashed: sim.crashed, frames: sim.frames, score: sim.getScore() };
}

/** 장애물 하나만 놓고 지나갈 때까지 돌린다. */
function single(typeName, spawnOpts, speed) {
  return play({
    seed: 3,
    speed: speed,
    autoSpawn: false,
    frames: 400,
    setup: (sim) => {
      sim.playing = true;
      sim.runningTime = 1e9;                 // 장애물 판정 활성화
      sim.spawn(typeName, spawnOpts);
    },
    until: (sim) => sim.horizon.obstacles.length === 0
  });
}

test('기본 속도에서 20,000프레임(약 5분)을 죽지 않고 달린다', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = play({ seed, frames: 20000 });
    assert.strictEqual(r.crashed, false, `시드 ${seed}: ${r.frames}프레임에서 충돌 (점수 ${r.score})`);
    assert.strictEqual(r.frames, 20000);
  }
});

test('최고 속도(13)에 도달한 뒤에도 계속 살아남는다', () => {
  for (const seed of [1, 2, 3]) {
    const r = play({ seed, frames: 30000 });
    assert.strictEqual(r.crashed, false, `시드 ${seed}: ${r.frames}프레임에서 충돌`);
    assert.ok(r.sim.currentSpeed >= 13, '최고 속도에 도달해야 한다');
  }
});

test('처음부터 최고 속도로 시작해도 살아남는다', () => {
  for (const seed of [1, 2, 3]) {
    const r = play({ seed, speed: 13, frames: 20000 });
    assert.strictEqual(r.crashed, false, `시드 ${seed}: ${r.frames}프레임에서 충돌`);
  }
});

test('선인장은 크기·속도와 상관없이 넘는다', () => {
  for (const speed of [6, 9, 13]) {
    for (const size of [1, 2, 3]) {
      for (const type of ['CACTUS_SMALL', 'CACTUS_LARGE']) {
        const r = single(type, { size, xPos: 600 }, speed);
        assert.strictEqual(r.crashed, false, `${type} size${size} @speed${speed} 충돌`);
        assert.ok(r.seen.jumped, `${type} size${size} @speed${speed} 점프하지 않았다`);
      }
    }
  }
});

test('낮게 나는 새(yPos 100)는 뛰어넘는다', () => {
  for (const speed of [9, 13]) {
    const r = single('PTERODACTYL', { yPos: 100, xPos: 600, speedOffset: 0 }, speed);
    assert.strictEqual(r.crashed, false, `speed ${speed} 충돌`);
    assert.ok(r.seen.jumped, '점프해야 한다');
  }
});

test('가운데 높이의 새(yPos 75)는 숙여서 지나간다', () => {
  for (const speed of [9, 13]) {
    const r = single('PTERODACTYL', { yPos: 75, xPos: 600, speedOffset: 0 }, speed);
    assert.strictEqual(r.crashed, false, `speed ${speed} 충돌`);
    assert.ok(r.seen.ducked, '숙여야 한다');
    assert.ok(!r.seen.jumped, '점프하면 안 된다');
  }
});

test('높이 나는 새(yPos 50)는 그냥 달려서 지나간다', () => {
  for (const speed of [9, 13]) {
    const r = single('PTERODACTYL', { yPos: 50, xPos: 600, speedOffset: 0 }, speed);
    assert.strictEqual(r.crashed, false, `speed ${speed} 충돌`);
    assert.ok(!r.seen.jumped, '점프하면 안 된다');
    assert.ok(!r.seen.ducked, '숙일 필요가 없다');
  }
});

test('붙어 나오는 선인장 두 개도 처리한다', () => {
  for (const gap of [180, 220, 260, 300, 360]) {
    const r = play({
      seed: 3, speed: 11, autoSpawn: false, frames: 500,
      setup: (sim) => {
        sim.playing = true;
        sim.runningTime = 1e9;
        sim.spawn('CACTUS_LARGE', { size: 1, xPos: 600 });
        sim.spawn('CACTUS_LARGE', { size: 1, xPos: 600 + gap });
      },
      until: (sim) => sim.horizon.obstacles.length === 0
    });
    assert.strictEqual(r.crashed, false, `간격 ${gap}px에서 충돌`);
  }
});

test('선인장 뒤에 높이 나는 새가 이어져도 공중에서 부딪히지 않는다', () => {
  for (const gap of [300, 380, 460]) {
    const r = play({
      seed: 3, speed: 13, autoSpawn: false, frames: 500,
      setup: (sim) => {
        sim.playing = true;
        sim.runningTime = 1e9;
        sim.spawn('CACTUS_SMALL', { size: 1, xPos: 600 });
        sim.spawn('PTERODACTYL', { yPos: 50, xPos: 600 + gap, speedOffset: 0 });
      },
      until: (sim) => sim.horizon.obstacles.length === 0
    });
    assert.strictEqual(r.crashed, false, `간격 ${gap}px에서 충돌`);
  }
});

test('프레임 간격이 흔들리고 틱이 밀려도 살아남는다', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = play({ seed, frames: 20000, jitter: [14, 23], lag: 0.04 });
    assert.strictEqual(r.crashed, false, `시드 ${seed}: ${r.frames}프레임에서 충돌 (점수 ${r.score})`);
  }
});

test('멀리 있는 장애물에는 뛰지 않고 기다린다', () => {
  const sim = new SimRunner({ seed: 3, autoSpawn: false }).install(globalThis);
  sim.playing = true;
  sim.runningTime = 1e9;
  sim.spawn('CACTUS_LARGE', { size: 1, xPos: 500 });
  const cfg = api.createBot({ hud: false }).cfg;
  const decision = api.decide(api.snapshot(sim), cfg);
  assert.strictEqual(decision.action, 'wait', '멀리 있으면 기다려야 한다');
});

test('넘을 수 있는 마지막 순간에 점프한다', () => {
  const sim = new SimRunner({ seed: 3, autoSpawn: false }).install(globalThis);
  sim.playing = true;
  sim.runningTime = 1e9;
  sim.spawn('CACTUS_LARGE', { size: 1, xPos: 500 });
  const bot = api.createBot({ hud: false, autoRestart: false });
  let jumpFrame = -1;
  for (let f = 0; f < 200 && jumpFrame < 0; f++) {
    if (api.decide(api.snapshot(sim), bot.cfg).action === 'jump') jumpFrame = f;
    bot.tick(f * FRAME_MS);
    sim.step();
  }
  assert.ok(jumpFrame > 0, '점프 결정이 나와야 한다');
  // 그 시점보다 조금이라도 일찍 뛰면 착지가 빨라 다시 뛰어야 하고,
  // 늦게 뛰면 넘지 못한다 — 점프 직전 프레임에는 아직 '기다림'이어야 한다.
  const snapAt = (frames) => {
    const s = new SimRunner({ seed: 3, autoSpawn: false }).install(globalThis);
    s.playing = true; s.runningTime = 1e9;
    s.spawn('CACTUS_LARGE', { size: 1, xPos: 500 });
    for (let i = 0; i < frames; i++) s.step();
    return api.snapshot(s);
  };
  assert.strictEqual(api.decide(snapAt(jumpFrame - 1), bot.cfg).action, 'wait');
});

test('죽으면 스스로 다시 시작하고 안전 마진을 넓힌다', () => {
  const sim = new SimRunner({ seed: 1 }).install(globalThis);
  const bot = api.createBot({ hud: false, autoRestart: true, restartDelayMs: 500 });
  const before = bot.cfg.margin;
  sim.playing = true;
  sim.gameOver();                       // 강제로 충돌 상태를 만든다
  bot.tick(1000);                       // 충돌 인지 + 마진 조정
  assert.ok(bot.cfg.margin > before, '충돌 후 마진이 넓어져야 한다');
  assert.strictEqual(bot.stats.deaths, 1);
  assert.strictEqual(sim.crashed, true, '지연 시간 전에는 재시작하지 않는다');
  bot.tick(2000);                       // 지연 시간 경과 → 재시작
  assert.strictEqual(sim.crashed, false, '자동으로 다시 시작해야 한다');
  assert.strictEqual(sim.playing, true);
});

test('게임이 시작 전이면 점프로 시작시킨다', () => {
  const sim = new SimRunner({ seed: 1 }).install(globalThis);
  const bot = api.createBot({ hud: false });
  assert.strictEqual(sim.playing, false);
  bot.tick(0);
  assert.strictEqual(sim.playing, true, '봇이 게임을 시작시켜야 한다');
});

test('게임 객체가 없으면 아무 일도 하지 않는다', () => {
  const saved = globalThis.Runner;
  delete globalThis.Runner;
  const bot = api.createBot({ hud: false });
  assert.doesNotThrow(() => bot.tick(0));
  globalThis.Runner = saved;
});

test('북마클릿 파일이 봇 소스와 같은 내용이다', () => {
  const fs = require('node:fs');
  const builder = require(path.join(__dirname, '..', 'build-bookmarklet.js'));
  const current = fs.readFileSync(builder.OUTPUT, 'utf8');
  assert.strictEqual(current, builder.build(),
    'node js/build-bookmarklet.js 로 북마클릿을 다시 만들어야 합니다');
});

test('북마클릿용으로 줄인 코드도 똑같이 플레이한다', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const builder = require(path.join(__dirname, '..', 'build-bookmarklet.js'));
  const minified = builder.minify(fs.readFileSync(builder.SOURCE, 'utf8'));
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dino-')), 'min.js');
  fs.writeFileSync(tmp, minified);
  const minifiedApi = require(tmp);

  const sim = new SimRunner({ seed: 2 }).install(globalThis);
  const bot = minifiedApi.createBot({ hud: false, autoRestart: false });
  for (let f = 0; f < 20000; f++) {
    bot.tick(f * FRAME_MS);
    if (!sim.step()) break;
  }
  assert.strictEqual(sim.crashed, false, `줄인 코드가 ${sim.frames}프레임에서 충돌`);
});

test('크롬 원본의 오타 난 상수 이름(INIITAL_JUMP_VELOCITY)도 그대로 읽는다', () => {
  const sim = new SimRunner({ seed: 1 }).install(globalThis);
  const snap = api.snapshot(sim);
  assert.strictEqual(snap.k.jumpVelocity, -10, '점프 속도를 읽지 못하면 예측이 전부 어긋난다');
  assert.strictEqual(snap.k.gravity, 0.6);
  assert.strictEqual(snap.k.groundY, 93);
  assert.strictEqual(snap.dino.w, 44);

  // 오타가 고쳐진 버전이 나와도 그대로 동작해야 한다.
  const fixed = Object.assign({}, sim.tRex.config);
  fixed.INITIAL_JUMP_VELOCITY = fixed.INIITAL_JUMP_VELOCITY;
  delete fixed.INIITAL_JUMP_VELOCITY;
  sim.tRex.config = fixed;
  assert.strictEqual(api.snapshot(sim).k.jumpVelocity, -10);
});

test('게임에서 상수를 아예 못 읽어도 원본 값으로 판단한다', () => {
  const sim = new SimRunner({ seed: 1 }).install(globalThis);
  sim.tRex.config = {};                     // 구조가 바뀐 버전을 흉내
  const snap = api.snapshot(sim);
  assert.strictEqual(snap.k.jumpVelocity, -10);
  assert.strictEqual(snap.dino.h, 47);
  assert.ok(Number.isFinite(snap.k.minJumpHeight));
});
