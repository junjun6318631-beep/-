"""화면 인식 봇의 판단 로직 검증.

크롬 원본 물리를 옮긴 시뮬레이터에 policy 를 붙여 돌린다.
실제 화면 대신 시뮬레이터의 값을 "관측값"으로 넘겨 주며,
필요하면 관측 오차와 틱 누락을 섞어 실제 캡처 환경을 흉내 낸다.

실행: python3 -m unittest discover python/tests
"""

from __future__ import annotations

import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dino_bot import policy
from sim.dino_sim import SimRunner


def observe(sim: SimRunner, rnd=None, x_noise: float = 0.0) -> policy.GameState:
    """시뮬레이터 상태를 '화면에서 잰 값'처럼 변환한다 (사각형 정보만)."""
    obstacles = []
    for o in sim.obstacles:
        x = o.x_pos
        if x_noise and rnd is not None:
            x += rnd.uniform(-x_noise, x_noise)
        obstacles.append(policy.Obstacle(
            x=x, y=o.y_pos, w=o.width, h=o.config["height"], speed_offset=o.speed_offset))
    trex = sim.trex
    dino = policy.DinoState(
        y=trex.y_pos, vel=trex.jump_velocity, jumping=trex.jumping,
        ducking=trex.ducking, speed_drop=trex.speed_drop,
        reached_min_height=trex.reached_min_height)
    return policy.GameState(speed=sim.current_speed, obstacles=obstacles, dino=dino)


def play(seed=1, frames=20000, speed=6.0, cfg=None, auto_spawn=True,
         setup=None, x_noise=0.0, lag=0.0, until=None):
    """봇을 붙여 게임을 돌리고 결과를 돌려준다."""
    cfg = cfg or policy.Config()
    sim = SimRunner(seed=seed, speed=speed, auto_spawn=auto_spawn)
    rnd = random.Random(seed * 977 + 13)
    if setup:
        setup(sim)
    seen = {"jumped": False, "ducked": False}
    down_held = False
    for _ in range(frames):
        if not sim.playing and not sim.crashed:
            sim.press_jump()
        if not lag or rnd.random() > lag:
            decision = policy.decide(observe(sim, rnd, x_noise), cfg)
            want_down = decision.action in (policy.DUCK, policy.DROP)
            if not want_down and down_held:
                sim.release_duck()
                down_held = False
            elif want_down and not down_held:
                sim.press_duck()
                down_held = True
            elif (want_down and decision.action == policy.DUCK
                  and not sim.trex.ducking and not sim.trex.jumping):
                sim.release_duck()
                sim.press_duck()
            if decision.action == policy.JUMP:
                sim.press_jump()
        if sim.trex.jumping:
            seen["jumped"] = True
        if sim.trex.ducking:
            seen["ducked"] = True
        if not sim.step():
            break
        if until and until(sim):
            break
    return sim, seen


def single(type_name, speed=9.0, **spawn):
    def setup(sim):
        sim.playing = True
        sim.running_time = 1e9          # 장애물 판정 활성화
        sim.spawn(type_name, **spawn)
    return play(seed=3, frames=400, speed=speed, auto_spawn=False, setup=setup,
                until=lambda s: not s.obstacles)


class TestSurvival(unittest.TestCase):
    def test_기본_속도에서_오래_달린다(self):
        for seed in (1, 2, 3, 4, 5):
            sim, _ = play(seed=seed, frames=20000)
            self.assertFalse(sim.crashed,
                             f"시드 {seed}: {sim.frames}프레임에서 충돌 (점수 {sim.score()})")
            self.assertEqual(sim.frames, 20000)

    def test_최고_속도로_시작해도_살아남는다(self):
        for seed in (1, 2, 3):
            sim, _ = play(seed=seed, frames=15000, speed=13.0)
            self.assertFalse(sim.crashed, f"시드 {seed}: {sim.frames}프레임에서 충돌")

    def test_속도가_최고치까지_올라간다(self):
        sim, _ = play(seed=1, frames=20000)
        self.assertGreaterEqual(sim.current_speed, 13.0)


class TestObstacles(unittest.TestCase):
    def test_선인장은_크기와_속도에_상관없이_넘는다(self):
        for speed in (6.0, 9.0, 13.0):
            for size in (1, 2, 3):
                for name in ("CACTUS_SMALL", "CACTUS_LARGE"):
                    sim, seen = single(name, speed=speed, size=size, x_pos=600)
                    self.assertFalse(sim.crashed, f"{name} size{size} @speed{speed} 충돌")
                    self.assertTrue(seen["jumped"], f"{name} size{size} @speed{speed} 점프 안 함")

    def test_낮게_나는_새는_뛰어넘는다(self):
        for speed in (9.0, 13.0):
            sim, seen = single("PTERODACTYL", speed=speed, y_pos=100, x_pos=600, speed_offset=0.0)
            self.assertFalse(sim.crashed, f"speed {speed} 충돌")
            self.assertTrue(seen["jumped"], "점프해야 한다")

    def test_가운데_높이의_새는_숙여서_지나간다(self):
        for speed in (9.0, 13.0):
            sim, seen = single("PTERODACTYL", speed=speed, y_pos=75, x_pos=600, speed_offset=0.0)
            self.assertFalse(sim.crashed, f"speed {speed} 충돌")
            self.assertTrue(seen["ducked"], "숙여야 한다")
            self.assertFalse(seen["jumped"], "점프하면 안 된다")

    def test_높이_나는_새는_그냥_달린다(self):
        for speed in (9.0, 13.0):
            sim, seen = single("PTERODACTYL", speed=speed, y_pos=50, x_pos=600, speed_offset=0.0)
            self.assertFalse(sim.crashed, f"speed {speed} 충돌")
            self.assertFalse(seen["jumped"], "점프할 필요가 없다")
            self.assertFalse(seen["ducked"], "숙일 필요가 없다")

    def test_붙어_나오는_선인장_두_개도_처리한다(self):
        for gap in (180, 220, 260, 300, 360):
            def setup(sim, gap=gap):
                sim.playing = True
                sim.running_time = 1e9
                sim.spawn("CACTUS_LARGE", size=1, x_pos=600)
                sim.spawn("CACTUS_LARGE", size=1, x_pos=600 + gap)
            sim, _ = play(seed=3, frames=500, speed=11.0, auto_spawn=False, setup=setup,
                          until=lambda s: not s.obstacles)
            self.assertFalse(sim.crashed, f"간격 {gap}px에서 충돌")


class TestRobustness(unittest.TestCase):
    def test_관측_오차가_있어도_살아남는다(self):
        for seed in (1, 2, 3):
            sim, _ = play(seed=seed, frames=20000, x_noise=3.0)
            self.assertFalse(sim.crashed,
                             f"시드 {seed}: 오차 ±3px에서 {sim.frames}프레임에 충돌")

    def test_틱이_밀려도_살아남는다(self):
        cfg = policy.Config(lag_frames=2.0)      # 두 프레임에 한 번꼴로 본다고 알려 준다
        for seed in (1, 2, 3):
            sim, _ = play(seed=seed, frames=20000, lag=0.4, cfg=cfg)
            self.assertFalse(sim.crashed,
                             f"시드 {seed}: 틱 누락 40%에서 {sim.frames}프레임에 충돌")

    def test_오차와_누락이_동시에_있어도_살아남는다(self):
        cfg = policy.Config(lag_frames=2.0)
        for seed in (1, 2, 3, 4):
            sim, _ = play(seed=seed, frames=20000, x_noise=3.0, lag=0.25, cfg=cfg)
            self.assertFalse(sim.crashed, f"시드 {seed}: {sim.frames}프레임에서 충돌")


class TestDecisionRules(unittest.TestCase):
    def test_멀리_있는_장애물에는_기다린다(self):
        state = policy.GameState(speed=6.0, obstacles=[policy.Obstacle(x=450, y=90, w=25, h=50)])
        self.assertEqual(policy.decide(state, policy.Config()).action, policy.WAIT)

    def test_가까워지면_점프한다(self):
        cfg = policy.Config()
        jumped_at = None
        for x in range(400, 60, -1):
            state = policy.GameState(speed=6.0, obstacles=[policy.Obstacle(x=x, y=90, w=25, h=50)])
            if policy.decide(state, cfg).action == policy.JUMP:
                jumped_at = x
                break
        self.assertIsNotNone(jumped_at, "언젠가는 점프해야 한다")
        self.assertLess(jumped_at, 260, "너무 일찍 뛴다")
        self.assertGreater(jumped_at, 110, "너무 늦게 뛴다")

    def test_장애물이_없으면_그냥_달린다(self):
        state = policy.GameState(speed=6.0, obstacles=[])
        self.assertEqual(policy.decide(state, policy.Config()).action, policy.RUN)

    def test_새_높이별_통과_가능_판정(self):
        cfg = policy.Config()
        high = policy.Obstacle(x=300, y=50, w=46, h=40)
        mid = policy.Obstacle(x=300, y=75, w=46, h=40)
        low = policy.Obstacle(x=300, y=100, w=46, h=40)
        cactus = policy.Obstacle(x=300, y=90, w=25, h=50)
        self.assertTrue(policy.passable_on_ground(high, False, cfg), "높은 새는 서서 통과")
        self.assertFalse(policy.passable_on_ground(mid, False, cfg), "가운데 새는 서서 못 지나감")
        self.assertTrue(policy.passable_on_ground(mid, True, cfg), "가운데 새는 숙이면 통과")
        self.assertFalse(policy.passable_on_ground(low, True, cfg), "낮은 새는 숙여도 못 지나감")
        self.assertFalse(policy.passable_on_ground(cactus, True, cfg), "선인장은 숙여도 못 지나감")

    def test_마진_자동_보정(self):
        cfg = policy.Config(margin=6.0)
        policy.tune_margin(cfg, score=100)          # 금방 죽었다 → 넓힌다
        self.assertGreater(cfg.margin, 6.0)
        wide = cfg.margin
        policy.tune_margin(cfg, score=5000)         # 오래 달렸다 → 좁힌다
        self.assertLess(cfg.margin, wide)

    def test_마진은_한계를_넘지_않는다(self):
        cfg = policy.Config(margin=6.0)
        for _ in range(50):
            policy.tune_margin(cfg, score=0)
        self.assertLessEqual(cfg.margin, cfg.margin_max)
        for _ in range(50):
            policy.tune_margin(cfg, score=99999)
        self.assertGreaterEqual(cfg.margin, cfg.margin_min)


if __name__ == "__main__":
    unittest.main()
