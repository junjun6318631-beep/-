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
      HEIGHT: 47, WIDTH: 44, WIDTH_DUCK: 59, START_X_POS: 50
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

  // 캔버스에서 잰 사각형을 원본 충돌 박스에 가깝게 줄일 때 쓰는 여유 (게임 단위)
  var FLY_INSET_TOP = 8;
  var FLY_INSET_BOTTOM = 6;

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

  /**
   * 충돌 판정에 쓸 장애물 사각형.
   * 캔버스에서 잰 장애물은 세부 충돌 박스를 모르고 사각형만 안다. 그런 경우
   * 새는 날개까지 사각형에 들어가 있어서 그대로 쓰면 "숙여서 지나갈 수 있는 새"를
   * 못 지나간다고 본다. 그래서 땅에 닿지 않는(=떠 있는) 장애물만 원본 충돌 박스에
   * 맞춰 안쪽으로 줄인다.
   */
  function obstacleBox(obstacle, snap) {
    var box = {
      x: obstacle.x + 1, y: obstacle.y + 1,
      w: obstacle.w - 2, h: obstacle.h - 2
    };
    if ((!obstacle.boxes || !obstacle.boxes.length) &&
        obstacle.y + obstacle.h < snap.k.groundY + snap.dino.h - 2) {
      box.y += FLY_INSET_TOP;
      box.h -= FLY_INSET_TOP + FLY_INSET_BOTTOM;
      if (box.h < 2) box.h = 2;
    }
    return box;
  }

  // 게임의 checkForCollision() 과 같은 방식: 바깥 박스로 1차 판정 후
  // 스프라이트별 세부 충돌 박스로 2차 판정. 장애물 쪽만 마진만큼 부풀린다.
  function hits(dino, obstacle, snap, mx, my) {
    var dinoBox = {
      x: snap.dino.x + 1, y: dino.y + 1,
      w: snap.dino.w - 2, h: snap.dino.h - 2
    };
    var obsBox = obstacleBox(obstacle, snap);
    var outer = inflate(obsBox, mx, my);
    if (!overlap(dinoBox, outer)) return false;

    var dinoParts = dino.ducking ? snap.boxes.ducking : snap.boxes.running;
    var detailed = obstacle.boxes && obstacle.boxes.length;
    for (var i = 0; i < dinoParts.length; i++) {
      var dp = dinoParts[i];
      var d = { x: dinoBox.x + dp.x, y: dinoBox.y + dp.y, w: dp.w, h: dp.h };
      if (!detailed) {
        // 세부 박스를 모르면 공룡 박스 대 장애물 사각형으로 판정한다 (조금 보수적)
        if (overlap(d, outer)) return true;
        continue;
      }
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
    var ranges = [];
    if (obstacle.boxes && obstacle.boxes.length) {
      for (var j = 0; j < obstacle.boxes.length; j++) {
        ranges.push([obstacle.y + 1 + obstacle.boxes[j].y, obstacle.boxes[j].h]);
      }
    } else {
      var box = obstacleBox(obstacle, snap);
      ranges.push([box.y, box.h]);
    }
    for (var i = 0; i < parts.length; i++) {
      var dTop = dinoTop + parts[i].y;
      var dBottom = dTop + parts[i].h;
      for (var r = 0; r < ranges.length; r++) {
        var oTop = ranges[r][0] - my;
        var oBottom = oTop + ranges[r][1] + 2 * my;
        if (dTop < oBottom && dBottom > oTop) return false;
      }
    }
    return true;
  }

  /** 공룡 충돌 박스 중 가장 아래쪽 (점프해서 올라서는 높이 계산용) */
  function dinoBoxBottom(snap) {
    var boxes = snap.boxes.running;
    var lowest = 0;
    for (var i = 0; i < boxes.length; i++) {
      lowest = Math.max(lowest, boxes[i].y + boxes[i].h);
    }
    return lowest + 1;
  }

  /** 장애물 충돌 박스 중 가장 위쪽 */
  function obstacleTop(obstacle) {
    var top = Infinity;
    for (var i = 0; i < obstacle.boxes.length; i++) {
      top = Math.min(top, obstacle.y + 1 + obstacle.boxes[i].y);
    }
    return top === Infinity ? obstacle.y + 1 : top;
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

  /** 땅에서 지금 뛰면 몇 프레임 뒤에 이 장애물 위로 올라서는가 */
  function framesToClear(snap, obstacle, speed) {
    var k = snap.k;
    var dino = { y: k.groundY, vel: 0, jumping: false, speedDrop: false,
                 reachedMinHeight: false, ducking: false };
    startJump(dino, k, speed);
    var bottom = dinoBoxBottom(snap);
    var top = obstacleTop(obstacle);
    for (var f = 1; f < 40; f++) {
      stepDino(dino, k);
      if (dino.y + bottom < top) return f;
      if (!dino.jumping) break;
    }
    return 40;
  }

  /** 땅에 내려선 지금, 이 장애물을 다시 뛰어넘을 시간이 남아 있는가 */
  function canStillReact(snap, obstacle, speed, extra) {
    var distance = obstacle.x - (snap.dino.x + snap.dino.w);
    return distance >= framesToClear(snap, obstacle, speed) * speed + extra;
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
    var phase2Mode = '';
    var wasEarly = false;
    var autoDuck = false;

    for (var f = 0; f < cfg.horizonFrames; f++) {
      if (plan.jumpAt === f && !dino.jumping && !dino.ducking) {
        startJump(dino, k, speed);
        jumpStarted = true;
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

      if (phase === 1) {
        var ok = { outcome: wasEarly ? OUTCOME.EARLY : OUTCOME.CLEAR, frames: f };
        if (passed) return ok;                      // 확인 단계 목표까지 넘겼다
        if (phase2Mode === 'jump' && !dino.jumping) {
          // 땅에 내려섰다 — 이 장애물을 다시 뛰어넘을 시간이 남았는가
          return canStillReact(snap, target, speed, mx) ? ok
            : { outcome: OUTCOME.CRASH, frames: f };
        }
        if (landedEarly) return ok;                 // 여유 있게 착지했다
        continue;
      }

      if (!passed && !landedEarly) continue;

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
      autoDuck = false;
      if (passableOnGround(snap, target, false, cfg.marginY)) {
        phase2Mode = 'run';            // 그냥 달려서 지나갈 수 있다 (높이 나는 새)
      } else if (passableOnGround(snap, target, true, cfg.marginY)) {
        phase2Mode = 'duck';
        autoDuck = true;
        if (!dino.jumping) dino.ducking = true;
      } else {
        phase2Mode = 'jump';           // 뛰어야 넘는다
        if (!dino.jumping) {
          return canStillReact(snap, target, speed, mx)
            ? { outcome: wasEarly ? OUTCOME.EARLY : OUTCOME.CLEAR, frames: f }
            : { outcome: OUTCOME.CRASH, frames: f };
        }
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

    // 지금 뛰어도 부딪힌다. 앞 장애물은 늦게, 뒤 장애물은 일찍 뛰어야 해서
    // 넘길 수 있는 순간이 좁을 때가 있으니 몇 프레임 뒤를 확인한다.
    for (var d = 1; d <= cfg.reactionFrames; d++) {
      if (simulate(snap, { jumpAt: d, duck: false, dropAt: null }, cfg).outcome === OUTCOME.CLEAR) {
        return { action: 'wait' };
      }
    }

    // 아직 충돌까지 여유가 있으면 성급하게 뛰지 말고 다음 프레임에 다시 판단한다.
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
        x: num(o.xPos, 600),
        y: num(o.yPos, 105),
        w: num(o.width, num(o.typeConfig.width, 17)),
        h: num(o.typeConfig.height, 35),
        type: o.typeConfig.type,
        speedOffset: o.speedOffset || 0,
        boxes: (o.collisionBoxes || []).map(toBox)
      });
    }
    var rc = runner.config || {};
    return {
      speed: num(runner.currentSpeed, 6),
      acceleration: num(rc.ACCELERATION, 0.001),
      maxSpeed: num(rc.MAX_SPEED, 13),
      dino: {
        x: num(t.xPos, FALLBACK.trex.START_X_POS),
        y: num(t.yPos, FALLBACK.groundYPos),
        w: num(tc.WIDTH, FALLBACK.trex.WIDTH),
        h: num(tc.HEIGHT, FALLBACK.trex.HEIGHT),
        jumping: t.jumping, ducking: t.ducking,
        vel: num(t.jumpVelocity, 0), speedDrop: t.speedDrop,
        reachedMinHeight: t.reachedMinHeight
      },
      k: {
        gravity: num(tc.GRAVITY, FALLBACK.trex.GRAVITY),
        // 크롬 원본에는 이 상수 이름에 오타(INIITAL)가 있다. 둘 다 받아 준다.
        jumpVelocity: num(tc.INITIAL_JUMP_VELOCITY, tc.INIITAL_JUMP_VELOCITY,
                          FALLBACK.trex.INITIAL_JUMP_VELOCITY),
        dropVelocity: num(tc.DROP_VELOCITY, FALLBACK.trex.DROP_VELOCITY),
        speedDropCoefficient: num(tc.SPEED_DROP_COEFFICIENT, FALLBACK.trex.SPEED_DROP_COEFFICIENT),
        maxJumpHeight: num(tc.MAX_JUMP_HEIGHT, FALLBACK.trex.MAX_JUMP_HEIGHT),
        minJumpHeight: num(t.minJumpHeight,
                           num(t.groundYPos, FALLBACK.groundYPos)
                             - num(tc.MIN_JUMP_HEIGHT, FALLBACK.trex.MIN_JUMP_HEIGHT)),
        groundY: num(t.groundYPos, FALLBACK.groundYPos)
      },
      boxes: boxes,
      obstacles: obstacles
    };
  }

  /** 게임에서 읽은 값이 숫자가 아니면(버전 차이·오타 키) 원본 상수로 대신한다. */
  function num() {
    for (var i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] === 'number' && isFinite(arguments[i])) return arguments[i];
    }
    return 0;
  }

  function toBox(b) {
    return { x: b.x, y: b.y, w: b.width != null ? b.width : b.w, h: b.height != null ? b.height : b.h };
  }

  // ---------------------------------------------------------------- 캔버스 모드
  // 게임 내부 객체에 접근할 수 없을 때(최신 크롬처럼 인스턴스가 감춰진 경우)
  // 게임이 그린 캔버스를 직접 읽어 장애물을 찾는다.
  // 캔버스는 항상 세로 150 게임단위이므로 배율만 구하면 좌표가 그대로 맞는다.

  var SCAN_TOP = 30;              // 이 위쪽은 점수판이라 보지 않는다
  var SCAN_BOTTOM = 126;          // 이 아래는 지평선(땅)
  var GROUND_ROW = 129;           // 땅 무늬가 흐르는 줄 — 게임이 도는지 확인하는 데 쓴다
  var GROUND_BOTTOM = 88;         // 여기보다 아래까지 그려지면 땅과 상관있는 진짜 장애물
  var BG_SPEED_RATIO = 0.55;      // 게임 속도의 이 비율 미만이면 배경(구름 0.2·달 0.25·별 0.3배)
  var BLOB_GAP = 3;               // 가로로 이만큼 떨어지면 다른 물체로 본다
  var GHOST_SPEED_FACTOR = 0.92;  // 안 보이는 장애물은 조금 느리게 — 오래 남겨 두는 쪽이 안전하다
  var VERTICAL_GAP = 4;           // 세로로 이만큼 비면 다른 물체로 본다 (구름 vs 선인장)
  var DINO_MERGE_GAP = 8;         // 공룡 그림 안의 빈틈은 이만큼까지 한 덩어리로 본다
  var DINO_X = FALLBACK.trex.START_X_POS;
  var DINO_W = FALLBACK.trex.WIDTH;
  var DINO_FEET = FALLBACK.groundYPos + FALLBACK.trex.HEIGHT;
  var SCAN_FROM = DINO_X + FALLBACK.trex.WIDTH_DUCK + 3;   // 숙인 공룡 꼬리까지 피한다

  function findCanvas() {
    if (typeof document === 'undefined') return null;
    var direct = document.querySelector('canvas.runner-canvas');
    if (direct && direct.width) return direct;
    var list = document.querySelectorAll('canvas');
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c.width || !c.height) continue;
      var ratio = c.width / c.height;
      if (ratio < 2 || ratio > 12) continue;          // 다이노 캔버스는 가로로 길다
      if (!best || c.width * c.height > best.width * best.height) best = c;
    }
    return best;
  }

  function createReader(canvas) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('캔버스 컨텍스트를 얻지 못했습니다');
    ctx.getImageData(0, 0, 1, 1);                     // 읽기가 막혀 있으면 여기서 예외가 난다
    var scale = canvas.height / 150;
    if (!(scale > 0.2)) throw new Error('캔버스 크기가 다이노 게임과 다릅니다');
    return {
      canvas: canvas,
      ctx: ctx,
      scale: scale,
      widthUnits: Math.floor(canvas.width / scale)
    };
  }

  /** 캔버스 한 장을 읽어 장애물 후보(블롭)와 공룡 상태를 뽑는다. */
  function scanCanvas(reader) {
    var scale = reader.scale;
    var canvas = reader.canvas;
    var top = Math.max(0, Math.round(SCAN_TOP * scale));
    var bottom = Math.min(canvas.height, Math.round((GROUND_ROW + 2) * scale));
    if (bottom - top < 2) return null;

    var band = reader.ctx.getImageData(0, top, canvas.width, bottom - top);
    var data = band.data;
    var bandW = band.width;
    var bandH = band.height;
    var rowStep = Math.max(1, Math.floor(scale));
    var blobMaxPy = Math.min(bandH, Math.round((SCAN_BOTTOM + 1 - SCAN_TOP) * scale));

    function inkAt(px, py) { return data[((py * bandW) + px) * 4 + 3] > 0; }

    /**
     * 이 열에서 잉크가 이어진 조각들. 세로로 끊기면 다른 물체로 나눈다.
     * (구름 밑을 선인장이 지나갈 때 하나로 뭉치면 판단이 완전히 어긋난다)
     */
    function columnSegments(gx) {
      var px = Math.round(gx * scale);
      if (px < 0 || px >= bandW) return null;
      var segs = null;
      var current = null;
      var gapUnits = 0;
      for (var py = 0; py < blobMaxPy; py += rowStep) {
        if (inkAt(px, py)) {
          var gy = SCAN_TOP + py / scale;
          if (current) current.bottom = gy;
          else current = { top: gy, bottom: gy };
          gapUnits = 0;
        } else if (current) {
          gapUnits += rowStep / scale;
          if (gapUnits > VERTICAL_GAP) {
            if (!segs) segs = [];
            segs.push(current);
            current = null;
          }
        }
      }
      if (current) {
        if (!segs) segs = [];
        segs.push(current);
      }
      return segs;
    }

    // 공룡 — 게임 x 50~94 에 고정되어 있다. 구름이 겹쳐 보일 수 있으므로
    // 조각 중 가장 큰 것(공룡은 47, 구름은 14 높이)을 공룡으로 본다.
    // 공룡 — 게임 x 50~94 에 고정되어 있다. 구름·달·별이 겹쳐 보일 수 있으므로
    // 그 구간에서 가장 넓게 자리를 차지한 덩어리를 공룡으로 본다
    // (공룡은 44칸을 차지하고, 별은 9칸·달은 20칸뿐이다).
    var dinoTop = null;
    var dinoOnGround = false;
    var groups = [];
    for (var dx = DINO_X; dx <= DINO_X + DINO_W; dx++) {
      var dsegs = columnSegments(dx);
      if (!dsegs) continue;
      var touched = [];
      for (var ds = 0; ds < dsegs.length; ds++) {
        var seg = dsegs[ds];
        if (seg.bottom >= SCAN_BOTTOM - 2) dinoOnGround = true;
        var hit = -1;
        for (var gi = 0; gi < groups.length; gi++) {
          var gp = groups[gi];
          if (seg.top <= gp.bottom + DINO_MERGE_GAP && seg.bottom >= gp.top - DINO_MERGE_GAP) {
            if (seg.top < gp.top) gp.top = seg.top;
            if (seg.bottom > gp.bottom) gp.bottom = seg.bottom;
            hit = gi;
            break;
          }
        }
        if (hit < 0) {
          groups.push({ top: seg.top, bottom: seg.bottom, cols: 0 });
          hit = groups.length - 1;
        }
        if (touched.indexOf(hit) < 0) touched.push(hit);
      }
      for (var t = 0; t < touched.length; t++) groups[touched[t]].cols++;
    }
    var dinoBottom = null;
    var maxCols = 0;
    for (var g = 0; g < groups.length; g++) {
      if (groups[g].cols > maxCols) maxCols = groups[g].cols;
    }
    // 넓게 자리를 차지한 것들 중 가장 아래쪽에 있는 것이 공룡이다
    // (구름이 공중의 공룡 위에 겹쳐 보일 때 하늘 쪽을 고르지 않도록).
    var bestBottom = -1;
    for (var g2 = 0; g2 < groups.length; g2++) {
      var gr = groups[g2];
      if (gr.cols < maxCols * 0.4) continue;
      if (gr.bottom > bestBottom) {
        bestBottom = gr.bottom;
        dinoTop = gr.top;
        dinoBottom = gr.bottom;
      }
    }

    // 공룡 오른쪽의 물체들 — 조각을 세로로 겹치는 것끼리만 이어 붙인다.
    var blobs = [];
    var open = [];
    for (var gx = SCAN_FROM; gx < reader.widthUnits; gx++) {
      var segs = columnSegments(gx);
      if (segs) {
        for (var si = 0; si < segs.length; si++) {
          var s2 = segs[si];
          var target = null;
          for (var oi = 0; oi < open.length; oi++) {
            var ob = open[oi];
            if (gx - ob.right > BLOB_GAP) continue;
            if (s2.top <= ob.bottom + VERTICAL_GAP && s2.bottom >= ob.top - VERTICAL_GAP) {
              target = ob;
              break;
            }
          }
          if (target) {
            target.right = gx;
            if (s2.top < target.top) target.top = s2.top;
            if (s2.bottom > target.bottom) target.bottom = s2.bottom;
          } else {
            open.push({ x: gx, right: gx, top: s2.top, bottom: s2.bottom });
          }
        }
      }
      for (var k = open.length - 1; k >= 0; k--) {
        if (gx - open[k].right > BLOB_GAP) {
          blobs.push(open[k]);
          open.splice(k, 1);
        }
      }
    }
    for (var m = 0; m < open.length; m++) blobs.push(open[m]);
    blobs.sort(function (a, b) { return a.x - b.x; });
    for (var b = 0; b < blobs.length; b++) blobs[b].w = blobs[b].right - blobs[b].x + 1;

    // 땅 무늬가 흐르는지 — 게임이 실제로 돌고 있는지 확인하는 신호
    var groundPy = Math.min(bandH - 1, Math.round((GROUND_ROW - SCAN_TOP) * scale));
    var ground = 0;
    for (var s = 0; s < 32; s++) {
      var gpx = Math.round((s + 1) * (bandW - 1) / 33);
      if (inkAt(gpx, groundPy)) ground += 1 << (s % 30);
    }

    return {
      blobs: blobs, dinoTop: dinoTop, dinoBottom: dinoBottom,
      dinoOnGround: dinoOnGround, ground: ground
    };
  }

  function createTracker() {
    return { prev: [], speed: 6, lastMs: 0 };
  }

  /**
   * 블롭을 프레임 사이로 추적해 이동 속도를 잰다.
   * 구름·달·별은 게임 속도의 0.2~0.3배로 움직이므로 이것으로 걸러낼 수 있다.
   */
  function trackBlobs(tracker, blobs, nowMs, minX, maxX) {
    var frames = tracker.lastMs ? (nowMs - tracker.lastMs) / (1000 / FPS) : 1;
    if (!(frames > 0.05) || frames > 12) frames = 1;
    tracker.lastMs = nowMs;

    var fastest = 0;
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      var best = null;
      var bestError = Infinity;
      var atEdge = b.x <= minX || b.right >= maxX;
      for (var j = 0; j < tracker.prev.length; j++) {
        var p = tracker.prev[j];
        // 화면 끝에서 잘리는 중이면 폭이 빠르게 줄어드니 크기 조건을 풀어 준다.
        var edge = atEdge || p.x <= minX || p.right >= maxX;
        if (!edge && Math.abs(p.w - b.w) > Math.max(8, p.w * 0.6)) continue;
        if (b.top > p.bottom + 8 || b.bottom < p.top - 8) continue;   // 세로로 겹쳐야 한다
        var expected = p.speed === undefined ? tracker.speed : p.speed;
        var error = Math.abs((p.x - expected * frames) - b.x);
        if (error < bestError) { bestError = error; best = p; }
      }
      if (best && bestError <= 10) {
        b.seen = (best.seen || 1) + 1;
        b.wMax = Math.max(b.w, best.wMax || best.w);
        b.topMin = Math.min(b.top, best.topMin === undefined ? best.top : best.topMin);
        b.bottomMax = Math.max(b.bottom, best.bottomMax === undefined ? best.bottom : best.bottomMax);
        // 화면 끝에서 잘려 보이는 동안은 좌표가 멈춰 보이므로 속도를 재지 않는다.
        var clipped = b.x <= minX || b.right >= maxX ||
                      best.x <= minX || best.right >= maxX;
        var dx = (best.x - b.x) / frames;
        if (!clipped && dx >= -1 && dx <= 20) {
          b.speed = best.speed === undefined ? dx : best.speed * 0.6 + dx * 0.4;
        } else {
          b.speed = best.speed;
        }
      } else {
        b.seen = 1;
        b.wMax = b.w;
        b.topMin = b.top;
        b.bottomMax = b.bottom;
      }
      if (b.seen > 1 && b.speed > fastest) fastest = b.speed;
    }
    if (fastest >= 4) tracker.speed += (fastest - tracker.speed) * 0.3;
    tracker.speed = Math.max(5, Math.min(14, tracker.speed));
    tracker.prev = blobs;
    return tracker.speed;
  }

  /** 블롭 중 진짜 장애물만 골라 policy 가 쓰는 형태로 바꾼다. */
  /**
   * 블롭 중 진짜 장애물만 골라 policy 가 쓰는 형태로 바꾼다.
   * 두 가지 신호 중 하나만 맞아도 장애물로 본다.
   *   1) 그림이 땅 가까이(y 88 아래)까지 내려온다 — 구름 0~85, 달 ~70, 별 ~79 는
   *      절대 여기까지 오지 않으므로 이것만으로 확실하다.
   *   2) 게임 속도에 가깝게 움직인다 — 날개를 접어 작게 보이는 익룡을 놓치지 않는다.
   *      (배경은 0.2~0.3배로 느리다)
   */
  function toObstacles(blobs, speed) {
    var out = [];
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      var reachesGround = b.bottom >= GROUND_BOTTOM;
      var movesLikeObstacle = b.seen > 1 && b.speed !== undefined &&
                              b.speed >= speed * BG_SPEED_RATIO;
      if (!reachesGround && !movesLikeObstacle) continue;
      // 밴드 밑까지 이어져 있으면 실제로는 땅(y=140)까지 그려진 장애물이다.
      var bottom = b.bottom >= SCAN_BOTTOM - 2 ? DINO_FEET : b.bottom;
      var topMin = b.topMin === undefined ? b.top : b.topMin;
      var bottomMax = b.bottomMax === undefined ? b.bottom : b.bottomMax;
      if (bottomMax >= SCAN_BOTTOM - 2) bottomMax = DINO_FEET;
      out.push({
        x: b.x, y: b.top, w: b.w, h: Math.max(2, bottom - b.top),
        wMax: b.wMax || b.w, yMax: topMin, hMax: Math.max(2, bottomMax - topMin),
        boxes: [], speedOffset: 0
      });
    }
    return out;
  }

  /**
   * 공룡 왼쪽은 공룡 그림과 겹쳐서 읽을 수 없다. 그 구간으로 들어간 장애물은
   * 마지막으로 본 위치에서 속도만큼 계속 밀어 주며 기억한다.
   * (이걸 안 하면 "다 지나갔다"고 착각해 공중에서 빠른 착지를 눌러 부딪힌다)
   */
  function updateHidden(bot, visible, speed, frames) {
    var kept = [];
    var previous = bot.hidden || [];
    var i;
    for (i = 0; i < previous.length; i++) {
      var h = previous[i];
      h.x -= speed * GHOST_SPEED_FACTOR * frames;
      if (h.x + h.w > DINO_X - 6) kept.push(h);
    }

    var last = bot._visible || [];
    for (i = 0; i < last.length; i++) {
      var p = last[i];
      var right = (p.x + p.w) - speed * GHOST_SPEED_FACTOR * frames;
      if (right < DINO_X - 6) continue;              // 이미 완전히 지나갔다
      if (right - (p.wMax || p.w) > SCAN_FROM) continue;   // 아직 보여야 정상이다
      var stillSeen = false;
      for (var j = 0; j < visible.length; j++) {
        if (Math.abs((visible[j].x + visible[j].w) - right) < 12 + speed &&
            Math.abs(visible[j].y - p.y) < 20) { stillSeen = true; break; }
      }
      if (stillSeen) continue;
      // 사라지기 직전의 조각이 아니라, 가장 크게 보였을 때의 모습으로 기억한다.
      var width = p.wMax || p.w;
      kept.push({
        x: right - width, y: p.yMax === undefined ? p.y : p.yMax, w: width,
        h: p.hMax === undefined ? p.h : p.hMax,
        wMax: width, yMax: p.yMax, hMax: p.hMax,
        boxes: [], speedOffset: 0, hidden: true
      });
    }

    bot.hidden = kept;
    bot._visible = visible.slice();
    var all = visible.concat(kept);
    all.sort(function (a, b) { return a.x - b.x; });
    return all;
  }

  /** 날아다니는 장애물이 아직 공룡 자리를 지나는 중인가 */
  function stillOverlapping(obstacles) {
    var left = DINO_X - 8;
    var right = DINO_X + FALLBACK.trex.WIDTH_DUCK + 8;
    for (var i = 0; i < obstacles.length; i++) {
      var o = obstacles[i];
      if (o.y + o.h >= DINO_FEET - 2) continue;          // 땅에 붙은 것은 어차피 숙여도 못 피한다
      if (o.x < right && o.x + o.w > left) return true;
    }
    return false;
  }

  function fallbackPhysics() {
    var t = FALLBACK.trex;
    return {
      gravity: t.GRAVITY,
      jumpVelocity: t.INITIAL_JUMP_VELOCITY,
      dropVelocity: t.DROP_VELOCITY,
      speedDropCoefficient: t.SPEED_DROP_COEFFICIENT,
      maxJumpHeight: t.MAX_JUMP_HEIGHT,
      minJumpHeight: FALLBACK.groundYPos - t.MIN_JUMP_HEIGHT,
      groundY: FALLBACK.groundYPos
    };
  }

  // 캔버스만 봐서는 공룡의 속도·상태를 알 수 없으므로, 우리가 누른 키로부터
  // 게임과 같은 물리로 따라가고 화면(위쪽 끝·발밑)으로 어긋남을 바로잡는다.
  function createDinoModel() {
    var k = fallbackPhysics();
    return {
      k: k,
      pending: 0,
      state: {
        y: k.groundY, vel: 0, jumping: false, ducking: false,
        speedDrop: false, reachedMinHeight: false
      }
    };
  }

  function modelAdvance(model, frames) {
    model.pending += frames;
    var steps = 0;
    while (model.pending >= 1 && steps < 20) {
      stepDino(model.state, model.k);
      model.pending -= 1;
      steps++;
    }
  }

  function modelJump(model, speed) {
    if (!model.state.jumping && !model.state.ducking) startJump(model.state, model.k, speed);
  }

  function modelDuck(model, on) {
    if (model.state.jumping) {
      if (on && !model.state.speedDrop) { model.state.speedDrop = true; model.state.vel = 1; }
      else if (!on) model.state.speedDrop = false;
    } else {
      model.state.ducking = !!on;
    }
  }

  function modelGrounded(model) {
    model.pending = 0;
    model.state.y = model.k.groundY;
    model.state.vel = 0;
    model.state.jumping = false;
    model.state.speedDrop = false;
    model.state.reachedMinHeight = false;
  }

  function syncModel(model, scan, frames) {
    var k = model.k;
    var top = scan.dinoTop;
    if (top === null) { model.lastTop = undefined; return; }

    if (scan.dinoOnGround && top >= k.groundY - 2) {        // 확실히 땅에 있다
      if (model.state.jumping) modelGrounded(model);
      model.state.ducking = top >= k.groundY + 8;
      model.lastTop = top;
      return;
    }
    if (scan.dinoOnGround || top >= k.groundY - 6) {
      // 장애물이 공룡과 겹쳐 보이는 등 애매한 상황 — 모델을 믿는다.
      model.lastTop = undefined;
      return;
    }

    // 확실히 공중이다. 화면에서 높이와 낙하 속도를 다시 잰다.
    // 머리 쪽은 구름이 겹쳐 보일 수 있으므로 발 위치에서 거꾸로 계산한다
    // (땅에 닿은 물체가 없는 상황이므로 가장 아래쪽 그림이 공룡의 발이다).
    if (scan.dinoBottom !== null) top = scan.dinoBottom - FALLBACK.trex.HEIGHT + 1;
    var measured = (model.lastTop !== undefined && frames > 0)
      ? (top - model.lastTop) / frames
      : null;
    if (!model.state.jumping) {
      model.state.jumping = true;
      model.state.ducking = false;
      model.state.speedDrop = false;
      model.state.reachedMinHeight = top < k.minJumpHeight;
      model.state.vel = measured === null ? 0 : measured;
    } else if (measured !== null && Math.abs(top - model.state.y) > 3) {
      model.state.vel = measured;
    }
    if (Math.abs(top - model.state.y) <= 30) model.state.y = top;
    model.pending = 0;
    model.lastTop = top;
  }

  function canvasSnapshot(model, obstacles, speed) {
    var st = model.state;
    return {
      speed: speed,
      acceleration: 0.001,
      maxSpeed: 13,
      dino: {
        x: DINO_X, y: st.y, w: DINO_W, h: FALLBACK.trex.HEIGHT,
        jumping: st.jumping, ducking: st.ducking,
        vel: st.vel, speedDrop: st.speedDrop, reachedMinHeight: st.reachedMinHeight
      },
      k: model.k,
      boxes: FALLBACK.boxes,
      obstacles: obstacles
    };
  }

  /** 합성 키 이벤트. keyCode 를 직접 심어야 게임이 알아본다. */
  function sendKey(type, code) {
    if (typeof document === 'undefined' || typeof KeyboardEvent === 'undefined') return;
    var ev;
    try {
      ev = new KeyboardEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { get: function () { return code; } });
      Object.defineProperty(ev, 'which', { get: function () { return code; } });
    } catch (err) {
      return;
    }
    document.dispatchEvent(ev);
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

  /** 게임 인스턴스를 다른 이름/위치에서 찾아본다. */
  function findInstance(scope) {
    if (!scope) return null;
    var keys;
    try { keys = Object.keys(scope); } catch (err) { return null; }
    for (var i = 0; i < keys.length; i++) {
      var v;
      try { v = scope[keys[i]]; } catch (err) { continue; }
      if (v && typeof v === 'object' && v.tRex && v.horizon && v.tRex.config) return v;
    }
    return null;
  }

  /** 캔버스 모드 준비. 못 쓰는 환경이면 이유를 알리고 null. */
  function ensureCanvas(bot) {
    if (bot.reader) return bot.reader;
    if (bot.readerError) return null;
    try {
      var canvas = findCanvas();
      if (!canvas) {
        bot.readerError = new Error('canvas-not-found');
        console.error('[dino-bot] 다이노 게임 캔버스를 찾지 못했습니다. ' +
          '게임이 보이는 탭에서 실행했는지 확인하세요.');
        return null;
      }
      bot.reader = createReader(canvas);
      bot.dino = createDinoModel();
      bot.tracker = createTracker();
      console.log('%c[dino-bot] 게임 내부에 접근할 수 없어 화면(캔버스)을 읽어 플레이합니다. ' +
        '캔버스 ' + canvas.width + 'x' + canvas.height +
        ', 배율 ' + bot.reader.scale.toFixed(2), 'color:#0a0');
      return bot.reader;
    } catch (err) {
      bot.readerError = err;
      console.error('[dino-bot] 캔버스를 읽을 수 없습니다 (' + (err.name || err.message) + '). ' +
        '이 페이지에서는 콘솔 봇을 쓸 수 없습니다. 대신 파이썬 화면 인식 봇을 쓰세요: ' +
        'pip install -r requirements.txt  →  cd python && python3 -m dino_bot.main');
      return null;
    }
  }

  function tuneMargin(bot, score) {
    var cfg = bot.cfg;
    if (score >= cfg.goodRunScore) {
      cfg.margin = Math.max(cfg.marginMin, cfg.margin - cfg.marginOnGoodRun);
    } else {
      cfg.margin = Math.min(cfg.marginMax, cfg.margin + cfg.marginOnCrash);
    }
    saveState(bot);
    return cfg.margin;
  }

  /** 게임 내부를 읽을 수 있을 때 (가장 정확) */
  function tickInternals(bot, runner, nowMs) {
    if (runner.crashed) { onCrash(bot, runner, nowMs); return; }
    if (!runner.playing) { press(runner, KEY.JUMP); return; }   // 아직 시작 전
    bot._crashedAt = 0;

    var snap = snapshot(runner);
    var d = decide(snap, bot.cfg);
    bot.stats.action = d.action;
    bot.stats.speed = snap.speed;
    bot.stats.last = scoreOf(runner);
    bot.applyDecision(d, runner.tRex, snap.speed);
  }

  /** 화면(캔버스)만 보고 플레이할 때 */
  function tickCanvas(bot, nowMs, frames) {
    var scan = scanCanvas(bot.reader);
    if (!scan) return;

    var speed = trackBlobs(bot.tracker, scan.blobs, nowMs, SCAN_FROM, bot.reader.widthUnits - 2);
    modelAdvance(bot.dino, frames);
    syncModel(bot.dino, scan, frames);

    // 화면의 물체가 하나도 움직이지 않으면 게임이 멈춘 것이다 (시작 전이거나 죽었거나).
    // 지평선 무늬는 버전에 따라 일정할 수 있어 믿을 수 없다.
    var moving = scan.blobs.length + ':' + scan.ground;
    for (var s2 = 0; s2 < scan.blobs.length; s2++) moving += ',' + Math.round(scan.blobs[s2].x);
    var signature = moving + '|' + (scan.dinoTop === null ? -1 : Math.round(scan.dinoTop));
    if (signature === bot._signature) {
      if (!bot._stillSince) bot._stillSince = nowMs;
    } else {
      bot._signature = signature;
      bot._stillSince = 0;
      if (!bot._playing) {        // 화면이 실제로 움직였다 = 게임이 돌고 있다
        bot._playing = true;
        bot._runStart = nowMs;
      }
    }

    if (bot._stillSince && nowMs - bot._stillSince > 900) {
      if (bot._downHeld) { bot.keyUp(KEY.DUCK); bot._downHeld = false; }
      // 장애물을 한 번도 못 본 채 멈춘 것은 아직 게임이 시작되지 않은 것이다
      // (인트로에서 공룡이 걸어 들어오는 동안에도 화면은 움직인다).
      if (bot._playing && bot._sawObstacle) {  // 달리다가 멈췄다 = 죽었다
        var lasted = (nowMs - (bot._runStart || nowMs)) / 1000;
        bot.stats.deaths++;
        bot.stats.runs++;
        if (lasted > bot.stats.best) bot.stats.best = Math.round(lasted);
        tuneMargin(bot, lasted >= 30 ? bot.cfg.goodRunScore : 0);
        if (bot.cfg.log) console.log('[dino-bot] 충돌 ·', Math.round(lasted), '초 버팀 · 새 마진', bot.cfg.margin);
      }
      bot._playing = false;
      bot._sawObstacle = false;
      bot.stats.action = '재시작';
      bot.keyTap(KEY.JUMP);                    // 시작 / 재시작
      bot._stillSince = nowMs;                 // 연타 방지
      bot._runStart = nowMs;
      modelGrounded(bot.dino);
      bot.tracker.prev = [];
      bot.hidden = [];
      bot._visible = [];
      return;
    }

    bot.stats.last = Math.round((nowMs - (bot._runStart || nowMs)) / 1000);

    var obstacles = updateHidden(bot, toObstacles(scan.blobs, speed), speed, frames);
    if (obstacles.length) bot._sawObstacle = true;
    bot._lastObstacles = obstacles;
    var snap = canvasSnapshot(bot.dino, obstacles, speed);
    var d = decide(snap, bot.cfg);

    // 화면으로 잰 위치에는 오차가 있다. 날아다니는 장애물이 아직 공룡과 겹쳐 있는
    // 동안에는 숙인 자세를 풀지 않는다 (일어서다가 새에 부딪히는 사고를 막는다).
    if (bot._downHeld && !bot.dino.state.jumping &&
        d.action !== 'duck' && d.action !== 'drop' && stillOverlapping(obstacles)) {
      d = { action: 'duck' };
    }

    bot.stats.action = d.action;
    bot.stats.speed = speed;
    bot.applyDecision(d, bot.dino.state, speed);
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
      _lastTick: 0,
      mode: '-',              // internals(내부 접근) 또는 canvas(화면 읽기)
      reader: null,
      tracker: null,
      dino: null,
      _stillSince: 0,
      _signature: ''
    };

    loadState(bot);

    bot.getRunner = function () {
      var R = G.Runner;
      if (R && R.instance_ && R.instance_.tRex && R.instance_.horizon) return R.instance_;
      if (bot._runner && bot._runner.tRex) return bot._runner;
      if (bot._scanned) return null;
      // 최신 크롬처럼 인스턴스 보관 위치가 바뀐 경우를 대비한 탐색 — 비싸므로 한 번만.
      bot._scanned = true;
      bot._runner = findInstance(R) || findInstance(G);
      if (bot._runner) console.log('[dino-bot] 게임 인스턴스를 다른 위치에서 찾았습니다.');
      return bot._runner;
    };

    /** 키를 보낸다. 내부 접근이 되면 게임 함수를 직접 부르고, 아니면 합성 이벤트. */
    bot.keyDown = function (code) {
      bot._sentCount = (bot._sentCount || 0) + 1;
      var runner = bot.getRunner();
      if (runner) press(runner, code); else sendKey('keydown', code);
    };
    bot.keyUp = function (code) {
      var runner = bot.getRunner();
      if (runner) release(runner, code); else sendKey('keyup', code);
    };
    bot.keyTap = function (code) {
      var runner = bot.getRunner();
      if (runner) { press(runner, code); return; }
      sendKey('keydown', code);
      sendKey('keyup', code);          // 게임오버 화면의 재시작은 keyup 에서 처리된다
    };

    /** 판단 결과대로 키를 누른다. state 는 공룡의 현재 상태(내부 또는 모델). */
    bot.applyDecision = function (d, state, speed) {
      // 아래키는 "누른 채로 유지"해야 한다. 떼는 순간 숙이기도 빠른 착지도 풀린다.
      var wantDown = d.action === 'duck' || d.action === 'drop';
      if (!wantDown && bot._downHeld) {
        bot.keyUp(KEY.DUCK);
        bot._downHeld = false;
        if (bot.dino) modelDuck(bot.dino, false);
      } else if (wantDown && !bot._downHeld) {
        bot.keyDown(KEY.DUCK);         // 지상에서는 숙이기, 공중에서는 빠른 착지
        bot._downHeld = true;
        if (bot.dino) modelDuck(bot.dino, true);
      } else if (wantDown && d.action === 'duck' && !state.ducking && !state.jumping) {
        // 착지하면서 게임이 숙이기를 풀었으면 다시 눌러 준다.
        bot.keyUp(KEY.DUCK);
        bot.keyDown(KEY.DUCK);
        if (bot.dino) modelDuck(bot.dino, true);
      }
      if (d.action === 'jump') {
        bot.keyTap(KEY.JUMP);
        if (bot.dino) modelJump(bot.dino, speed);
      }
      if (bot.cfg.log && d.desperate) {
        console.warn('[dino-bot] 안전한 선택지 없음 →', d.action, 'margin=', bot.cfg.margin);
      }
    };

    bot.tick = function (nowMs) {
      // 실제 틱 간격을 재서 마진에 반영한다. 화면이 버벅이면 그만큼 보수적으로 판단한다.
      if (nowMs === undefined) nowMs = timeNow();
      var frames = 1;
      if (bot._lastTick) {
        var gap = (nowMs - bot._lastTick) / (1000 / FPS);
        if (gap > 0 && gap < 60) {
          frames = gap;
          cfg.lagFrames = gap > cfg.lagFrames ? gap : cfg.lagFrames * 0.9 + gap * 0.1;
          cfg.lagFrames = Math.max(1, Math.min(cfg.maxLagFrames, cfg.lagFrames));
        }
      }
      bot._lastTick = nowMs;

      var runner = bot.getRunner();
      if (runner) {
        bot.mode = 'internals';
        tickInternals(bot, runner, nowMs);
        return;
      }
      if (!ensureCanvas(bot)) return;   // 캔버스도 못 쓰면 이미 이유를 알렸다
      bot.mode = 'canvas';
      tickCanvas(bot, nowMs, frames);
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
      if (bot._downHeld) { bot.keyUp(KEY.DUCK); bot._downHeld = false; }
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
      tuneMargin(bot, score);
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
    var canvasMode = bot.mode === 'canvas';
    var lines = [
      'DINO BOT  ' + (bot.running ? '● 작동중' : '○ 정지'),
      '방식   ' + (canvasMode ? '화면 읽기' : (bot.mode === 'internals' ? '내부 연결' : '게임 찾는 중')),
      (canvasMode ? '생존   ' + s.last + '초' : '점수   ' + s.last),
      '최고   ' + s.best + (canvasMode ? '초' : ''),
      '속도   ' + s.speed.toFixed(2),
      '판단   ' + s.action,
      '마진   ' + bot.cfg.margin + 'px',
      '죽음   ' + s.deaths + '회'
    ];
    if (bot.readerError) lines.push('※ 화면을 읽을 수 없음 — 콘솔 확인');
    hudEl.textContent = lines.join('\n');
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
    KEY: KEY,
    // 캔버스 모드 (테스트용으로 열어 둔다)
    findCanvas: findCanvas,
    createReader: createReader,
    scanCanvas: scanCanvas,
    createTracker: createTracker,
    trackBlobs: trackBlobs,
    toObstacles: toObstacles,
    createDinoModel: createDinoModel,
    modelAdvance: modelAdvance,
    modelJump: modelJump,
    modelDuck: modelDuck,
    syncModel: syncModel,
    canvasSnapshot: canvasSnapshot,
    obstacleBox: obstacleBox,
    passableOnGround: passableOnGround
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
