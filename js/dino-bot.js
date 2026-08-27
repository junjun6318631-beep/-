/*!
 * dino-bot.js — 크롬 공룡(다이노) 게임 자동 플레이 봇
 *
 * 사용법: chrome://dino (또는 오프라인 페이지)에서 F12 → Console →
 *         (필요하면 `allow pasting` 입력 후) 이 파일 내용을 통째로 붙여넣기.
 *
 * 동작 원리
 *   게임 내부 객체 Runner.instance_ 에서 속도/공룡/장애물 상태를 직접 읽고,
 *   "지금 점프하면 넘는가 / 한 프레임 더 기다려도 넘는가" 를 실제 게임 물리로
 *   예측해서 넘을 수 있는 가장 늦은 순간에 점프한다. 새(익룡)는 높이에 따라
 *   무시 / 숙이기 / 점프를 자동으로 고른다. 손으로 맞춘 임계값이 없으므로
 *   게임이 빨라져도 그대로 통한다.
 */
'use strict';
(function () {
  var G = typeof globalThis !== 'undefined' ? globalThis : this;

  var FPS = 60;
  var DELTA = 1000 / FPS;
  var KEY = { JUMP: 38, DUCK: 40 };

  // 게임에서 값을 못 읽을 때만 쓰는 원본 상수 사본 (t-rex-runner 기준)
  var FALLBACK = {
    trex: {
      GRAVITY: 0.6, INITIAL_JUMP_VELOCITY: -10, DROP_VELOCITY: -5,
      SPEED_DROP_COEFFICIENT: 3, MAX_JUMP_HEIGHT: 30, MIN_JUMP_HEIGHT: 30,
      HEIGHT: 47, WIDTH: 44
    },
    groundYPos: 93,
    boxes: {
      running: [
        { x: 22, y: 0, w: 17, h: 16 }, { x: 1, y: 18, w: 30, h: 9 },
        { x: 10, y: 35, w: 14, h: 8 }, { x: 1, y: 24, w: 29, h: 5 },
        { x: 5, y: 30, w: 21, h: 4 }, { x: 9, y: 34, w: 15, h: 4 }
      ],
      ducking: [{ x: 1, y: 18, w: 55, h: 25 }]
    }
  };

  var DEFAULT_CFG = {
    // 가로 안전 마진(px). 프레임 시간이 흔들리면 장애물 위치 예측이 어긋나므로
    // 그만큼 장애물을 넓게 본다. 죽으면 늘고, 잘 달리면 줄어든다.
    margin: 6,
    marginMin: 2,
    marginMax: 24,
    marginFrames: 1,       // 속도 × 이 값(프레임)만큼 가로 마진을 더한다 (한 프레임 밀림 대비)
    lagFrames: 1,          // 실제 측정된 틱 간격(프레임). 랙이 생기면 자동으로 커진다.
    maxLagFrames: 6,
    marginY: 2,            // 세로 마진은 작게 고정 (새 밑으로 숙여 지나가는 판단을 막지 않도록)
    marginOnCrash: 2,      // 충돌 시 증가폭
    marginOnGoodRun: 1,    // 무사고 주행 후 감소폭
    goodRunScore: 500,     // 이 점수를 넘겨야 "잘 달렸다"로 본다
    reactionFrames: 4,     // 이만큼 더 기다려도 넘을 수 있으면 아직 기다린다(프레임 여유)
    horizonFrames: 150,    // 예측 최대 프레임 수
    autoRestart: true,
    restartDelayMs: 700,
    speedDrop: true,       // 장애물을 넘은 뒤 빠르게 착지해 다음 장애물에 대비
    hud: true,
    storageKey: 'dinoBot.state.v1',
    log: false
  };

  // ---------------------------------------------------------------- 기하 계산

  function overlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function inflate(box, mx, my) {
    return { x: box.x - mx, y: box.y - my, w: box.w + 2 * mx, h: box.h + 2 * my };
  }

  // 게임의 checkForCollision() 과 같은 방식: 바깥 박스로 1차 판정 후
  // 스프라이트별 세부 충돌 박스로 2차 판정. 장애물 쪽만 마진만큼 부풀린다.
  function hits(dino, obstacle, snap, mx, my) {
    var dinoBox = {
      x: snap.dino.x + 1, y: dino.y + 1,
      w: snap.dino.w - 2, h: snap.dino.h - 2
    };
    var obsBox = {
      x: obstacle.x + 1, y: obstacle.y + 1,
      w: obstacle.w - 2, h: obstacle.h - 2
    };
    if (!overlap(dinoBox, inflate(obsBox, mx, my))) return false;

    var dinoParts = dino.ducking ? snap.boxes.ducking : snap.boxes.running;
    for (var i = 0; i < dinoParts.length; i++) {
      var dp = dinoParts[i];
      var d = { x: dinoBox.x + dp.x, y: dinoBox.y + dp.y, w: dp.w, h: dp.h };
      for (var j = 0; j < obstacle.boxes.length; j++) {
        var op = obstacle.boxes[j];
        var o = inflate({ x: obsBox.x + op.x, y: obsBox.y + op.y, w: op.w, h: op.h }, mx, my);
        if (overlap(d, o)) return true;
      }
    }
    return false;
  }

  /**
   * 땅에 있는 공룡(서 있거나 숙인 상태)이 이 장애물 아래/위로 그냥 지나갈 수 있는가.
   * 세로 겹침만 보면 되므로 x 위치와 무관하게 판정된다.
   */
  function passableOnGround(snap, obstacle, ducking, my) {
    var parts = ducking ? snap.boxes.ducking : snap.boxes.running;
    var dinoTop = snap.k.groundY + 1;
    var obsTop = obstacle.y + 1;
    for (var i = 0; i < parts.length; i++) {
      var dTop = dinoTop + parts[i].y;
      var dBottom = dTop + parts[i].h;
      for (var j = 0; j < obstacle.boxes.length; j++) {
        var oTop = obsTop + obstacle.boxes[j].y - my;
        var oBottom = oTop + obstacle.boxes[j].h + 2 * my;
        if (dTop < oBottom && dBottom > oTop) return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- 물리 예측

  function startJump(dino, k, speed) {
    dino.jumping = true;
    dino.vel = k.jumpVelocity - speed / 10;
    dino.reachedMinHeight = false;
    dino.speedDrop = false;
    dino.ducking = false;
  }

  // Trex.updateJump() 를 프레임 단위(framesElapsed = 1)로 그대로 옮긴 것
  function stepDino(dino, k) {
    if (!dino.jumping) return;
    dino.y += Math.round(dino.speedDrop ? dino.vel * k.speedDropCoefficient : dino.vel);
    dino.vel += k.gravity;
    if (dino.y < k.minJumpHeight || dino.speedDrop) dino.reachedMinHeight = true;
    if (dino.y < k.maxJumpHeight || dino.speedDrop) {
      if (dino.reachedMinHeight && dino.vel < k.dropVelocity) dino.vel = k.dropVelocity;
    }
    if (dino.y > k.groundY) {
      dino.y = k.groundY;
      dino.jumping = false;
      dino.speedDrop = false;
      dino.vel = 0;
    }
  }

  function obstacleStep(speed, offset) {
    return Math.floor(((speed + offset) * FPS / 1000) * DELTA);
  }

  var OUTCOME = { CLEAR: 'clear', CRASH: 'crash', EARLY: 'early' };

  /** 아직 지나가지 않은(=신경 써야 할) 가장 가까운 장애물의 인덱스 */
  function nearestIndex(snap) {
    for (var i = 0; i < snap.obstacles.length; i++) {
      if (snap.obstacles[i].x + snap.obstacles[i].w > snap.dino.x) return i;
    }
    return -1;
  }

  /**
   * plan 대로 조작했을 때 어떻게 되는지 게임 물리로 예측한다.
   *   clear — 목표 장애물을 무사히 넘긴다
   *   crash — 부딪힌다
   *   early — 목표 장애물이 도착하기 전에 착지한다 (= 아직 점프할 때가 아니다)
   *   plan = { jumpAt: 프레임|null, duck: bool, dropAt: 프레임|null }
   */
  function simulate(snap, plan, cfg) {
    var k = snap.k;
    var dino = {
      y: snap.dino.y,
      vel: snap.dino.vel || 0,
      jumping: !!snap.dino.jumping,
      speedDrop: !!snap.dino.speedDrop,
      reachedMinHeight: !!snap.dino.reachedMinHeight,
      ducking: !!plan.duck && !snap.dino.jumping
    };
    var ti = nearestIndex(snap);
    if (ti < 0) return { outcome: OUTCOME.CLEAR, frames: 0 };

    var obs = [];
    for (var i = 0; i < snap.obstacles.length; i++) {
      var o = snap.obstacles[i];
      obs.push({ x: o.x, y: o.y, w: o.w, h: o.h, boxes: o.boxes, speedOffset: o.speedOffset });
    }
    var target = obs[ti];
    var speed = snap.speed;
    // 프레임이 한 번 밀리면 장애물은 speed 만큼 더 다가온다 → 속도에 비례해 마진을 준다.
    var mx = cfg.margin + snap.speed * Math.max(cfg.marginFrames || 0, cfg.lagFrames || 0);
    var jumpStarted = dino.jumping;
    var dinoRight = snap.dino.x + snap.dino.w;

    // 점프(와 공중에 떠 있는 상태)는 약 35프레임을 묶어두는 결정이다.
    // 그래서 목표를 처리한 뒤 "그 다음"까지 감당되는지 한 단계 더 확인한다.
    // 지상에서의 달리기/숙이기는 매 프레임 바꿀 수 있으므로 확인하지 않는다.
    var verify = cfg.lookahead !== false &&
      (plan.jumpAt !== null || plan.dropAt !== null || snap.dino.jumping);
    var phase = 0;
    var wasEarly = false;
    var autoJump = false;
    var autoDuck = false;

    for (var f = 0; f < cfg.horizonFrames; f++) {
      if (plan.jumpAt === f && !dino.jumping && !dino.ducking) {
        startJump(dino, k, speed);
        jumpStarted = true;
      }
      if (autoJump && !dino.jumping && !dino.ducking) {
        startJump(dino, k, speed);          // 착지하자마자 대응
        jumpStarted = true;
        autoJump = false;
      }
      if (autoDuck && !dino.jumping) dino.ducking = true;
      // Trex.setSpeedDrop(): 아래키를 누르면 속도를 1로 두고 3배로 낙하한다.
      if (plan.dropAt === f && dino.jumping) { dino.speedDrop = true; dino.vel = 1; }

      stepDino(dino, k);
      for (var m = 0; m < obs.length; m++) obs[m].x -= obstacleStep(speed, obs[m].speedOffset);
      if (speed < snap.maxSpeed) speed += snap.acceleration;

      for (var c = 0; c < obs.length; c++) {
        if (obs[c].x + obs[c].w < snap.dino.x - 20) continue;   // 이미 지나갔다
        if (obs[c].x > dinoRight + 40) break;                    // 아직 멀다
        if (hits(dino, obs[c], snap, mx, cfg.marginY)) {
          return { outcome: OUTCOME.CRASH, frames: f };
        }
      }

      var passed = target.x + target.w < snap.dino.x;
      // 목표가 도착하기 전에 착지했다 = 이 점프로는 목표를 처리하지 못한다.
      var landedEarly = jumpStarted && !dino.jumping && target.x > dinoRight;
      if (!passed && !landedEarly) continue;

      if (phase === 1) {
        // 확인 단계에서 일찍 착지했다는 건 여유가 있다는 뜻이다.
        return { outcome: wasEarly ? OUTCOME.EARLY : OUTCOME.CLEAR, frames: f };
      }
      if (!verify) {
        return {
          outcome: (landedEarly && !passed) ? OUTCOME.EARLY : OUTCOME.CLEAR,
          frames: f
        };
      }

      // 확인 단계로 넘어간다.
      if (passed) {
        var next = null;
        for (var n = 0; n < obs.length; n++) {
          if (obs[n] !== target && obs[n].x + obs[n].w > snap.dino.x) { next = obs[n]; break; }
        }
        if (!next) return { outcome: OUTCOME.CLEAR, frames: f };
        target = next;                 // 다음 장애물을 감당할 수 있는가
      } else {
        wasEarly = true;               // 같은 장애물을 다시 상대해야 한다
      }
      phase = 1;
      jumpStarted = false;
      dino.ducking = false;
      autoJump = false;
      autoDuck = false;
      if (passableOnGround(snap, target, false, cfg.marginY)) {
        // 그냥 달려서 지나갈 수 있다 (높이 나는 새) — 착지가 늦으면 그대로 충돌로 잡힌다.
      } else if (passableOnGround(snap, target, true, cfg.marginY)) {
        autoDuck = true;
        if (!dino.jumping) dino.ducking = true;
      } else {
        autoJump = true;               // 착지 즉시 다시 뛰어야 넘을 수 있다
      }
    }
    return { outcome: wasEarly ? OUTCOME.EARLY : OUTCOME.CLEAR, frames: cfg.horizonFrames };
  }

  // ---------------------------------------------------------------- 판단

  function decide(snap, cfg) {
    if (nearestIndex(snap) < 0) return { action: 'run' };

    // 이미 공중이면 할 수 있는 건 빠른 착지뿐이다.
    if (snap.dino.jumping) {
      // 빠른 착지는 아래키를 누르고 있는 동안만 유지된다.
      if (snap.dino.speedDrop) return { action: 'drop' };
      if (!cfg.speedDrop) return { action: 'air' };
      var stay = simulate(snap, { jumpAt: null, duck: false, dropAt: null }, cfg);
      if (stay.outcome !== OUTCOME.CRASH) return { action: 'air' };
      // 이대로면 부딪힌다 — 빨리 내려앉아 다음 대응을 앞당긴다.
      var drop = simulate(snap, { jumpAt: null, duck: false, dropAt: 0 }, cfg);
      return drop.outcome === OUTCOME.CRASH ? { action: 'air' } : { action: 'drop' };
    }

    // 1) 그냥 달려서 지나갈 수 있으면 아무것도 하지 않는다 (높이 나는 새).
    var run = simulate(snap, { jumpAt: null, duck: false, dropAt: null }, cfg);
    if (run.outcome === OUTCOME.CLEAR) return { action: 'run' };

    // 2) 숙여서 지나갈 수 있으면 숙인다 (가운데 높이의 새).
    var duck = simulate(snap, { jumpAt: null, duck: true, dropAt: null }, cfg);
    if (duck.outcome === OUTCOME.CLEAR) return { action: 'duck' };

    // 3) 점프해야 한다. reactionFrames 만큼 더 기다려도 넘을 수 있으면 아직 기다린다.
    var later = simulate(snap, { jumpAt: cfg.reactionFrames + 1, duck: false, dropAt: null }, cfg);
    if (later.outcome === OUTCOME.CLEAR) return { action: 'wait' };

    var now = simulate(snap, { jumpAt: 0, duck: false, dropAt: null }, cfg);
    if (now.outcome === OUTCOME.CLEAR) return { action: 'jump' };
    if (now.outcome === OUTCOME.EARLY) return { action: 'wait' };

    // 지금 뛰면 착지 지점이 장애물과 겹친다. 아직 충돌까지 여유가 있으면
    // 성급하게 뛰지 말고 다음 프레임에 다시 판단한다.
    if (run.frames > cfg.reactionFrames + 2) return { action: 'wait' };

    // 정말 늦었다. 그래도 뛰는 편이 서 있는 것보다 낫다.
    return { action: 'jump', desperate: true };
  }

  // ---------------------------------------------------------------- 게임 읽기

  function snapshot(runner) {
    var t = runner.tRex;
    var tc = t.config || FALLBACK.trex;
    var TrexCls = (G.Runner && G.Runner.instance_ === runner && G.Trex) || null;
    var boxes = FALLBACK.boxes;
    if (TrexCls && TrexCls.collisionBoxes) {
      boxes = {
        running: TrexCls.collisionBoxes.RUNNING.map(toBox),
        ducking: TrexCls.collisionBoxes.DUCKING.map(toBox)
      };
    }
    var list = (runner.horizon && runner.horizon.obstacles) || [];
    var obstacles = [];
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      obstacles.push({
        x: o.xPos,
        y: o.yPos,
        w: o.width,
        h: o.typeConfig.height,
        type: o.typeConfig.type,
        speedOffset: o.speedOffset || 0,
        boxes: (o.collisionBoxes || []).map(toBox)
      });
    }
    var rc = runner.config || {};
    return {
      speed: runner.currentSpeed,
      acceleration: rc.ACCELERATION != null ? rc.ACCELERATION : 0.001,
      maxSpeed: rc.MAX_SPEED != null ? rc.MAX_SPEED : 13,
      dino: {
        x: t.xPos, y: t.yPos, w: tc.WIDTH, h: tc.HEIGHT,
        jumping: t.jumping, ducking: t.ducking,
        vel: t.jumpVelocity, speedDrop: t.speedDrop,
        reachedMinHeight: t.reachedMinHeight
      },
      k: {
        gravity: tc.GRAVITY,
        jumpVelocity: tc.INITIAL_JUMP_VELOCITY,
        dropVelocity: tc.DROP_VELOCITY,
        speedDropCoefficient: tc.SPEED_DROP_COEFFICIENT,
        maxJumpHeight: tc.MAX_JUMP_HEIGHT,
        minJumpHeight: t.minJumpHeight != null ? t.minJumpHeight : FALLBACK.groundYPos - tc.MIN_JUMP_HEIGHT,
        groundY: t.groundYPos != null ? t.groundYPos : FALLBACK.groundYPos
      },
      boxes: boxes,
      obstacles: obstacles
    };
  }

  function toBox(b) {
    return { x: b.x, y: b.y, w: b.width != null ? b.width : b.w, h: b.height != null ? b.height : b.h };
  }

  // ---------------------------------------------------------------- 봇 본체

  function press(runner, code) {
    runner.onKeyDown({ keyCode: code, type: 'keydown', target: {}, preventDefault: noop });
  }
  function release(runner, code) {
    runner.onKeyUp({ keyCode: code, type: 'keyup', target: {}, preventDefault: noop });
  }
  function noop() {}

  function timeNow() {
    return (G.performance && G.performance.now) ? G.performance.now() : Date.now();
  }

  function scoreOf(runner) {
    var coefficient = 0.025;
    if (runner.distanceMeter && runner.distanceMeter.config) {
      coefficient = runner.distanceMeter.config.COEFFICIENT;
    }
    return Math.round((runner.distanceRan || 0) * coefficient);
  }

  function createBot(userCfg) {
    var cfg = {};
    for (var key in DEFAULT_CFG) cfg[key] = DEFAULT_CFG[key];
    for (var k2 in (userCfg || {})) cfg[k2] = userCfg[k2];

    var bot = {
      cfg: cfg,
      running: false,
      stats: { runs: 0, best: 0, last: 0, deaths: 0, action: '-', speed: 0 },
      _raf: null,
      _crashedAt: 0,
      _downHeld: false,
      _lastTick: 0
    };

    loadState(bot);

    bot.getRunner = function () {
      return (G.Runner && G.Runner.instance_) || null;
    };

    bot.tick = function (nowMs) {
      var runner = bot.getRunner();
      if (!runner) return;

      // 실제 틱 간격을 재서 마진에 반영한다. 화면이 버벅이면 그만큼 보수적으로 판단한다.
      if (nowMs === undefined) nowMs = timeNow();
      if (bot._lastTick) {
        var gap = (nowMs - bot._lastTick) / (1000 / 60);
        if (gap > 0 && gap < 60) {
          cfg.lagFrames = gap > cfg.lagFrames ? gap : cfg.lagFrames * 0.9 + gap * 0.1;
          cfg.lagFrames = Math.max(1, Math.min(cfg.maxLagFrames, cfg.lagFrames));
        }
      }
      bot._lastTick = nowMs;

      if (runner.crashed) {
        onCrash(bot, runner, nowMs);
        return;
      }
      if (!runner.playing) {           // 아직 시작 전이면 점프로 시작
        press(runner, KEY.JUMP);
        return;
      }
      bot._crashedAt = 0;

      var snap = snapshot(runner);
      var d = decide(snap, cfg);
      bot.stats.action = d.action;
      bot.stats.speed = snap.speed;
      bot.stats.last = scoreOf(runner);

      // 아래키는 "누른 채로 유지"해야 한다. 떼는 순간 숙이기도 빠른 착지도 풀린다.
      var wantDown = d.action === 'duck' || d.action === 'drop';
      if (!wantDown && bot._downHeld) {
        release(runner, KEY.DUCK);
        bot._downHeld = false;
      } else if (wantDown && !bot._downHeld) {
        press(runner, KEY.DUCK);   // 지상에서는 숙이기, 공중에서는 빠른 착지
        bot._downHeld = true;
      } else if (wantDown && d.action === 'duck' &&
                 !runner.tRex.ducking && !runner.tRex.jumping) {
        // 착지하면서 게임이 숙이기를 풀었으면 다시 눌러 준다.
        release(runner, KEY.DUCK);
        press(runner, KEY.DUCK);
      }
      if (d.action === 'jump') press(runner, KEY.JUMP);
      if (cfg.log && d.desperate) {
        console.warn('[dino-bot] 안전한 선택지 없음 →', d.action, 'margin=', cfg.margin);
      }
    };

    bot.start = function () {
      if (bot.running) return bot;
      bot.running = true;
      var loop = function (ts) {
        if (!bot.running) return;
        try { bot.tick(ts); } catch (err) { console.error('[dino-bot]', err); }
        drawHud(bot);
        bot._raf = G.requestAnimationFrame(loop);
      };
      loop();
      console.log('%c[dino-bot] 자동 플레이 시작 — 멈추려면 DinoBot.stop()',
        'color:#0a0;font-weight:bold');
      return bot;
    };

    bot.stop = function () {
      bot.running = false;
      if (bot._raf && G.cancelAnimationFrame) G.cancelAnimationFrame(bot._raf);
      var runner = bot.getRunner();
      if (runner && bot._downHeld) { release(runner, KEY.DUCK); bot._downHeld = false; }
      removeHud();
      console.log('[dino-bot] 정지');
      return bot;
    };

    return bot;
  }

  function onCrash(bot, runner, now) {
    var cfg = bot.cfg;
    if (now === undefined) now = timeNow();
    if (!bot._crashedAt) {
      bot._crashedAt = now;
      bot.stats.deaths++;
      bot.stats.runs++;
      var score = scoreOf(runner);
      bot.stats.last = score;
      if (score > bot.stats.best) bot.stats.best = score;
      // 자동 보정: 죽으면 안전 마진을 넓히고, 충분히 잘 달렸으면 다시 좁힌다.
      if (score >= cfg.goodRunScore) {
        cfg.margin = Math.max(cfg.marginMin, cfg.margin - cfg.marginOnGoodRun);
      } else {
        cfg.margin = Math.min(cfg.marginMax, cfg.margin + cfg.marginOnCrash);
      }
      saveState(bot);
      if (cfg.log) console.log('[dino-bot] 충돌 · 점수', score, '· 새 마진', cfg.margin);
    }
    if (cfg.autoRestart && now - bot._crashedAt > cfg.restartDelayMs) {
      bot._crashedAt = 0;
      bot._downHeld = false;
      runner.restart();
    }
  }

  // ---------------------------------------------------------------- 저장 / HUD

  function loadState(bot) {
    try {
      var raw = G.localStorage && G.localStorage.getItem(bot.cfg.storageKey);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (typeof s.margin === 'number') bot.cfg.margin = s.margin;
      if (typeof s.best === 'number') bot.stats.best = s.best;
    } catch (e) { /* 저장소를 못 쓰는 환경이면 그냥 기본값으로 */ }
  }

  function saveState(bot) {
    try {
      G.localStorage && G.localStorage.setItem(bot.cfg.storageKey,
        JSON.stringify({ margin: bot.cfg.margin, best: bot.stats.best }));
    } catch (e) { /* 무시 */ }
  }

  var hudEl = null;
  function drawHud(bot) {
    if (!bot.cfg.hud || typeof document === 'undefined') return;
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.id = 'dino-bot-hud';
      hudEl.style.cssText = [
        'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
        'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
        'background:rgba(0,0,0,.78)', 'color:#eaeaea', 'padding:8px 10px',
        'border-radius:8px', 'pointer-events:none', 'white-space:pre'
      ].join(';');
      document.body.appendChild(hudEl);
    }
    var s = bot.stats;
    hudEl.textContent = [
      'DINO BOT  ' + (bot.running ? '● 작동중' : '○ 정지'),
      '점수   ' + s.last,
      '최고   ' + s.best,
      '속도   ' + s.speed.toFixed(2),
      '판단   ' + s.action,
      '마진   ' + bot.cfg.margin + 'px',
      '죽음   ' + s.deaths + '회'
    ].join('\n');
  }

  function removeHud() {
    if (hudEl && hudEl.parentNode) hudEl.parentNode.removeChild(hudEl);
    hudEl = null;
  }

  // ---------------------------------------------------------------- 진입점

  var api = {
    createBot: createBot,
    decide: decide,
    simulate: simulate,
    nearestIndex: nearestIndex,
    OUTCOME: OUTCOME,
    snapshot: snapshot,
    DEFAULT_CFG: DEFAULT_CFG,
    KEY: KEY
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;            // node 테스트용
  } else {
    if (G.DinoBot && G.DinoBot.stop) G.DinoBot.stop();
    G.DinoBot = createBot();
    G.DinoBot.api = api;
    G.DinoBot.start();
  }
})();
