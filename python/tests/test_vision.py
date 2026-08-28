"""화면 인식 검증.

실제 화면 대신, 크롬 다이노 게임과 같은 구조의 그림을 만들어(배경/지평선/공룡/장애물)
게임 영역 자동 탐지, 배율 계산, 장애물 읽기, 밤 모드 반전이 맞는지 확인한다.

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

if np is not None:
    from dino_bot import vision

CANVAS_TOP = 200          # 화면에서 캔버스 위쪽 (게임 단위 y=0 위치)
CANVAS_LEFT = 120


def render(scale=2.0, obstacles=(), dino_y=policy.GROUND_Y, night=False,
           canvas_units=600, page_text=True, sky=True, clouds=((300, 40), (520, 62))):
    """다이노 게임 화면과 같은 구조의 그림을 만든다 (게임 단위 → 화면 픽셀)."""
    bg, ink = (16, 239) if night else (247, 83)
    width = int(CANVAS_LEFT * 2 + canvas_units * scale)
    height = int(CANVAS_TOP + policy.CANVAS_HEIGHT * scale + 120)
    frame = np.full((height, width), bg, dtype=np.uint8)

    def box(gx, gy, gw, gh, value=ink):
        x0 = int(round(CANVAS_LEFT + gx * scale))
        x1 = int(round(CANVAS_LEFT + (gx + gw) * scale))
        y0 = int(round(CANVAS_TOP + gy * scale))
        y1 = int(round(CANVAS_TOP + (gy + gh) * scale))
        frame[max(0, y0):max(0, y1), max(0, x0):max(0, x1)] = value

    if page_text:      # 캔버스 위쪽의 안내 문구 — 이것에 속으면 안 된다
        box(10, -40, 260, 14)
        box(10, -20, 180, 10)

    if sky:                                    # 구름·달·별 — 장애물로 오인하면 안 된다
        for cx, cy in clouds:
            box(cx, cy, 46, 14)
        box(180, 30, 20, 40)                   # 달
        box(120, 55, 9, 9)                     # 별
        box(430, 24, 9, 9)

    box(0, policy.HORIZON_Y, canvas_units, 2)                     # 지평선
    box(30, policy.HORIZON_Y + 4, 6, 2)                           # 땅 위 돌멩이
    box(410, policy.HORIZON_Y + 6, 9, 2)
    box(policy.DINO_X, dino_y, policy.DINO_WIDTH, policy.DINO_HEIGHT)   # 공룡
    for o in obstacles:
        box(o.x, o.y, o.w, o.h)
    return frame


def crop_region(frame, calib):
    r = calib.region
    return frame[r["top"]:r["top"] + r["height"], r["left"]:r["left"] + r["width"]]


@unittest.skipIf(np is None, "numpy 가 없어 화면 인식 테스트를 건너뜁니다")
class TestCalibration(unittest.TestCase):
    def test_배율과_지평선을_찾는다(self):
        for scale in (1.0, 1.5, 2.0, 3.0):
            frame = render(scale=scale)
            calib = vision.calibrate(frame)
            self.assertAlmostEqual(calib.scale, scale, delta=0.15 * scale,
                                   msg=f"배율 {scale} 인식 실패")
            expected_ground = CANVAS_TOP + policy.HORIZON_Y * scale
            self.assertAlmostEqual(calib.ground_row, expected_ground, delta=2 * scale)
            self.assertAlmostEqual(calib.left, CANVAS_LEFT, delta=3 * scale)
            self.assertFalse(calib.night)

    def test_캔버스가_넓어도_찾는다(self):
        frame = render(scale=2.0, canvas_units=1000)
        calib = vision.calibrate(frame)
        self.assertAlmostEqual(calib.scale, 2.0, delta=0.3)

    def test_밤_모드를_알아본다(self):
        frame = render(scale=2.0, night=True)
        calib = vision.calibrate(frame)
        self.assertTrue(calib.night)
        self.assertAlmostEqual(calib.scale, 2.0, delta=0.3)

    def test_게임이_없으면_알려_준다(self):
        frame = np.full((300, 400), 247, dtype=np.uint8)
        with self.assertRaises(vision.CalibrationError):
            vision.calibrate(frame)

    def test_공룡이_점프_중이면_보정을_거부한다(self):
        frame = render(scale=2.0, dino_y=20)      # 공중에 떠 있다
        with self.assertRaises(vision.CalibrationError):
            vision.calibrate(frame)


@unittest.skipIf(np is None, "numpy 가 없어 화면 인식 테스트를 건너뜁니다")
class TestObserve(unittest.TestCase):
    def _observe(self, obstacles, scale=2.0, night=False, speed=6.0):
        """한 장면을 읽어 (장애물 목록, 관측, 보정값) 을 돌려준다."""
        frame = render(scale=scale, obstacles=obstacles, night=night)
        calib = vision.calibrate(frame)
        observation = vision.observe(crop_region(frame, calib), calib)
        return vision.to_obstacles(observation.blobs, speed), observation, calib

    def test_선인장_위치와_크기를_읽는다(self):
        cactus = policy.Obstacle(x=300, y=105, w=17, h=35)      # 작은 선인장
        found_list, _, _ = self._observe([cactus])
        self.assertEqual(len(found_list), 1, "구름·달·별을 장애물로 세면 안 된다")
        found = found_list[0]
        self.assertAlmostEqual(found.x, 300, delta=3)
        self.assertAlmostEqual(found.w, 17, delta=3)
        self.assertAlmostEqual(found.y, 105, delta=3)
        # 땅에 붙은 장애물은 바닥까지 이어진 것으로 본다
        self.assertAlmostEqual(found.bottom, policy.GROUND_Y + policy.DINO_HEIGHT, delta=3)

    def test_큰_선인장_여러_개를_따로_읽는다(self):
        found, _, _ = self._observe([
            policy.Obstacle(x=250, y=90, w=25, h=50),
            policy.Obstacle(x=420, y=105, w=51, h=35),
        ])
        self.assertEqual(len(found), 2)
        self.assertAlmostEqual(found[0].x, 250, delta=3)
        self.assertAlmostEqual(found[1].x, 420, delta=3)
        self.assertAlmostEqual(found[1].w, 51, delta=4)

    def test_나는_새는_떠_있는_것으로_읽는다(self):
        for y in (50, 75):
            found_list, _, _ = self._observe([policy.Obstacle(x=350, y=y, w=46, h=40)])
            self.assertEqual(len(found_list), 1, f"y={y} 새를 못 찾음")
            found = found_list[0]
            self.assertAlmostEqual(found.y, y, delta=3)
            self.assertLess(found.bottom, policy.GROUND_Y + policy.DINO_HEIGHT - 5,
                            "떠 있는 장애물로 읽어야 한다")

    def test_읽은_값으로_새_높이_판단이_맞는다(self):
        cfg = policy.Config()
        found, _, _ = self._observe([policy.Obstacle(x=350, y=50, w=46, h=40)])
        self.assertTrue(policy.passable_on_ground(found[0], False, cfg),
                        "높이 나는 새는 서서 지나갈 수 있어야 한다")
        found, _, _ = self._observe([policy.Obstacle(x=350, y=75, w=46, h=40)])
        self.assertFalse(policy.passable_on_ground(found[0], False, cfg))
        self.assertTrue(policy.passable_on_ground(found[0], True, cfg),
                        "가운데 높이의 새는 숙이면 지나갈 수 있어야 한다")
        found, _, _ = self._observe([policy.Obstacle(x=350, y=100, w=46, h=40)])
        self.assertFalse(policy.passable_on_ground(found[0], True, cfg),
                         "낮게 나는 새는 숙여도 못 지나간다")

    def test_밤_모드에서도_똑같이_읽는다(self):
        cactus = policy.Obstacle(x=300, y=90, w=25, h=50)
        found, _, calib = self._observe([cactus], night=True)
        self.assertTrue(calib.night)
        self.assertEqual(len(found), 1)
        self.assertAlmostEqual(found[0].x, 300, delta=3)

    def test_공룡_높이를_읽는다(self):
        frame = render(scale=2.0, sky=False)
        calib = vision.calibrate(frame)
        obs = vision.observe(crop_region(frame, calib), calib)
        self.assertIsNotNone(obs.dino_top)
        self.assertAlmostEqual(obs.dino_top, policy.GROUND_Y, delta=3)

        frame = render(scale=2.0, dino_y=40, sky=False)          # 점프 중
        obs = vision.observe(crop_region(frame, calib), calib)
        self.assertAlmostEqual(obs.dino_top, 40, delta=3)

    def test_장애물이_없으면_빈_목록(self):
        found, _, _ = self._observe([])
        self.assertEqual(found, [], "하늘에 있는 것들은 장애물이 아니다")

    def test_배율이_달라도_같은_게임_좌표로_읽는다(self):
        cactus = policy.Obstacle(x=380, y=90, w=25, h=50)
        for scale in (1.0, 2.0, 3.0):
            found, _, _ = self._observe([cactus], scale=scale)
            self.assertEqual(len(found), 1, f"배율 {scale}")
            self.assertAlmostEqual(found[0].x, 380, delta=4, msg=f"배율 {scale}")


@unittest.skipIf(np is None, "numpy 가 없어 화면 인식 테스트를 건너뜁니다")
class TestTracker(unittest.TestCase):
    def _blob(self, x, top=90.0, bottom=126.0, w=25.0):
        b = vision.Blob(x=x, right=x + w - 1, top=top, bottom=bottom)
        b.w_max = b.w
        b.top_min = top
        b.bottom_max = bottom
        return b

    def test_물체_이동량으로_속도를_잰다(self):
        tracker = vision.BlobTracker(initial=6.0)
        x, now = 500.0, 0.0
        for _ in range(60):
            tracker.update([self._blob(x)], now)
            x -= 9.0
            now += 1000.0 / 60.0
        self.assertAlmostEqual(tracker.speed, 9.0, delta=0.5)

    def test_느리게_흐르는_구름은_장애물이_아니다(self):
        tracker = vision.BlobTracker(initial=9.0)
        cloud_x, cactus_x, now = 500.0, 400.0, 0.0
        obstacles = []
        for _ in range(20):
            cloud = self._blob(cloud_x, top=40.0, bottom=54.0, w=46.0)
            cloud.sky = True
            cactus = self._blob(cactus_x)
            speed = tracker.update([cactus, cloud], now)
            obstacles = vision.to_obstacles([cactus, cloud], speed)
            cloud_x -= 9.0 * 0.2          # 구름은 0.2배로 흐른다
            cactus_x -= 9.0
            now += 1000.0 / 60.0
        self.assertEqual(len(obstacles), 1, "구름을 장애물로 세면 안 된다")
        self.assertGreater(obstacles[0].bottom, 130)

    def test_높이_나는_새는_속도로_알아본다(self):
        tracker = vision.BlobTracker(initial=9.0)
        x, now = 500.0, 0.0
        obstacles = []
        for _ in range(10):
            bird = self._blob(x, top=50.0, bottom=85.0, w=46.0)   # 바닥에 안 닿는다
            bird.sky = True
            speed = tracker.update([bird], now)
            obstacles = vision.to_obstacles([bird], speed)
            x -= 9.0
            now += 1000.0 / 60.0
        self.assertEqual(len(obstacles), 1, "게임 속도로 움직이면 장애물이다")


if __name__ == "__main__":
    unittest.main()
