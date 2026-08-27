"""크롬 공룡 게임 시뮬레이터 (테스트 전용, 표준 라이브러리만).

js/sim/dino-sim.js 와 같은 원본 물리·장애물 생성·충돌 판정을 파이썬으로 옮겼다.
화면 인식 봇의 판단 로직(dino_bot.policy)을 브라우저 없이 검증하는 데 쓴다.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import List, Optional

FPS = 60
MS_PER_FRAME = 1000.0 / FPS
WIDTH = 600
HEIGHT = 150

ACCELERATION = 0.001
CLEAR_TIME = 3000
GAP_COEFFICIENT = 0.6
MAX_GAP_COEFFICIENT = 1.5
MAX_OBSTACLE_LENGTH = 3
MAX_OBSTACLE_DUPLICATION = 2
MAX_SPEED = 13.0
START_SPEED = 6.0
BOTTOM_PAD = 10

GRAVITY = 0.6
INITIAL_JUMP_VELOCITY = -10.0
DROP_VELOCITY = -5.0
SPEED_DROP_COEFFICIENT = 3.0
MAX_JUMP_HEIGHT = 30.0
MIN_JUMP_HEIGHT = 30.0
TREX_WIDTH = 44
TREX_HEIGHT = 47
START_X_POS = 50

TREX_BOXES_RUNNING = [
    (22, 0, 17, 16), (1, 18, 30, 9), (10, 35, 14, 8),
    (1, 24, 29, 5), (5, 30, 21, 4), (9, 34, 15, 4),
]
TREX_BOXES_DUCKING = [(1, 18, 55, 25)]

OBSTACLE_TYPES = {
    "CACTUS_SMALL": dict(
        width=17, height=35, y_pos=[105], multiple_speed=4, min_gap=120, min_speed=0,
        speed_offset=0.0, boxes=[(0, 7, 5, 27), (4, 0, 6, 34), (10, 4, 7, 14)],
    ),
    "CACTUS_LARGE": dict(
        width=25, height=50, y_pos=[90], multiple_speed=7, min_gap=120, min_speed=0,
        speed_offset=0.0, boxes=[(0, 12, 7, 38), (8, 0, 7, 49), (13, 10, 10, 38)],
    ),
    "PTERODACTYL": dict(
        width=46, height=40, y_pos=[100, 75, 50], multiple_speed=999, min_gap=150,
        min_speed=8.5, speed_offset=0.8,
        boxes=[(15, 15, 16, 5), (21, 24, 6, 6), (1, 22, 13, 4), (4, 18, 8, 6), (10, 15, 8, 13)],
    ),
}
TYPE_ORDER = ["CACTUS_SMALL", "CACTUS_LARGE", "PTERODACTYL"]


def js_round(value: float) -> int:
    return math.floor(value + 0.5)


class Random:
    """재현 가능한 난수 (mulberry32) — JS 시뮬과 같은 수열."""

    def __init__(self, seed: int = 1):
        self.a = seed & 0xFFFFFFFF

    def random(self) -> float:
        self.a = (self.a + 0x6D2B79F5) & 0xFFFFFFFF
        t = self.a
        t = ((t ^ (t >> 15)) * (1 | t)) & 0xFFFFFFFF
        t = (t + (((t ^ (t >> 7)) * (61 | t)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        t ^= t
        # 위 식은 JS 구현과 정확히 같지 않아도 된다 — 재현성만 있으면 충분하다.
        self.a = (self.a * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.a / 4294967296.0

    def num(self, low: int, high: int) -> int:
        return math.floor(self.random() * (high - low + 1)) + low


def boxes_overlap(a, b) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax < bx + bw and ax + aw > bx and ay < by + bh and ay + ah > by


@dataclass
class Trex:
    x_pos: float = START_X_POS
    ground_y_pos: float = HEIGHT - TREX_HEIGHT - BOTTOM_PAD
    y_pos: float = HEIGHT - TREX_HEIGHT - BOTTOM_PAD
    jump_velocity: float = 0.0
    jumping: bool = False
    ducking: bool = False
    speed_drop: bool = False
    reached_min_height: bool = False

    @property
    def min_jump_height(self) -> float:
        return self.ground_y_pos - MIN_JUMP_HEIGHT

    def reset(self) -> None:
        self.y_pos = self.ground_y_pos
        self.jump_velocity = 0.0
        self.jumping = False
        self.ducking = False
        self.speed_drop = False
        self.reached_min_height = False

    def start_jump(self, speed: float) -> None:
        if self.jumping:
            return
        self.jump_velocity = INITIAL_JUMP_VELOCITY - speed / 10.0
        self.jumping = True
        self.reached_min_height = False
        self.speed_drop = False

    def end_jump(self) -> None:
        if self.reached_min_height and self.jump_velocity < DROP_VELOCITY:
            self.jump_velocity = DROP_VELOCITY

    def set_speed_drop(self) -> None:
        self.speed_drop = True
        self.jump_velocity = 1.0

    def update_jump(self, delta_time: float) -> None:
        frames = delta_time / MS_PER_FRAME
        if self.speed_drop:
            self.y_pos += js_round(self.jump_velocity * SPEED_DROP_COEFFICIENT * frames)
        else:
            self.y_pos += js_round(self.jump_velocity * frames)
        self.jump_velocity += GRAVITY * frames
        if self.y_pos < self.min_jump_height or self.speed_drop:
            self.reached_min_height = True
        if self.y_pos < MAX_JUMP_HEIGHT or self.speed_drop:
            self.end_jump()
        if self.y_pos > self.ground_y_pos:
            self.reset()


@dataclass
class Obstacle:
    type_name: str
    x_pos: float
    y_pos: float
    width: float
    size: int
    boxes: List[tuple]
    gap: float
    speed_offset: float = 0.0
    following_created: bool = False
    remove: bool = False

    @property
    def config(self) -> dict:
        return OBSTACLE_TYPES[self.type_name]

    def is_visible(self) -> bool:
        return self.x_pos + self.width > 0

    def update(self, delta_time: float, speed: float) -> None:
        if self.remove:
            return
        if self.config["speed_offset"]:
            speed += self.speed_offset
        self.x_pos -= math.floor((speed * FPS / 1000.0) * delta_time)
        if not self.is_visible():
            self.remove = True


def make_obstacle(type_name: str, speed: float, rnd: Random,
                  size: Optional[int] = None, y_pos: Optional[float] = None,
                  x_pos: Optional[float] = None,
                  speed_offset: Optional[float] = None) -> Obstacle:
    cfg = OBSTACLE_TYPES[type_name]
    chosen_size = rnd.num(1, MAX_OBSTACLE_LENGTH) if size is None else size
    if chosen_size > 1 and cfg["multiple_speed"] > speed:
        chosen_size = 1
    width = cfg["width"] * chosen_size
    if y_pos is None:
        y_pos = cfg["y_pos"][rnd.num(0, len(cfg["y_pos"]) - 1)]
    boxes = [tuple(b) for b in cfg["boxes"]]
    if chosen_size > 1:
        b0, b1, b2 = boxes[0], boxes[1], boxes[2]
        boxes[1] = (b1[0], b1[1], width - b0[2] - b2[2], b1[3])
        boxes[2] = (width - b2[2], b2[1], b2[2], b2[3])
    offset = 0.0
    if cfg["speed_offset"]:
        offset = cfg["speed_offset"] if rnd.random() > 0.5 else -cfg["speed_offset"]
    if speed_offset is not None:
        offset = speed_offset
    min_gap = round(width * speed + cfg["min_gap"] * GAP_COEFFICIENT)
    gap = rnd.num(int(min_gap), int(round(min_gap * MAX_GAP_COEFFICIENT)))
    return Obstacle(
        type_name=type_name, x_pos=WIDTH if x_pos is None else x_pos, y_pos=y_pos,
        width=width, size=chosen_size, boxes=boxes, gap=gap, speed_offset=offset,
    )


def check_collision(obstacle: Optional[Obstacle], trex: Trex) -> bool:
    if obstacle is None:
        return False
    trex_box = (trex.x_pos + 1, trex.y_pos + 1, TREX_WIDTH - 2, TREX_HEIGHT - 2)
    obs_box = (obstacle.x_pos + 1, obstacle.y_pos + 1,
               obstacle.width - 2, obstacle.config["height"] - 2)
    if not boxes_overlap(trex_box, obs_box):
        return False
    trex_boxes = TREX_BOXES_DUCKING if trex.ducking else TREX_BOXES_RUNNING
    for tb in trex_boxes:
        adj_t = (trex_box[0] + tb[0], trex_box[1] + tb[1], tb[2], tb[3])
        for ob in obstacle.boxes:
            adj_o = (obs_box[0] + ob[0], obs_box[1] + ob[1], ob[2], ob[3])
            if boxes_overlap(adj_t, adj_o):
                return True
    return False


class SimRunner:
    """Runner 와 같은 표면을 가진 시뮬레이터. step() 한 번이 한 프레임."""

    def __init__(self, seed: int = 1, speed: float = START_SPEED,
                 auto_spawn: bool = True, acceleration: float = ACCELERATION):
        self.rnd = Random(seed)
        self.trex = Trex()
        self.obstacles: List[Obstacle] = []
        self.obstacle_history: List[str] = []
        self.auto_spawn = auto_spawn
        self.start_speed = speed
        self.current_speed = speed
        self.acceleration = acceleration
        self.distance_ran = 0.0
        self.running_time = 0.0
        self.frames = 0
        self.playing = False
        self.crashed = False
        self.deaths = 0

    # ------------------------------------------------------------ 입력
    def press_jump(self) -> None:
        if self.crashed:
            return
        self.playing = True
        if not self.trex.jumping and not self.trex.ducking:
            self.trex.start_jump(self.current_speed)

    def press_duck(self) -> None:
        if not self.playing or self.crashed:
            return
        if self.trex.jumping:
            self.trex.set_speed_drop()
        elif not self.trex.ducking:
            self.trex.ducking = True

    def release_duck(self) -> None:
        self.trex.speed_drop = False
        self.trex.ducking = False

    # ------------------------------------------------------------ 진행
    def score(self) -> int:
        return round(self.distance_ran * 0.025)

    def restart(self) -> None:
        self.playing = True
        self.crashed = False
        self.distance_ran = 0.0
        self.running_time = 0.0
        self.current_speed = self.start_speed
        self.obstacles = []
        self.obstacle_history = []
        self.trex.reset()

    def spawn(self, type_name: str, **kwargs) -> Obstacle:
        obstacle = make_obstacle(type_name, self.current_speed, self.rnd, **kwargs)
        obstacle.following_created = True
        self.obstacles.append(obstacle)
        return obstacle

    def _duplicate_check(self, next_type: str) -> bool:
        count = 0
        for t in self.obstacle_history:
            count = count + 1 if t == next_type else 0
        return count >= MAX_OBSTACLE_DUPLICATION

    def _add_obstacle(self) -> None:
        for _ in range(100):
            type_name = TYPE_ORDER[self.rnd.num(0, len(TYPE_ORDER) - 1)]
            cfg = OBSTACLE_TYPES[type_name]
            if self._duplicate_check(type_name) or self.current_speed < cfg["min_speed"]:
                continue
            self.obstacles.append(make_obstacle(type_name, self.current_speed, self.rnd))
            self.obstacle_history.insert(0, type_name)
            del self.obstacle_history[MAX_OBSTACLE_DUPLICATION:]
            return

    def _update_obstacles(self, delta_time: float) -> None:
        for obstacle in list(self.obstacles):
            obstacle.update(delta_time, self.current_speed)
        while self.obstacles and self.obstacles[0].remove:
            self.obstacles.pop(0)
        if not self.auto_spawn:
            return
        if self.obstacles:
            last = self.obstacles[-1]
            if (not last.following_created and last.is_visible()
                    and last.x_pos + last.width + last.gap < WIDTH):
                self._add_obstacle()
                last.following_created = True
        else:
            self._add_obstacle()

    def step(self, delta_time: float = MS_PER_FRAME) -> bool:
        """한 프레임 진행. 죽으면 False."""
        if not self.playing:
            return not self.crashed
        self.frames += 1
        if self.trex.jumping:
            self.trex.update_jump(delta_time)
        self.running_time += delta_time
        has_obstacles = self.running_time > CLEAR_TIME
        if has_obstacles:
            self._update_obstacles(delta_time)
        if has_obstacles and check_collision(
                self.obstacles[0] if self.obstacles else None, self.trex):
            self.playing = False
            self.crashed = True
            self.deaths += 1
            return False
        self.distance_ran += self.current_speed * delta_time / MS_PER_FRAME
        if self.current_speed < MAX_SPEED:
            self.current_speed += self.acceleration
        return True
