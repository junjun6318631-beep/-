/*!
 * 캔버스 모드 검증 — 게임 내부에 접근할 수 없는 상황(최신 크롬)을 흉내 낸다.
 *
 * 시뮬레이터 상태를 진짜 게임처럼 캔버스에 그린 다음, 봇에게는 window.Runner 를
 * 주지 않는다. 봇은 캔버스 픽셀만 읽고 합성 키 이벤트로 조작해야 한다.
 * 실행: node --test js/test/
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { SimRunner } = require(path.join(__dirname, '..', 'sim', 'dino-sim.js'));
const api = require(path.join(__dirname, '..', 'dino-bot.js'));

const FRAME_MS = 1000 / 60;
const GAME_W = 600;
const GAME_H = 150;

/** 알파 채널만 쓰는 가짜 캔버스 (게임이 그리는 방식과 같다: 배경은 투명) */
function createFakeCanvas(scale) {
  const width = Math.round(GAME_W * scale);
  const height = Math.round(GAME_H * scale);
  const data = new Uint8ClampedArray(width * height * 4);
  return {
    width,
    height,
    className: 'runner-canvas',
    clear() { data.fill(0); },
    /** 게임 좌표로 사각형을 그린다 */
    fill(gx, gy, gw, gh) {
      const x0 = Math.max(0, Math.round(gx * scale));
      const x1 = Math.min(width, Math.round((gx + gw) * scale));
      const y0 = Math.max(0, Math.round(gy * scale));
      const y1 = Math.min(height, Math.round((gy + gh) * scale));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          data[i] = 83; data[i + 1] = 83; data[i + 2] = 83; data[i + 3] = 255;
        }
      }
    },
    getContext() {
      return {
        getImageData(sx, sy, sw, sh) {
          const out = new Uint8ClampedArray(sw * sh * 4);
          for (let y = 0; y < sh; y++) {
            const from = ((sy + y) * width + sx) * 4;
            out.set(data.subarray(from, from + sw * 4), y * sw * 4);
          }
          return { width: sw, height: sh, data: out };
        }
      };
    }
  };
}

/** 시뮬레이터 + 구름을 캔버스에 그린다 */
function createScreen(sim, scale, opts = {}) {
  const canvas = createFakeCanvas(scale);
  const clouds = (opts.clouds === false) ? [] : [
    { x: 300, y: 40 }, { x: 520, y: 68 }
  ];
  return {
    canvas,
    clouds,
    render() {
      canvas.clear();
      // 지평선 — 게임이 도는지 판단하는 신호라서 거리에 따라 무늬가 흘러야 한다
      canvas.fill(0, 127, GAME_W, 2);
      const offset = Math.round(sim.distanceRan) % 24;
      for (let x = -offset; x < GAME_W; x += 24) canvas.fill(x, 129, 6, 2);
      // 구름 (게임 속도의 0.2배로 흐른다)
      for (const cloud of clouds) {
        cloud.x -= sim.currentSpeed * 0.2;
        if (cloud.x + 46 < 0) { cloud.x = GAME_W + 40; }
        canvas.fill(cloud.x, cloud.y, 46, 14);
      }
      // 공룡
      const t = sim.tRex;
      if (t.ducking) canvas.fill(50, 115, 59, 25);
      else canvas.fill(50, t.yPos, 44, 47);
      // 장애물
      for (const o of sim.horizon.obstacles) {
        canvas.fill(o.xPos, o.yPos, o.width, o.typeConfig.height);
      }
      // 점수판 (스캔 밴드 밖)
      canvas.fill(500, 6, 60, 12);
    }
  };
}

/** window.Runner 없이, 캔버스와 키 이벤트만 있는 브라우저 흉내 */
function installFakeBrowser(sim, canvas) {
  const saved = {
    Runner: globalThis.Runner, Trex: globalThis.Trex,
    document: globalThis.document, KeyboardEvent: globalThis.KeyboardEvent
  };
  delete globalThis.Runner;
  delete globalThis.Trex;
  globalThis.KeyboardEvent = class KeyboardEvent {
    constructor(type) { this.type = type; this.keyCode = 0; }
  };
  const sent = [];
  globalThis.document = {
    querySelector(sel) { return sel.indexOf('canvas') === 0 ? canvas : null; },
    querySelectorAll() { return [canvas]; },
    dispatchEvent(ev) {
      sent.push(ev.type + ':' + ev.keyCode);
      const e = { keyCode: ev.keyCode, type: ev.type, target: {}, preventDefault() {} };
      if (ev.type === 'keydown') sim.onKeyDown(e); else sim.onKeyUp(e);
      return true;
    }
  };
  return {
    sent,
    restore() {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) delete globalThis[key];
        else globalThis[key] = saved[key];
      }
    }
  };
}

/** 캔버스만 보고 플레이시킨다 */
function playOnCanvas({ seed = 1, frames = 3000, scale = 1, speed = 6, clouds = true } = {}) {
  const sim = new SimRunner({ seed, speed });
  sim.playing = true;
  const screen = createScreen(sim, scale, { clouds });
  const browser = installFakeBrowser(sim, screen.canvas);
  const bot = api.createBot({ hud: false });
  const seen = { jumped: false, ducked: false };
  try {
    for (let f = 0; f < frames; f++) {
      screen.render();
      bot.tick(f * FRAME_MS);
      if (sim.tRex.jumping) seen.jumped = true;
      if (sim.tRex.ducking) seen.ducked = true;
      if (!sim.step()) break;
    }
  } finally {
    browser.restore();
  }
  return { sim, bot, seen, sent: browser.sent };
}

test('게임 내부에 접근할 수 없으면 캔버스 모드로 넘어간다', () => {
  const sim = new SimRunner({ seed: 1 });
  sim.playing = true;
  const screen = createScreen(sim, 1);
  screen.render();
  const browser = installFakeBrowser(sim, screen.canvas);
  try {
    const bot = api.createBot({ hud: false });
    bot.tick(0);
    assert.strictEqual(bot.mode, 'canvas');
    assert.ok(bot.reader, '캔버스 리더가 준비돼야 한다');
    assert.strictEqual(bot.reader.scale, 1);
    assert.strictEqual(bot.reader.widthUnits, 600);
  } finally {
    browser.restore();
  }
});

test('캔버스에서 장애물 위치를 게임 좌표로 읽는다', () => {
  for (const scale of [1, 2, 3]) {
    const sim = new SimRunner({ seed: 1, autoSpawn: false });
    sim.playing = true;
    sim.runningTime = 1e9;
    sim.spawn('CACTUS_LARGE', { size: 1, xPos: 300 });
    const screen = createScreen(sim, scale, { clouds: false });
    screen.render();
    const reader = api.createReader(screen.canvas);
    const scan = api.scanCanvas(reader);
    assert.strictEqual(scan.blobs.length, 1, `배율 ${scale}: 장애물 하나만 보여야 한다`);
    const blob = scan.blobs[0];
    assert.ok(Math.abs(blob.x - 300) <= 2, `배율 ${scale}: x=${blob.x}`);
    assert.ok(Math.abs(blob.w - 25) <= 3, `배율 ${scale}: w=${blob.w}`);
    assert.ok(Math.abs(blob.top - 90) <= 2, `배율 ${scale}: top=${blob.top}`);
    assert.ok(blob.bottom >= 124, `배율 ${scale}: 땅까지 이어져야 한다 (${blob.bottom})`);
    assert.ok(Math.abs(scan.dinoTop - 93) <= 2, `배율 ${scale}: 공룡 위치 ${scan.dinoTop}`);
    assert.strictEqual(scan.dinoOnGround, true);
  }
});

test('공룡이 점프하면 화면에서 공중으로 읽힌다', () => {
  const sim = new SimRunner({ seed: 1, autoSpawn: false });
  sim.playing = true;
  sim.tRex.yPos = 40;
  const screen = createScreen(sim, 2, { clouds: false });
  screen.render();
  const scan = api.scanCanvas(api.createReader(screen.canvas));
  assert.ok(Math.abs(scan.dinoTop - 40) <= 2, `공룡 높이 ${scan.dinoTop}`);
  assert.strictEqual(scan.dinoOnGround, false);
});

test('구름은 장애물로 세지 않는다 (속도가 다르다)', () => {
  const sim = new SimRunner({ seed: 1, autoSpawn: false, speed: 9 });
  sim.playing = true;
  sim.runningTime = 1e9;
  const screen = createScreen(sim, 1);        // 구름만 있고 장애물은 없다
  const tracker = api.createTracker();
  let obstacles = [];
  for (let f = 0; f < 30; f++) {
    screen.render();
    const scan = api.scanCanvas(api.createReader(screen.canvas));
    const speed = api.trackBlobs(tracker, scan.blobs, f * FRAME_MS, 112, 598);
    obstacles = api.toObstacles(scan.blobs, speed);
    sim.step();
  }
  assert.deepStrictEqual(obstacles, [], '구름만 있을 때는 장애물이 없어야 한다');
});

test('구름이 떠 있어도 선인장은 놓치지 않는다', () => {
  const sim = new SimRunner({ seed: 1, autoSpawn: false, speed: 9 });
  sim.playing = true;
  sim.runningTime = 1e9;
  sim.spawn('CACTUS_SMALL', { size: 2, xPos: 560 });
  const screen = createScreen(sim, 1);
  const tracker = api.createTracker();
  let found = null;
  for (let f = 0; f < 25; f++) {
    screen.render();
    const scan = api.scanCanvas(api.createReader(screen.canvas));
    const speed = api.trackBlobs(tracker, scan.blobs, f * FRAME_MS, 112, 598);
    const obstacles = api.toObstacles(scan.blobs, speed);
    if (obstacles.length) found = obstacles[0];
    sim.step();
  }
  assert.ok(found, '선인장을 찾아야 한다');
  assert.ok(found.y >= 100 && found.y <= 110, `선인장 높이 ${found.y}`);
  assert.ok(found.h >= 30, '땅까지 이어진 것으로 봐야 한다');
});

test('추적으로 게임 속도를 알아낸다', () => {
  const sim = new SimRunner({ seed: 2, speed: 10 });
  sim.playing = true;
  sim.runningTime = 1e9;
  const screen = createScreen(sim, 1);
  const tracker = api.createTracker();
  for (let f = 0; f < 120; f++) {
    screen.render();
    const scan = api.scanCanvas(api.createReader(screen.canvas));
    api.trackBlobs(tracker, scan.blobs, f * FRAME_MS, 112, 598);
    if (!sim.step()) break;
  }
  assert.ok(Math.abs(tracker.speed - sim.currentSpeed) < 1.2,
    `측정 ${tracker.speed.toFixed(2)} vs 실제 ${sim.currentSpeed.toFixed(2)}`);
});

test('화면만 보고 3,000프레임(약 50초)을 달린다', () => {
  for (const seed of [1, 2, 3]) {
    const r = playOnCanvas({ seed, frames: 3000, scale: 1 });
    assert.strictEqual(r.sim.crashed, false,
      `시드 ${seed}: ${r.sim.frames}프레임에서 충돌 (점수 ${r.sim.getScore()})`);
    assert.ok(r.seen.jumped, '장애물을 만나면 뛰어야 한다');
    assert.ok(r.sent.length > 0, '합성 키 이벤트를 보내야 한다');
  }
});

test('고해상도 화면(배율 2)에서도 화면만 보고 달린다', () => {
  const r = playOnCanvas({ seed: 4, frames: 2000, scale: 2 });
  assert.strictEqual(r.sim.crashed, false, `${r.sim.frames}프레임에서 충돌`);
});

test('빠른 속도에서도 화면만 보고 달린다', () => {
  const r = playOnCanvas({ seed: 5, frames: 2000, scale: 1, speed: 12 });
  assert.strictEqual(r.sim.crashed, false, `${r.sim.frames}프레임에서 충돌`);
});
