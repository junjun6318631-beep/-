"""화면 인식 봇 전체 흐름 검증 (화면 캡처만 가짜로 바꿔 끼운다).

시뮬레이터의 상태를 실제 게임과 같은 그림으로 그린 다음,
그 그림을 화면 인식 → 판단 → 키 입력 순서로 통과시켜 다시 시뮬레이터에 넣는다.
즉 배율 계산, 장애물 읽기, 속도 추정, 공룡 상태 추적까지 한 번에 확인한다.

실행: python3 -m unittest discover python/tests
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:
    import numpy as np
except ImportError:                                   # pragma: no cover
    np = None

from dino_bot import policy
from sim.dino_sim import SimRunner

if np is not None:
    from dino_bot import vision
    from dino_bot.main import (DinoModel, apply_decision, still_overlapping,
                                sync_dino_from_screen, update_hidden)
    from test_vision import CANVAS_LEFT, CANVAS_TOP, crop_region, render

FRAME_MS = 1000.0 / 60.0


def frame_of(sim: SimRunner, scale: float):
    """시뮬레이터의 현재 상태를 게임 화면처럼 그린다."""
    obstacles = [
        policy.Obstacle(x=o.x_pos, y=o.y_pos, w=o.width, h=o.config["height"])
        for o in sim.obstacles
    ]
    dino_y = sim.trex.y_pos
    if sim.trex.ducking:                       # 숙이면 납작해진다
        dino_y = policy.GROUND_Y + policy.DINO_HEIGHT - 25
    return render(scale=scale, obstacles=obstacles, dino_y=dino_y, page_text=True)


class FakeKeyboard:
    """키 입력을 시뮬레이터로 그대로 넘긴다."""

    def __init__(self, sim: SimRunner):
        self.sim = sim
        self.down_held = False
        self.jumps = 0

    def jump(self):
        self.jumps += 1
        self.sim.press_jump()

    def hold_down(self):
        self.down_held = True
        self.sim.press_duck()

    def release_down(self):
        self.down_held = False
        self.sim.release_duck()

    def retap_down(self):
        self.release_down()
        self.hold_down()


def play_through_screen(seed=1, frames=1500, scale=1.0, speed=6.0,
                        auto_spawn=True, setup=None):
    """화면 인식 봇을 시뮬레이터에 붙여 돌린다."""
    sim = SimRunner(seed=seed, speed=speed, auto_spawn=auto_spawn)
    sim.playing = True
    if setup:
        setup(sim)
    calib = vision.calibrate(frame_of(sim, scale))
    cfg = policy.Config()
    dino = DinoModel()
    keyboard = FakeKeyboard(sim)
    tracker = vision.BlobTracker()
    hidden_state = {"hidden": [], "visible": []}
    seen = {"jumped": False, "ducked": False}

    for f in range(frames):
        observation = vision.observe(crop_region(frame_of(sim, scale), calib), calib)
        speed_now = tracker.update(observation.blobs, f * FRAME_MS)
        obstacles = update_hidden(hidden_state,
                                  vision.to_obstacles(observation.blobs, speed_now),
                                  speed_now, 1.0)
        dino.advance(1.0)
        sync_dino_from_screen(dino, observation, 1.0)

        state = policy.GameState(speed=speed_now, obstacles=obstacles, dino=dino.state)
        decision = policy.decide(state, cfg)
        if (keyboard.down_held and not dino.state.jumping
                and decision.action not in (policy.DUCK, policy.DROP)
                and still_overlapping(obstacles)):
            decision = policy.Decision(policy.DUCK)
        apply_decision(decision, keyboard, dino, speed_now)

        if sim.trex.jumping:
            seen["jumped"] = True
        if sim.trex.ducking:
            seen["ducked"] = True
        if not sim.step():
            break
    return sim, seen, tracker


@unittest.skipIf(np is None, "numpy 가 없어 통합 테스트를 건너뜁니다")
class TestScreenToKeys(unittest.TestCase):
    def test_화면만_보고_오래_달린다(self):
        for seed in (1, 2, 3):
            sim, _, _ = play_through_screen(seed=seed, frames=1800, scale=1.0)
            self.assertFalse(sim.crashed,
                             f"시드 {seed}: {sim.frames}프레임에서 충돌 (점수 {sim.score()})")

    def test_배율_2배_화면에서도_달린다(self):
        sim, _, _ = play_through_screen(seed=2, frames=900, scale=2.0)
        self.assertFalse(sim.crashed, f"{sim.frames}프레임에서 충돌")

    def test_빠른_속도에서도_화면만_보고_달린다(self):
        sim, seen, _ = play_through_screen(seed=4, frames=1200, scale=1.0, speed=12.0)
        self.assertFalse(sim.crashed, f"{sim.frames}프레임에서 충돌")
        self.assertTrue(seen["jumped"])

    def test_속도를_화면에서_제대로_잰다(self):
        # 게임은 장애물을 한 프레임에 floor(속도) 픽셀만 옮기므로, 화면으로 잰 속도는
        # 실제 값보다 최대 1 작게 나온다. 판단에 쓰는 이동량 계산도 같은 내림을 쓰니
        # 예측은 어긋나지 않는다.
        sim, _, tracker = play_through_screen(seed=1, frames=600, scale=1.0, speed=10.0)
        self.assertAlmostEqual(tracker.speed, sim.current_speed, delta=1.1)
        self.assertLessEqual(tracker.speed, sim.current_speed + 0.2)

    def test_가운데_높이의_새를_화면만_보고_숙여서_지나간다(self):
        def setup(sim):
            sim.running_time = 1e9
            sim.spawn("PTERODACTYL", y_pos=75, x_pos=600, speed_offset=0.0)
        sim, seen, _ = play_through_screen(seed=3, frames=200, scale=1.0, speed=9.0,
                                           auto_spawn=False, setup=setup)
        self.assertFalse(sim.crashed)
        self.assertTrue(seen["ducked"], "숙여서 지나가야 한다")
        self.assertFalse(seen["jumped"], "점프하면 안 된다")

    def test_낮게_나는_새를_화면만_보고_뛰어넘는다(self):
        def setup(sim):
            sim.running_time = 1e9
            sim.spawn("PTERODACTYL", y_pos=100, x_pos=600, speed_offset=0.0)
        sim, seen, _ = play_through_screen(seed=3, frames=200, scale=1.0, speed=9.0,
                                           auto_spawn=False, setup=setup)
        self.assertFalse(sim.crashed)
        self.assertTrue(seen["jumped"], "뛰어넘어야 한다")

    def test_높이_나는_새는_화면만_보고_그냥_지나간다(self):
        def setup(sim):
            sim.running_time = 1e9
            sim.spawn("PTERODACTYL", y_pos=50, x_pos=600, speed_offset=0.0)
        sim, seen, _ = play_through_screen(seed=3, frames=200, scale=1.0, speed=9.0,
                                           auto_spawn=False, setup=setup)
        self.assertFalse(sim.crashed)
        self.assertFalse(seen["jumped"])
        self.assertFalse(seen["ducked"])


if __name__ == "__main__":
    unittest.main()


@unittest.skipIf(np is None, "numpy 가 없어 통합 테스트를 건너뜁니다")
class TestMainLoop(unittest.TestCase):
    """실행 진입점(main.run)이 화면 캡처만 가짜로 바꿔도 끝까지 도는지 확인한다."""

    def test_실행_루프가_게임을_찾아_플레이한다(self):
        import unittest.mock as mock
        from dino_bot import main as main_module

        sim = SimRunner(seed=5, speed=7.0)
        sim.playing = True
        scale = 1.0
        keyboards = []

        def fake_grabber():
            def grab(area=None):
                frame = frame_of(sim, scale)
                sim.step()                       # 캡처할 때마다 게임이 한 프레임 진행
                if area is None:
                    return frame
                return frame[area["top"]:area["top"] + area["height"],
                             area["left"]:area["left"] + area["width"]]
            return grab, lambda: None

        def fake_keyboard(dry_run=False):
            keyboard = FakeKeyboard(sim)
            keyboards.append(keyboard)
            return keyboard

        with mock.patch.object(main_module.vision, "make_grabber", fake_grabber), \
             mock.patch.object(main_module, "Keyboard", fake_keyboard):
            code = main_module.main(["--duration", "1.5", "--fps", "60"])

        self.assertEqual(code, 0)
        self.assertGreater(sim.frames, 50, "게임이 진행되어야 한다")
        self.assertTrue(keyboards, "키보드가 만들어져야 한다")
        self.assertGreater(keyboards[0].jumps, 0, "장애물을 만나면 뛰어야 한다")

    def test_보정_모드는_인식_결과만_출력한다(self):
        import unittest.mock as mock
        from dino_bot import main as main_module

        sim = SimRunner(seed=5)
        sim.playing = True

        def fake_grabber():
            def grab(area=None):
                frame = frame_of(sim, 1.0)
                if area is None:
                    return frame
                return frame[area["top"]:area["top"] + area["height"],
                             area["left"]:area["left"] + area["width"]]
            return grab, lambda: None

        with mock.patch.object(main_module.vision, "make_grabber", fake_grabber), \
             mock.patch.object(main_module, "save_pgm", lambda *a: None):
            code = main_module.main(["--calibrate"])
        self.assertEqual(code, 0)
        self.assertEqual(sim.frames, 0, "보정 모드는 게임을 건드리지 않는다")
