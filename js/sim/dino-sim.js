/*!
 * dino-sim.js — 크롬 공룡 게임(t-rex-runner) 시뮬레이터 (테스트 전용)
 *
 * 브라우저 없이 봇을 검증하기 위해 원본 게임의 물리·장애물 생성·충돌 판정을
 * 그대로 옮겼다. 상수와 충돌 박스 값은 크롬 원본(offline.js)과 동일하다.
 * 난수는 시드를 받아 재현 가능하게 만들었다.
 */
'use strict';

var FPS = 60;
var DEFAULT_DIMENSIONS = { WIDTH: 600, HEIGHT: 150 };

var RUNNER_CONFIG = {
  ACCELERATION: 0.001,
  BOTTOM_PAD: 10,
  CLEAR_TIME: 3000,
  GAP_COEFFICIENT: 0.6,
  GRAVITY: 0.6,
  MAX_OBSTACLE_LENGTH: 3,
  MAX_OBSTACLE_DUPLICATION: 2,
  MAX_SPEED: 13,
  SPEED: 6
};

var TREX_CONFIG = {
  DROP_VELOCITY: -5,
  GRAVITY: 0.6,
  HEIGHT: 47,
  HEIGHT_DUCK: 25,
  INITIAL_JUMP_VELOCITY: -10,
  MAX_JUMP_HEIGHT: 30,
  MIN_JUMP_HEIGHT: 30,
  SPEED_DROP_COEFFICIENT: 3,
  START_X_POS: 50,
  WIDTH: 44,
  WIDTH_DUCK: 59
};

var TREX_COLLISION_BOXES = {
  DUCKING: [box(1, 18, 55, 25)],
  RUNNING: [
    box(22, 0, 17, 16), box(1, 18, 30, 9), box(10, 35, 14, 8),
    box(1, 24, 29, 5), box(5, 30, 21, 4), box(9, 34, 15, 4)
  ]
};

var OBSTACLE_TYPES = [
  {
    type: 'CACTUS_SMALL', width: 17, height: 35, yPos: 105,
    multipleSpeed: 4, minGap: 120, minSpeed: 0,
    collisionBoxes: [box(0, 7, 5, 27), box(4, 0, 6, 34), box(10, 4, 7, 14)]
  },
  {
    type: 'CACTUS_LARGE', width: 25, height: 50, yPos: 90,
    multipleSpeed: 7, minGap: 120, minSpeed: 0,
    collisionBoxes: [box(0, 12, 7, 38), box(8, 0, 7, 49), box(13, 10, 10, 38)]
  },
  {
    type: 'PTERODACTYL', width: 46, height: 40, yPos: [100, 75, 50],
    multipleSpeed: 999, minSpeed: 8.5, minGap: 150, speedOffset: 0.8,
    collisionBoxes: [
      box(15, 15, 16, 5), box(21, 24, 6, 6), box(1, 22, 13, 4),
      box(4, 18, 8, 6), box(10, 15, 8, 13)
    ]
  }
];

var MAX_GAP_COEFFICIENT = 1.5;

function box(x, y, width, height) { return { x: x, y: y, width: width, height: height }; }

// 재현 가능한 난수 (mulberry32)
function makeRandom(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxCompare(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
}

function adjust(part, parent) {
  return box(parent.x + part.x, parent.y + part.y, part.width, part.height);
}

function checkForCollision(obstacle, tRex) {
  if (!obstacle) return false;
  var tRexBox = box(tRex.xPos + 1, tRex.yPos + 1,
    tRex.config.WIDTH - 2, tRex.config.HEIGHT - 2);
  var obstacleBox = box(obstacle.xPos + 1, obstacle.yPos + 1,
    obstacle.typeConfig.width * obstacle.size - 2, obstacle.typeConfig.height - 2);
  if (!boxCompare(tRexBox, obstacleBox)) return false;

  var trexBoxes = tRex.ducking ? TREX_COLLISION_BOXES.DUCKING : TREX_COLLISION_BOXES.RUNNING;
  for (var t = 0; t < trexBoxes.length; t++) {
    for (var i = 0; i < obstacle.collisionBoxes.length; i++) {
      if (boxCompare(adjust(trexBoxes[t], tRexBox), adjust(obstacle.collisionBoxes[i], obstacleBox))) {
        return true;
      }
    }
  }
  return false;
}

// ------------------------------------------------------------------ 공룡

function Trex() {
  this.config = TREX_CONFIG;
  this.xPos = TREX_CONFIG.START_X_POS;
  this.groundYPos = DEFAULT_DIMENSIONS.HEIGHT - TREX_CONFIG.HEIGHT - RUNNER_CONFIG.BOTTOM_PAD;
  this.minJumpHeight = this.groundYPos - TREX_CONFIG.MIN_JUMP_HEIGHT;
  this.reset();
}

Trex.collisionBoxes = TREX_COLLISION_BOXES;
Trex.config = TREX_CONFIG;

Trex.prototype.reset = function () {
  this.yPos = this.groundYPos;
  this.jumpVelocity = 0;
  this.jumping = false;
  this.ducking = false;
  this.speedDrop = false;
  this.reachedMinHeight = false;
  this.jumpCount = 0;
};

Trex.prototype.startJump = function (speed) {
  if (this.jumping) return;
  this.jumpVelocity = this.config.INITIAL_JUMP_VELOCITY - (speed / 10);
  this.jumping = true;
  this.reachedMinHeight = false;
  this.speedDrop = false;
};

Trex.prototype.endJump = function () {
  if (this.reachedMinHeight && this.jumpVelocity < this.config.DROP_VELOCITY) {
    this.jumpVelocity = this.config.DROP_VELOCITY;
  }
};

Trex.prototype.updateJump = function (deltaTime) {
  var msPerFrame = 1000 / FPS;
  var framesElapsed = deltaTime / msPerFrame;
  if (this.speedDrop) {
    this.yPos += Math.round(this.jumpVelocity * this.config.SPEED_DROP_COEFFICIENT * framesElapsed);
  } else {
    this.yPos += Math.round(this.jumpVelocity * framesElapsed);
  }
  this.jumpVelocity += this.config.GRAVITY * framesElapsed;

  if (this.yPos < this.minJumpHeight || this.speedDrop) this.reachedMinHeight = true;
  if (this.yPos < this.config.MAX_JUMP_HEIGHT || this.speedDrop) this.endJump();
  if (this.yPos > this.groundYPos) {
    this.reset();
    this.jumpCount++;
  }
};

Trex.prototype.setSpeedDrop = function () {
  this.speedDrop = true;
  this.jumpVelocity = 1;
};

Trex.prototype.setDuck = function (isDucking) {
  this.ducking = !!isDucking;
};

// ------------------------------------------------------------------ 장애물

function Obstacle(typeConfig, dimensions, gapCoefficient, speed, rnd) {
  this.typeConfig = typeConfig;
  this.gapCoefficient = gapCoefficient;
  this.size = randomNum(rnd, 1, RUNNER_CONFIG.MAX_OBSTACLE_LENGTH);
  this.remove = false;
  this.xPos = dimensions.WIDTH;
  this.yPos = 0;
  this.width = 0;
  this.speedOffset = 0;
  this.followingObstacleCreated = false;
  this.collisionBoxes = typeConfig.collisionBoxes.map(function (b) {
    return box(b.x, b.y, b.width, b.height);
  });

  if (this.size > 1 && this.typeConfig.multipleSpeed > speed) this.size = 1;
  this.width = this.typeConfig.width * this.size;

  if (Array.isArray(this.typeConfig.yPos)) {
    this.yPos = this.typeConfig.yPos[randomNum(rnd, 0, this.typeConfig.yPos.length - 1)];
  } else {
    this.yPos = this.typeConfig.yPos;
  }

  if (this.size > 1) {
    this.collisionBoxes[1].width =
      this.width - this.collisionBoxes[0].width - this.collisionBoxes[2].width;
    this.collisionBoxes[2].x = this.width - this.collisionBoxes[2].width;
  }

  if (this.typeConfig.speedOffset) {
    this.speedOffset = rnd() > 0.5 ? this.typeConfig.speedOffset : -this.typeConfig.speedOffset;
  }

  this.gap = this.getGap(this.gapCoefficient, speed, rnd);
}

Obstacle.prototype.getGap = function (gapCoefficient, speed, rnd) {
  var minGap = Math.round(this.width * speed + this.typeConfig.minGap * gapCoefficient);
  var maxGap = Math.round(minGap * MAX_GAP_COEFFICIENT);
  return randomNum(rnd, minGap, maxGap);
};

Obstacle.prototype.isVisible = function () { return this.xPos + this.width > 0; };

Obstacle.prototype.update = function (deltaTime, speed) {
  if (this.remove) return;
  if (this.typeConfig.speedOffset) speed += this.speedOffset;
  this.xPos -= Math.floor((speed * FPS / 1000) * deltaTime);
  if (!this.isVisible()) this.remove = true;
};

function randomNum(rnd, min, max) {
  return Math.floor(rnd() * (max - min + 1)) + min;
}

// ------------------------------------------------------------------ 지평선

function Horizon(dimensions, gapCoefficient, rnd) {
  this.dimensions = dimensions;
  this.gapCoefficient = gapCoefficient;
  this.rnd = rnd;
  this.obstacles = [];
  this.obstacleHistory = [];
  this.autoSpawn = true;      // 테스트에서 끄면 spawn() 으로 넣은 장애물만 나온다
}

Horizon.prototype.reset = function () {
  this.obstacles = [];
  this.obstacleHistory = [];
};

Horizon.prototype.update = function (deltaTime, currentSpeed, updateObstacles) {
  if (updateObstacles) this.updateObstacles(deltaTime, currentSpeed);
};

Horizon.prototype.updateObstacles = function (deltaTime, currentSpeed) {
  var updated = this.obstacles.slice(0);
  for (var i = 0; i < this.obstacles.length; i++) {
    var obstacle = this.obstacles[i];
    obstacle.update(deltaTime, currentSpeed);
    if (obstacle.remove) updated.shift();
  }
  this.obstacles = updated;

  if (!this.autoSpawn) return;

  if (this.obstacles.length > 0) {
    var last = this.obstacles[this.obstacles.length - 1];
    if (last && !last.followingObstacleCreated && last.isVisible() &&
      (last.xPos + last.width + last.gap) < this.dimensions.WIDTH) {
      this.addNewObstacle(currentSpeed);
      last.followingObstacleCreated = true;
    }
  } else {
    this.addNewObstacle(currentSpeed);
  }
};

Horizon.prototype.duplicateObstacleCheck = function (nextType) {
  var duplicateCount = 0;
  for (var i = 0; i < this.obstacleHistory.length; i++) {
    duplicateCount = this.obstacleHistory[i] === nextType ? duplicateCount + 1 : 0;
  }
  return duplicateCount >= RUNNER_CONFIG.MAX_OBSTACLE_DUPLICATION;
};

Horizon.prototype.addNewObstacle = function (currentSpeed) {
  for (var guard = 0; guard < 100; guard++) {
    var type = OBSTACLE_TYPES[randomNum(this.rnd, 0, OBSTACLE_TYPES.length - 1)];
    if (this.duplicateObstacleCheck(type.type) || currentSpeed < type.minSpeed) continue;
    this.obstacles.push(new Obstacle(type, this.dimensions, this.gapCoefficient, currentSpeed, this.rnd));
    this.obstacleHistory.unshift(type.type);
    if (this.obstacleHistory.length > 1) {
      this.obstacleHistory.splice(RUNNER_CONFIG.MAX_OBSTACLE_DUPLICATION);
    }
    return;
  }
};

// ------------------------------------------------------------------ 러너

/**
 * Runner.instance_ 와 같은 표면을 가진 시뮬레이터.
 * step() 한 번이 게임 한 프레임이다.
 */
function SimRunner(options) {
  options = options || {};
  this.rnd = makeRandom(options.seed != null ? options.seed : 1);
  this.config = RUNNER_CONFIG;
  this.dimensions = DEFAULT_DIMENSIONS;
  this.msPerFrame = 1000 / FPS;
  this.distanceMeter = { config: { COEFFICIENT: 0.025 } };
  this.tRex = new Trex();
  this.horizon = new Horizon(this.dimensions, RUNNER_CONFIG.GAP_COEFFICIENT, this.rnd);
  this.startSpeed = options.speed != null ? options.speed : RUNNER_CONFIG.SPEED;
  if (options.autoSpawn === false) this.horizon.autoSpawn = false;
  this.acceleration = options.acceleration != null ? options.acceleration : RUNNER_CONFIG.ACCELERATION;
  this.frames = 0;
  this.playing = false;
  this.crashed = false;
  this.currentSpeed = this.startSpeed;
  this.distanceRan = 0;
  this.runningTime = 0;
  this.playCount = 0;
  this.deaths = 0;
}

SimRunner.prototype.getScore = function () {
  return Math.round(this.distanceRan * this.distanceMeter.config.COEFFICIENT);
};

SimRunner.prototype.restart = function () {
  this.playCount++;
  this.runningTime = 0;
  this.playing = true;
  this.crashed = false;
  this.distanceRan = 0;
  this.currentSpeed = this.startSpeed;
  this.horizon.reset();
  this.tRex.reset();
};

SimRunner.prototype.gameOver = function () {
  this.playing = false;
  this.crashed = true;
  this.deaths++;
};

SimRunner.prototype.onKeyDown = function (e) {
  if (e.target !== undefined && e.target === this.detailsButton) return;
  var code = String(e.keyCode);
  if (!this.crashed && (code === '38' || code === '32')) {
    if (!this.playing) this.playing = true;
    if (!this.tRex.jumping && !this.tRex.ducking) this.tRex.startJump(this.currentSpeed);
  }
  if (this.playing && !this.crashed && code === '40') {
    if (this.tRex.jumping) this.tRex.setSpeedDrop();
    else if (!this.tRex.ducking) this.tRex.setDuck(true);
  }
};

SimRunner.prototype.onKeyUp = function (e) {
  var code = String(e.keyCode);
  if (this.playing && !this.crashed && (code === '38' || code === '32')) {
    this.tRex.endJump();
  } else if (code === '40') {
    this.tRex.speedDrop = false;
    this.tRex.setDuck(false);
  }
};

/** 한 프레임 진행. 죽으면 false 를 돌려준다. */
SimRunner.prototype.step = function (deltaTime) {
  deltaTime = deltaTime || this.msPerFrame;
  if (!this.playing) return !this.crashed;

  this.frames++;
  if (this.tRex.jumping) this.tRex.updateJump(deltaTime);

  this.runningTime += deltaTime;
  var hasObstacles = this.runningTime > this.config.CLEAR_TIME;
  this.horizon.update(deltaTime, this.currentSpeed, hasObstacles);

  var collision = hasObstacles && checkForCollision(this.horizon.obstacles[0], this.tRex);
  if (!collision) {
    this.distanceRan += this.currentSpeed * deltaTime / this.msPerFrame;
    if (this.currentSpeed < this.config.MAX_SPEED) this.currentSpeed += this.acceleration;
  } else {
    this.gameOver();
    return false;
  }
  return true;
};

/** 테스트에서 특정 장애물만 강제로 배치하고 싶을 때 사용한다. */
SimRunner.prototype.spawn = function (typeName, opts) {
  opts = opts || {};
  var typeConfig = OBSTACLE_TYPES.filter(function (t) { return t.type === typeName; })[0];
  if (!typeConfig) throw new Error('알 수 없는 장애물: ' + typeName);
  var obstacle = new Obstacle(typeConfig, this.dimensions, this.config.GAP_COEFFICIENT,
    this.currentSpeed, this.rnd);
  if (opts.size != null) {
    obstacle.size = opts.size;
    obstacle.width = typeConfig.width * opts.size;
    obstacle.collisionBoxes = typeConfig.collisionBoxes.map(function (b) {
      return box(b.x, b.y, b.width, b.height);
    });
    if (opts.size > 1) {
      obstacle.collisionBoxes[1].width =
        obstacle.width - obstacle.collisionBoxes[0].width - obstacle.collisionBoxes[2].width;
      obstacle.collisionBoxes[2].x = obstacle.width - obstacle.collisionBoxes[2].width;
    }
  }
  if (opts.yPos != null) obstacle.yPos = opts.yPos;
  if (opts.xPos != null) obstacle.xPos = opts.xPos;
  if (opts.speedOffset != null) obstacle.speedOffset = opts.speedOffset;
  obstacle.followingObstacleCreated = true;   // 뒤따르는 장애물 자동 생성 방지
  this.horizon.obstacles.push(obstacle);
  return obstacle;
};

/** 전역에 Runner/Trex 를 심어 봇이 실제 게임처럼 읽게 한다. */
SimRunner.prototype.install = function (target) {
  var g = target || globalThis;
  g.Runner = { instance_: this, config: RUNNER_CONFIG };
  g.Trex = Trex;
  return this;
};

module.exports = {
  SimRunner: SimRunner,
  Trex: Trex,
  Obstacle: Obstacle,
  OBSTACLE_TYPES: OBSTACLE_TYPES,
  RUNNER_CONFIG: RUNNER_CONFIG,
  TREX_CONFIG: TREX_CONFIG,
  checkForCollision: checkForCollision,
  makeRandom: makeRandom,
  FPS: FPS
};
