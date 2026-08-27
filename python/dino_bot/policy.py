"""다이노 게임 판단 로직.

화면 인식으로 얻은 값(속도, 장애물 위치/크기)만 가지고
"지금 뛰면 넘는가 / 조금 더 기다려도 넘는가"를 게임 물리로 예측해
달리기 / 숙이기 / 점프 / 빠른 착지를 고른다.

콘솔용 JS 봇(js/dino-bot.js)과 같은 규칙이며, 표준 라이브러리만 쓴다.
좌표는 크롬 원본과 같은 "게임 단위"(캔버스 600x150 기준, y는 아래로 증가).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Iterable, List, Optional, Sequence, Tuple

# ---------------------------------------------------------------- 게임 상수
FPS = 60
GRAVITY = 0.6
INITIAL_JUMP_VELOCITY = -10.0
DROP_VELOCITY = -5.0
SPEED_DROP_COEFFICIENT = 3.0
MAX_JUMP_HEIGHT = 30.0          # yPos 가 이 값보다 작아지면 상승이 멈춘다
MIN_JUMP_HEIGHT = 30.0
DINO_X = 50.0
DINO_WIDTH = 44.0
DINO_HEIGHT = 47.0
GROUND_Y = 93.0                 # 서 있을 때 공룡 박스의 위쪽 y
CANVAS_HEIGHT = 150.0
HORIZON_Y = 127.0               # 지평선(땅 선) 위쪽 y
DEFAULT_MAX_SPEED = 13.0
DEFAULT_ACCELERATION = 0.001

# 크롬 원본의 공룡 충돌 박스 (공룡 박스 좌상단 기준 상대 좌표)
TREX_BOXES_RUNNING: Sequence[Tuple[float, float, float, float]] = (
    (22, 0, 17, 16), (1, 18, 30, 9), (10, 35, 14, 8),
    (1, 24, 29, 5), (5, 30, 21, 4), (9, 34, 15, 4),
)
TREX_BOXES_DUCKING: Sequence[Tuple[float, float, float, float]] = ((1, 18, 55, 25),)

DINO_BOX_BOTTOM = 1 + max(by + bh for _, by, _, bh in TREX_BOXES_RUNNING)   # 44

CLEAR = "clear"     # 목표 장애물을 무사히 넘긴다
CRASH = "crash"     # 부딪힌다
EARLY = "early"     # 장애물이 오기 전에 착지한다 (= 아직 뛸 때가 아니다)

RUN = "run"
DUCK = "duck"
JUMP = "jump"
WAIT = "wait"
DROP = "drop"
AIR = "air"


def js_round(value: float) -> int:
    """JS 의 Math.round 와 같은 반올림(.5 는 위로)."""
    return math.floor(value + 0.5)


@dataclass
class Obstacle:
    """화면에서 측정한 장애물 하나 (게임 단위)."""

    x: float                 # 왼쪽 끝
    y: float                 # 위쪽 끝 (작을수록 높이 떠 있다)
    w: float
    h: float
    speed_offset: float = 0.0

    @property
    def right(self) -> float:
        return self.x + self.w

    @property
    def bottom(self) -> float:
        return self.y + self.h


@dataclass
class DinoState:
    y: float = GROUND_Y
    vel: float = 0.0
    jumping: bool = False
    ducking: bool = False
    speed_drop: bool = False
    reached_min_height: bool = False


@dataclass
class GameState:
    speed: float                              # 게임 단위 / 프레임
    obstacles: List[Obstacle] = field(default_factory=list)
    dino: DinoState = field(default_factory=DinoState)
    acceleration: float = DEFAULT_ACCELERATION
    max_speed: float = DEFAULT_MAX_SPEED


@dataclass
class Config:
    margin: float = 6.0            # 가로 안전 마진(px) — 죽으면 넓히고 잘 달리면 좁힌다
    margin_min: float = 2.0
    margin_max: float = 24.0
    margin_on_crash: float = 2.0
    margin_on_good_run: float = 1.0
    margin_y: float = 2.0          # 세로 마진은 작게 (새 밑으로 숙여 지나가는 판단을 막지 않도록)
    margin_frames: float = 1.0     # 속도 × 이 값만큼 가로 마진을 더한다
    lag_frames: float = 1.0        # 실제 측정된 틱 간격(프레임)
    max_lag_frames: float = 6.0
    reaction_frames: int = 4       # 이만큼 더 기다려도 넘을 수 있으면 아직 기다린다
    horizon_frames: int = 150
    lookahead: bool = True
    speed_drop: bool = True
    # 화면에서 잰 사각형은 실제 충돌 영역보다 크다. 특히 새는 날개까지 사각형에
    # 들어가 있어서, 그대로 쓰면 "숙여서 지나갈 수 있는 새"를 못 지나간다고 본다.
    # 땅에 닿지 않는(=떠 있는) 장애물에만 원본 충돌 박스에 맞춰 안쪽으로 줄인다.
    flying_inset_top: float = 8.0
    flying_inset_bottom: float = 6.0


@dataclass
class Plan:
    jump_at: Optional[int] = None
    duck: bool = False
    drop_at: Optional[int] = None


@dataclass
class Decision:
    action: str
    frames: int = 0
    desperate: bool = False


# ---------------------------------------------------------------- 기하 계산

def _overlap(ax, ay, aw, ah, bx, by, bw, bh) -> bool:
    return ax < bx + bw and ax + aw > bx and ay < by + bh and ay + ah > by


def _obstacle_rect(obstacle: Obstacle, cfg: Config) -> Tuple[float, float, float, float]:
    """충돌 판정에 쓸 장애물 사각형 (떠 있는 장애물은 안쪽으로 줄인다)."""
    top, bottom = obstacle.y + 1, obstacle.bottom - 1
    if obstacle.bottom < GROUND_Y + DINO_HEIGHT - 2:      # 땅에 닿지 않는다 = 날고 있다
        top += cfg.flying_inset_top
        bottom -= cfg.flying_inset_bottom
        if bottom <= top:
            bottom = top + 1
    return obstacle.x + 1, top, obstacle.w - 2, bottom - top


def _hits(dino: DinoState, obstacle: Obstacle, cfg: Config, mx: float, my: float) -> bool:
    """공룡과 장애물이 부딪히는가. 장애물 쪽만 마진만큼 넓게 본다."""
    dino_x, dino_y = DINO_X + 1, dino.y + 1
    dino_w, dino_h = DINO_WIDTH - 2, DINO_HEIGHT - 2
    rx, ry, rw, rh = _obstacle_rect(obstacle, cfg)
    ox, oy = rx - mx, ry - my
    ow, oh = rw + 2 * mx, rh + 2 * my
    if not _overlap(dino_x, dino_y, dino_w, dino_h, ox, oy, ow, oh):
        return False
    boxes = TREX_BOXES_DUCKING if dino.ducking else TREX_BOXES_RUNNING
    for bx, by, bw, bh in boxes:
        if _overlap(dino_x + bx, dino_y + by, bw, bh, ox, oy, ow, oh):
            return True
    return False


def passable_on_ground(obstacle: Obstacle, ducking: bool, cfg: Config) -> bool:
    """땅에 있는 공룡이 이 장애물 아래로 그냥 지나갈 수 있는가 (세로 겹침만 본다)."""
    boxes = TREX_BOXES_DUCKING if ducking else TREX_BOXES_RUNNING
    top = GROUND_Y + 1
    _, ry, _, rh = _obstacle_rect(obstacle, cfg)
    obs_top = ry - cfg.margin_y
    obs_bottom = ry + rh + cfg.margin_y
    for _, by, _, bh in boxes:
        d_top = top + by
        if d_top < obs_bottom and d_top + bh > obs_top:
            return False
    return True


# ---------------------------------------------------------------- 물리 예측

def start_jump(dino: DinoState, speed: float) -> None:
    dino.jumping = True
    dino.vel = INITIAL_JUMP_VELOCITY - speed / 10.0
    dino.reached_min_height = False
    dino.speed_drop = False
    dino.ducking = False


def step_dino(dino: DinoState) -> None:
    """Trex.updateJump() 를 프레임 단위로 그대로 옮긴 것."""
    if not dino.jumping:
        return
    if dino.speed_drop:
        dino.y += js_round(dino.vel * SPEED_DROP_COEFFICIENT)
    else:
        dino.y += js_round(dino.vel)
    dino.vel += GRAVITY
    if dino.y < GROUND_Y - MIN_JUMP_HEIGHT or dino.speed_drop:
        dino.reached_min_height = True
    if dino.y < MAX_JUMP_HEIGHT or dino.speed_drop:
        if dino.reached_min_height and dino.vel < DROP_VELOCITY:
            dino.vel = DROP_VELOCITY
    if dino.y > GROUND_Y:
        dino.y = GROUND_Y
        dino.jumping = False
        dino.speed_drop = False
        dino.vel = 0.0


def obstacle_step(speed: float, offset: float) -> int:
    """한 프레임에 장애물이 왼쪽으로 움직이는 거리 (원본과 같은 내림 처리)."""
    return math.floor(((speed + offset) * FPS / 1000.0) * (1000.0 / FPS))


def frames_to_clear(obstacle: Obstacle, speed: float, cfg: Config) -> int:
    """땅에서 지금 뛰면 몇 프레임 뒤에 이 장애물 위로 올라서는가."""
    dino = DinoState()
    start_jump(dino, speed)
    obs_top = _obstacle_rect(obstacle, cfg)[1]
    for f in range(1, 40):
        step_dino(dino)
        if dino.y + DINO_BOX_BOTTOM < obs_top:
            return f
        if not dino.jumping:
            break
    return 40


def can_still_react(obstacle: Obstacle, speed: float, cfg: Config, extra: float) -> bool:
    """땅에 내려선 지금, 이 장애물을 넘을 시간이 남아 있는가."""
    distance = obstacle.x - (DINO_X + DINO_WIDTH)
    needed = frames_to_clear(obstacle, speed, cfg) * speed + extra
    return distance >= needed


def nearest_index(state: GameState) -> int:
    """아직 지나가지 않은, 신경 써야 할 가장 가까운 장애물."""
    for i, obstacle in enumerate(state.obstacles):
        if obstacle.right > DINO_X:
            return i
    return -1


def simulate(state: GameState, plan: Plan, cfg: Config) -> Tuple[str, int]:
    """plan 대로 조작했을 때 어떻게 되는지 예측한다. (결과, 프레임 수)"""
    ti = nearest_index(state)
    if ti < 0:
        return CLEAR, 0

    dino = replace(state.dino)
    dino.ducking = plan.duck and not state.dino.jumping
    obs = [replace(o) for o in state.obstacles]
    target = obs[ti]
    speed = state.speed
    mx = cfg.margin + state.speed * max(cfg.margin_frames, cfg.lag_frames)
    my = cfg.margin_y
    jump_started = dino.jumping
    dino_right = DINO_X + DINO_WIDTH

    # 점프(와 공중에 떠 있는 상태)는 약 35프레임을 묶어두는 결정이므로,
    # 목표를 처리한 뒤 다음 장애물까지 감당되는지 한 단계 더 본다.
    verify = cfg.lookahead and (
        plan.jump_at is not None or plan.drop_at is not None or state.dino.jumping
    )
    phase = 0
    phase2_mode = ""
    was_early = False
    auto_duck = False

    for f in range(cfg.horizon_frames):
        if plan.jump_at == f and not dino.jumping and not dino.ducking:
            start_jump(dino, speed)
            jump_started = True
        if auto_duck and not dino.jumping:
            dino.ducking = True
        if plan.drop_at == f and dino.jumping:
            dino.speed_drop = True           # 아래키: 속도를 1로 두고 3배로 낙하
            dino.vel = 1.0

        step_dino(dino)
        for o in obs:
            o.x -= obstacle_step(speed, o.speed_offset)
        if speed < state.max_speed:
            speed += state.acceleration

        for o in obs:
            if o.right < DINO_X - 20:
                continue
            if o.x > dino_right + 40:
                break
            if _hits(dino, o, cfg, mx, my):
                return CRASH, f

        passed = target.right < DINO_X
        landed_early = jump_started and not dino.jumping and target.x > dino_right

        if phase == 1:
            ok = (EARLY if was_early else CLEAR), f
            if passed:
                return ok                    # 확인 단계 목표까지 넘겼다
            if phase2_mode == "jump" and not dino.jumping:
                # 땅에 내려섰다 — 이 장애물을 다시 뛰어넘을 시간이 남았는가
                return ok if can_still_react(target, speed, cfg, mx) else (CRASH, f)
            if landed_early:
                return ok                    # 여유 있게 착지했다
            continue

        if not passed and not landed_early:
            continue

        if not verify:
            return (EARLY if (landed_early and not passed) else CLEAR), f

        if passed:
            nxt = None
            for o in obs:
                if o is not target and o.right > DINO_X:
                    nxt = o
                    break
            if nxt is None:
                return CLEAR, f
            target = nxt                     # 다음 장애물을 감당할 수 있는가
        else:
            was_early = True                 # 같은 장애물을 다시 상대해야 한다

        phase = 1
        jump_started = False
        dino.ducking = False
        auto_duck = False
        if passable_on_ground(target, False, cfg):
            phase2_mode = "run"              # 그냥 달려서 지나갈 수 있다
        elif passable_on_ground(target, True, cfg):
            phase2_mode = "duck"
            auto_duck = True
            if not dino.jumping:
                dino.ducking = True
        else:
            phase2_mode = "jump"             # 뛰어야 넘는다
            if not dino.jumping:
                if can_still_react(target, speed, cfg, mx):
                    return (EARLY if was_early else CLEAR), f
                return CRASH, f

    return (EARLY if was_early else CLEAR), cfg.horizon_frames


# ---------------------------------------------------------------- 판단

def decide(state: GameState, cfg: Config) -> Decision:
    """이번 프레임에 무엇을 할지 고른다."""
    if nearest_index(state) < 0:
        return Decision(RUN)

    # 이미 공중이면 할 수 있는 건 빠른 착지뿐이다.
    if state.dino.jumping:
        if state.dino.speed_drop:
            return Decision(DROP)            # 아래키를 계속 누르고 있어야 유지된다
        if not cfg.speed_drop:
            return Decision(AIR)
        stay, frames = simulate(state, Plan(), cfg)
        if stay != CRASH:
            return Decision(AIR, frames)
        drop, drop_frames = simulate(state, Plan(drop_at=0), cfg)
        if drop == CRASH:
            return Decision(AIR, frames)
        return Decision(DROP, drop_frames)

    run, run_frames = simulate(state, Plan(), cfg)
    if run == CLEAR:
        return Decision(RUN, run_frames)

    duck, duck_frames = simulate(state, Plan(duck=True), cfg)
    if duck == CLEAR:
        return Decision(DUCK, duck_frames)

    later, _ = simulate(state, Plan(jump_at=cfg.reaction_frames + 1), cfg)
    if later == CLEAR:
        return Decision(WAIT, run_frames)

    now, now_frames = simulate(state, Plan(jump_at=0), cfg)
    if now == CLEAR:
        return Decision(JUMP, now_frames)
    if now == EARLY:
        return Decision(WAIT, run_frames)

    # 지금 뛰어도 부딪힌다. 그 사이 어느 순간에 뛰면 되는 경우가 있으니 확인한다.
    # (앞 장애물은 늦게, 뒤 장애물은 일찍 뛰어야 해서 넘길 수 있는 순간이 좁을 때가 있다.)
    for delay in range(1, cfg.reaction_frames + 1):
        if simulate(state, Plan(jump_at=delay), cfg)[0] == CLEAR:
            return Decision(WAIT, run_frames)

    # 여유가 있으면 다음 프레임에 다시 본다.
    if run_frames > cfg.reaction_frames + 2:
        return Decision(WAIT, run_frames)

    # 정말 늦었다. 그래도 뛰는 편이 서 있는 것보다 낫다.
    return Decision(JUMP, run_frames, desperate=True)


def tune_margin(cfg: Config, score: float, good_run_score: float = 500.0) -> float:
    """죽었을 때 안전 마진을 자동으로 조절한다."""
    if score >= good_run_score:
        cfg.margin = max(cfg.margin_min, cfg.margin - cfg.margin_on_good_run)
    else:
        cfg.margin = min(cfg.margin_max, cfg.margin + cfg.margin_on_crash)
    return cfg.margin
