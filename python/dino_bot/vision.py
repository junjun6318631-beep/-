"""화면에서 다이노 게임을 찾아 읽는다.

- 게임 영역(캔버스)과 지평선을 자동으로 찾고
- 화면 픽셀 크기를 게임 단위(캔버스 600x150 기준)로 바꾸는 배율을 구하고
- 공룡 오른쪽부터 장애물 사각형을 훑어 policy 가 쓸 값으로 돌려준다.
- 밤 모드(배경이 검게 반전)도 자동으로 처리한다.

numpy 와 mss 는 실제로 화면을 볼 때만 필요하므로 함수 안에서 가져온다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

from .policy import CANVAS_HEIGHT, DINO_HEIGHT, DINO_WIDTH, DINO_X, GROUND_Y, HORIZON_Y, Obstacle

# 게임 단위 기준 값
DINO_TOP_TO_HORIZON = HORIZON_Y - GROUND_Y      # 34: 공룡 머리 끝 ~ 지평선
SCAN_TOP = 30.0                                  # 이 위쪽은 점수판이라 보지 않는다
SKY_BOTTOM = 88.0                                # 여기 위쪽은 하늘 (구름·달·별)
SCAN_BOTTOM = HORIZON_Y - 1.0                    # 지평선 자체는 읽지 않는다
GROUND_BOTTOM = 88.0                             # 여기보다 아래까지 그려지면 진짜 장애물
BG_SPEED_RATIO = 0.55                            # 게임 속도의 이 비율 미만이면 배경
DINO_FEET = GROUND_Y + DINO_HEIGHT               # 140
SCAN_FROM = DINO_X + 59 + 3                      # 숙인 공룡(가로 59) 오른쪽부터 훑는다


class CalibrationError(RuntimeError):
    """게임 화면을 찾지 못했을 때."""


@dataclass
class Calibration:
    left: int                 # 캔버스 왼쪽 (화면 절대 좌표)
    right: int                # 캔버스 오른쪽
    ground_row: int           # 지평선 윗줄 (화면 절대 좌표)
    scale: float              # 화면 픽셀 / 게임 단위
    night: bool = False

    @property
    def region(self) -> dict:
        """이후 캡처에 쓸 영역 (mss 형식)."""
        top = int(self.ground_row - round((HORIZON_Y - SCAN_TOP + 6) * self.scale))
        height = int(round((HORIZON_Y - SCAN_TOP + 10) * self.scale))
        return {"left": int(self.left), "top": max(0, top),
                "width": int(self.right - self.left + 1), "height": height}

    def game_y(self, row_abs: int) -> float:
        return (row_abs - self.ground_row) / self.scale + HORIZON_Y


@dataclass
class Blob:
    """화면에서 본 물체 하나 (게임 단위)."""

    x: float
    right: float
    top: float
    bottom: float
    sky: bool = False               # 하늘 구간에서 찾은 것인가
    speed: Optional[float] = None   # 추적으로 잰 이동 속도 (게임 단위/프레임)
    seen: int = 1
    w_max: float = 0.0
    top_min: float = 0.0
    bottom_max: float = 0.0

    @property
    def w(self) -> float:
        return self.right - self.x + 1


@dataclass
class Observation:
    blobs: List[Blob]
    dino_top: Optional[float] = None        # 게임 단위 y (못 찾으면 None)
    dino_bottom: Optional[float] = None
    dino_on_ground: bool = False            # 공룡 자리 그림이 땅까지 닿아 있는가


# ---------------------------------------------------------------- 캡처

def make_grabber(region: Optional[dict] = None):
    """(grab, close) 를 돌려준다. grab() 은 회색조 2차원 배열."""
    import numpy as np
    import mss

    sct = mss.mss()

    def grab(area: Optional[dict] = None):
        shot = sct.grab(area or region or sct.monitors[1])
        arr = np.asarray(shot)                      # BGRA
        # 다이노 게임은 흑백이라 한 채널만 봐도 충분하다.
        return arr[:, :, 1]

    return grab, sct.close


def ink_mask(gray, threshold: int = 40):
    """배경과 다른 픽셀(=글씨/그림)을 True 로 만든 마스크와 밤 모드 여부."""
    import numpy as np

    background = float(np.median(gray))
    night = background < 128
    if night:
        return gray > background + threshold, True
    return gray < background - threshold, False


# ---------------------------------------------------------------- 보정(캘리브레이션)

def find_ground_row(mask) -> Tuple[int, int, int]:
    """지평선(가로로 가장 길게 이어진 얇은 선)의 줄과 좌우 끝을 찾는다."""
    import numpy as np

    counts = mask.sum(axis=1)
    if counts.max() < 50:
        raise CalibrationError("화면에서 지평선을 찾지 못했습니다. 게임이 보이는 상태인가요?")

    order = np.argsort(counts)[::-1][:40]
    best = None
    for row in order:
        row = int(row)
        if counts[row] < counts.max() * 0.5:
            break
        above = counts[max(0, row - 3)]
        # 지평선은 '얇은' 선이다: 바로 위쪽은 거의 비어 있어야 한다.
        if above > counts[row] * 0.35:
            continue
        best = row
        break
    if best is None:
        best = int(order[0])

    # 지평선은 두께가 있다. 항상 그 '맨 윗줄'을 기준으로 삼아야 게임 좌표가 맞는다.
    while best > 0 and counts[best - 1] >= counts[best] * 0.8:
        best -= 1

    cols = np.flatnonzero(mask[best])
    if cols.size < 50:
        raise CalibrationError("지평선의 좌우 끝을 찾지 못했습니다.")
    return best, int(cols[0]), int(cols[-1])


def find_dino(mask, ground_row: int, left: int, right: int) -> Tuple[int, int, int]:
    """공룡의 (위쪽 줄, 왼쪽 열, 오른쪽 열).

    지평선 바로 위에 붙어 있는 물체 중 가장 왼쪽 것이 공룡이다.
    (장애물은 항상 공룡보다 오른쪽에 있고, 페이지의 안내 문구는 땅에 닿지 않는다.)
    """
    import numpy as np

    span = right - left
    search_right = left + max(30, int(span * 0.25))
    strip_height = max(2, int(round(span / 600 * 3)))
    strip = mask[max(0, ground_row - strip_height):ground_row, left:search_right + 1]
    cols = np.flatnonzero(strip.any(axis=0))
    if cols.size == 0:
        raise CalibrationError(
            "땅 위에 서 있는 공룡을 찾지 못했습니다. "
            "공룡이 점프 중이 아닌 순간에 다시 시도하세요.")
    if cols.size > (search_right - left + 1) * 0.6:
        raise CalibrationError(
            "지평선 위치를 잘못 잡은 것 같습니다. --region 으로 게임 영역을 직접 "
            "지정하거나 화면에 다른 가로줄이 없도록 정리한 뒤 다시 시도하세요.")

    start = int(cols[0])
    end = start
    for c in cols[1:]:
        if int(c) - end > 3:
            break
        end = int(c)

    # 다리에서 위로 올라가며 빈 줄이 나올 때까지가 공룡의 높이다.
    row = ground_row - 1
    while row > 0 and mask[row, left + start:left + end + 1].any():
        row -= 1
    top = row + 1

    # 몸통까지 포함한 좌우 끝을 다시 잰다.
    body = mask[top:ground_row, left:search_right + 1]
    body_cols = np.flatnonzero(body.any(axis=0))
    lo = hi = None
    for c in body_cols:
        c = int(c)
        if lo is None:
            lo = hi = c
        elif c - hi <= 3:
            hi = c
        elif hi >= start:
            break
        else:
            lo = hi = c
    if lo is None:
        lo, hi = start, end
    return top, left + lo, left + hi


def calibrate(gray) -> Calibration:
    """전체 화면 이미지 하나로 게임 위치와 배율을 알아낸다."""
    mask, night = ink_mask(gray)
    ground_row, left, right = find_ground_row(mask)
    dino_top, dino_left, dino_right = find_dino(mask, ground_row, left, right)

    scale = (ground_row - dino_top) / DINO_TOP_TO_HORIZON
    width_scale = (dino_right - dino_left + 1) / DINO_WIDTH
    if scale > 0 and abs(width_scale - scale) / scale > 0.35:
        raise CalibrationError(
            f"공룡 크기가 맞지 않습니다 (높이 기준 {scale:.2f}, 너비 기준 {width_scale:.2f}). "
            "공룡이 점프하거나 숙이지 않은 순간에 다시 시도하세요.")
    if not (0.3 <= scale <= 8):
        raise CalibrationError(
            f"배율이 이상합니다 ({scale:.2f}). --scale 로 직접 지정하거나 "
            "게임 화면만 보이도록 정리한 뒤 다시 시도하세요.")

    # 공룡 왼쪽 끝은 게임 단위로 x=50 이어야 한다. 캔버스 왼쪽을 이 값으로 보정한다.
    canvas_left = dino_left - DINO_X * scale
    if abs(canvas_left - left) > 40 * scale:
        canvas_left = left      # 어긋나면 지평선 왼쪽 끝을 믿는다
    return Calibration(left=int(round(canvas_left)), right=int(right),
                       ground_row=int(ground_row), scale=scale, night=night)


# ---------------------------------------------------------------- 관측

def _band_blobs(mask, gap: int, top_offset: float, scale: float, sky: bool,
                from_unit: float = 0.0):
    """한 구간(밴드)에서 열 묶음을 뽑는다. 게임 단위 좌표로 돌려준다."""
    import numpy as np

    if mask.size == 0:
        return []
    any_col = mask.any(axis=0)
    cols = np.flatnonzero(any_col)
    if cols.size == 0:
        return []
    first = mask.argmax(axis=0)
    last = mask.shape[0] - 1 - mask[::-1].argmax(axis=0)

    blobs = []
    splits = np.flatnonzero(np.diff(cols) > gap + 1)
    for group in np.split(cols, splits + 1):
        if group.size == 0:
            continue
        x0, x1 = int(group[0]), int(group[-1])
        top = top_offset + float(first[group].min()) / scale
        bottom = top_offset + float(last[group].max()) / scale
        blob = Blob(x=x0 / scale + from_unit, right=x1 / scale + from_unit,
                    top=top, bottom=bottom, sky=sky)
        blob.w_max = blob.w
        blob.top_min = blob.top
        blob.bottom_max = blob.bottom
        blobs.append(blob)
    return blobs


def observe(frame, calib: Calibration) -> Observation:
    """캡처한 게임 영역에서 물체와 공룡 위치를 읽는다.

    하늘 구간과 땅 구간을 따로 훑는다. 구름·달·별은 절대 땅 구간까지 내려오지 않으므로,
    이렇게 나눠 보면 구름 밑으로 선인장이 지나가도 하나로 뭉치지 않는다.
    """
    import numpy as np

    mask, night = ink_mask(frame)
    calib.night = night
    height = frame.shape[0]
    region_top = calib.region["top"]
    scale = calib.scale

    def row_of(game_y: float) -> int:
        return int(round(calib.ground_row + (game_y - HORIZON_Y) * scale)) - region_top

    sky_top = max(0, row_of(SCAN_TOP))
    split_row = max(sky_top, min(height, row_of(SKY_BOTTOM)))
    ground_bottom = min(height, row_of(SCAN_BOTTOM) + 1)
    if ground_bottom <= sky_top:
        return Observation([])

    dino_c0 = max(0, int(round(DINO_X * scale)))
    dino_c1 = max(1, int(round((DINO_X + DINO_WIDTH) * scale)))
    scan_c0 = int(round(SCAN_FROM * scale))

    # 공룡 — 자리(x 50~94)에서 가장 아래쪽까지 이어진 그림을 본다.
    dino_top = dino_bottom = None
    dino_on_ground = False
    dino_slice = mask[sky_top:ground_bottom, dino_c0:dino_c1]
    if dino_slice.any():
        rows = np.flatnonzero(dino_slice.any(axis=1))
        dino_top = SCAN_TOP + float(rows[0]) / scale
        dino_bottom = SCAN_TOP + float(rows[-1]) / scale
        foot_rows = max(1, int(round(2 * scale)))
        dino_on_ground = bool(dino_slice[-foot_rows:].any())

    gap = max(2, int(round(3 * scale)))
    sky = _band_blobs(mask[sky_top:split_row, scan_c0:], gap, SCAN_TOP, scale,
                      True, SCAN_FROM)
    ground = _band_blobs(mask[split_row:ground_bottom, scan_c0:], gap, SKY_BOTTOM, scale,
                         False, SCAN_FROM)

    # 하늘과 땅에 걸쳐 있는 물체(가운데 높이의 새)는 하나로 잇는다.
    merged = []
    for blob in ground:
        for other in sky:
            if other.right < blob.x - 2 or other.x > blob.right + 2:
                continue
            if other.bottom < SKY_BOTTOM - 2:
                continue                     # 하늘 위쪽에 따로 떠 있는 것 (구름 등)
            blob.x = min(blob.x, other.x)
            blob.right = max(blob.right, other.right)
            blob.top = min(blob.top, other.top)
            merged.append(other)
        blob.top_min = blob.top
        blob.bottom_max = blob.bottom
        blob.w_max = blob.w
    blobs = ground + [b for b in sky if b not in merged]
    blobs.sort(key=lambda b: b.x)
    return Observation(blobs, dino_top, dino_bottom, dino_on_ground)


class BlobTracker:
    """물체를 프레임 사이로 추적해 이동 속도를 잰다.

    구름은 게임 속도의 0.2배, 달 0.25배, 별 0.3배로 움직인다. 진짜 장애물은 1.0배
    (익룡만 ±0.8)이므로 속도만 봐도 배경을 걸러낼 수 있다.
    """

    def __init__(self, initial: float = 6.0, lo: float = 5.0, hi: float = 14.0):
        self.speed = initial
        self.lo = lo
        self.hi = hi
        self.prev: List[Blob] = []
        self.last_ms: Optional[float] = None

    def update(self, blobs: List[Blob], now_ms: float,
               min_x: float = SCAN_FROM, max_x: float = 598.0) -> float:
        frames = 1.0
        if self.last_ms is not None:
            frames = (now_ms - self.last_ms) / (1000.0 / 60.0)
            if not (0.05 < frames < 12):
                frames = 1.0
        self.last_ms = now_ms

        fastest = 0.0
        for blob in blobs:
            at_edge = blob.x <= min_x or blob.right >= max_x
            best = None
            best_error = float("inf")
            for prev in self.prev:
                edge = at_edge or prev.x <= min_x or prev.right >= max_x
                if not edge and abs(prev.w - blob.w) > max(8.0, prev.w * 0.6):
                    continue
                if blob.top > prev.bottom + 8 or blob.bottom < prev.top - 8:
                    continue
                expected = self.speed if prev.speed is None else prev.speed
                error = abs((prev.x - expected * frames) - blob.x)
                if error < best_error:
                    best_error = error
                    best = prev
            if best is not None and best_error <= 10:
                blob.seen = best.seen + 1
                blob.w_max = max(blob.w, best.w_max)
                blob.top_min = min(blob.top, best.top_min)
                blob.bottom_max = max(blob.bottom, best.bottom_max)
                clipped = (blob.x <= min_x or blob.right >= max_x
                           or best.x <= min_x or best.right >= max_x)
                dx = (best.x - blob.x) / frames
                if not clipped and -1 <= dx <= 20:
                    blob.speed = dx if best.speed is None else best.speed * 0.6 + dx * 0.4
                else:
                    blob.speed = best.speed
            if blob.seen > 1 and blob.speed is not None and blob.speed > fastest:
                fastest = blob.speed

        if fastest >= 4:
            self.speed += (fastest - self.speed) * 0.3
        self.speed = max(self.lo, min(self.hi, self.speed))
        self.prev = blobs
        return self.speed

    def reset(self, speed: Optional[float] = None) -> None:
        self.prev = []
        self.last_ms = None
        if speed is not None:
            self.speed = speed


def to_obstacles(blobs: List[Blob], speed: float) -> List[Obstacle]:
    """물체 중 진짜 장애물만 policy 가 쓰는 형태로 바꾼다.

    땅 가까이까지 내려온 것은 무조건 장애물로 본다(구름·달·별은 거기까지 오지 않는다).
    하늘에만 있는 것은 게임 속도에 가깝게 움직일 때만 장애물로 본다(높이 나는 익룡).
    """
    obstacles = []
    for blob in blobs:
        reaches_ground = blob.bottom >= GROUND_BOTTOM
        moves = (blob.seen > 1 and blob.speed is not None
                 and blob.speed >= speed * BG_SPEED_RATIO)
        if not reaches_ground and not moves:
            continue
        bottom = DINO_FEET if blob.bottom >= SCAN_BOTTOM - 2 else blob.bottom
        obstacles.append(Obstacle(x=blob.x, y=blob.top, w=blob.w,
                                  h=max(2.0, bottom - blob.top)))
    return obstacles


class SpeedEstimator:
    """장애물이 프레임마다 얼마나 왼쪽으로 움직이는지로 게임 속도를 잰다."""

    def __init__(self, initial: float = 6.0, lo: float = 5.0, hi: float = 14.0):
        self.speed = initial
        self.lo = lo
        self.hi = hi
        self._last: Optional[Tuple[float, float]] = None     # (x, 시각 ms)

    def update(self, obstacles: Sequence[Obstacle], now_ms: float) -> float:
        target = None
        for o in obstacles:
            if o.right > DINO_X:
                target = o
                break
        if target is None:
            self._last = None
            return self.speed
        if self._last is not None:
            prev_x, prev_ms = self._last
            frames = (now_ms - prev_ms) / (1000.0 / 60.0)
            moved = prev_x - target.x
            # 장애물이 바뀌면(다음 장애물로 넘어가면) 값이 튄다 — 그런 프레임은 버린다.
            if 0 < frames < 6 and 0 < moved < 20 * frames:
                measured = moved / frames
                if self.lo <= measured <= self.hi:
                    self.speed += (measured - self.speed) * 0.25
        self._last = (target.x, now_ms)
        return self.speed

    def reset(self, speed: Optional[float] = None) -> None:
        self._last = None
        if speed is not None:
            self.speed = speed


def render_ascii(obstacles, speed: float, action: str, width: int = 70) -> str:
    """--debug 에서 터미널에 보여 줄 한 줄 요약."""
    line = ["."] * width
    for o in obstacles:
        start = int(o.x / 600 * width)
        end = int(o.right / 600 * width)
        mark = "^" if o.bottom < DINO_FEET - 2 else "#"
        for i in range(max(0, start), min(width, max(end, start + 1))):
            line[i] = mark
    d = int(DINO_X / 600 * width)
    if 0 <= d < width:
        line[d] = "D"
    return f"[{''.join(line)}] {speed:5.2f} {action}"
