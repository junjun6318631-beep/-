"""화면에 떠 있는 크롬 다이노 게임을 대신 플레이한다.

    python3 -m dino_bot.main              # 자동으로 게임을 찾아 플레이
    python3 -m dino_bot.main --calibrate  # 인식 결과만 확인 (키 입력 없음)
    python3 -m dino_bot.main --debug      # 무엇을 보고 무엇을 하는지 실시간 출력

게임 창을 앞에 띄워 두고 실행하면, 화면을 캡처해 장애물을 읽고
스페이스/아래키를 눌러 준다. 창을 클릭해 게임에 포커스를 준 상태여야 한다.
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass
from typing import Optional

from . import policy, vision
from .keys import Keyboard

FRAME_MS = 1000.0 / 60.0


@dataclass
class DinoModel:
    """공룡의 상태를 게임 물리로 따라간다.

    화면에서 공룡의 y 를 매 프레임 정확히 재는 건 장애물과 겹칠 때 불안정해서,
    점프를 누른 시점부터 물리로 계산하고 '땅에 있다'는 것만 화면으로 확인한다.
    """

    state: policy.DinoState

    def __init__(self) -> None:
        self.state = policy.DinoState()
        self._pending = 0.0

    def jump(self, speed: float) -> None:
        if not self.state.jumping and not self.state.ducking:
            policy.start_jump(self.state, speed)

    def duck(self, ducking: bool) -> None:
        if self.state.jumping:
            if ducking and not self.state.speed_drop:
                self.state.speed_drop = True
                self.state.vel = 1.0
            elif not ducking:
                self.state.speed_drop = False
        else:
            self.state.ducking = ducking

    def advance(self, frames: float) -> None:
        """흘러간 시간만큼 공룡 상태를 진행시킨다 (60프레임/초 기준, 소수는 모았다가 처리)."""
        self._pending += frames
        steps = 0
        while self._pending >= 1.0 and steps < 20:
            policy.step_dino(self.state)
            self._pending -= 1.0
            steps += 1

    def sync_grounded(self) -> None:
        self._pending = 0.0
        self.state.y = policy.GROUND_Y
        self.state.vel = 0.0
        self.state.jumping = False
        self.state.speed_drop = False
        self.state.reached_min_height = False


def sync_dino_from_screen(dino: DinoModel, observation) -> None:
    """화면에서 본 공룡 모습으로 내부 모델을 맞춘다.

    장애물이 공룡과 겹쳐 보일 때는 판단이 흐려지므로, 위쪽 끝과 발밑 두 가지가
    같은 이야기를 할 때만 모델을 고친다.
    """
    top = observation.dino_top
    if top is None:
        return
    on_ground = observation.dino_on_ground
    if on_ground and top >= policy.GROUND_Y - 2:
        if dino.state.jumping:
            dino.sync_grounded()
        dino.state.ducking = top >= policy.GROUND_Y + 8
    elif not on_ground and top < policy.GROUND_Y - 6:
        if not dino.state.jumping:              # 화면은 공중인데 모델은 땅이라고 알고 있다
            dino.state.jumping = True
            dino.state.y = top
            dino.state.vel = 0.0
            dino.state.ducking = False


def apply_decision(decision, keyboard, dino: DinoModel, speed: float) -> None:
    """판단대로 키를 누른다. 아래키는 지상 숙이기와 공중 빠른 착지에 함께 쓰인다."""
    want_down = decision.action in (policy.DUCK, policy.DROP)
    if not want_down:
        if keyboard.down_held:
            keyboard.release_down()
            dino.duck(False)
    elif not keyboard.down_held:
        keyboard.hold_down()
        dino.duck(True)
    elif (decision.action == policy.DUCK
          and not dino.state.ducking and not dino.state.jumping):
        # 공중에서 누르고 있던 아래키는 착지해도 숙이기로 바뀌지 않는다 — 다시 눌러 준다.
        keyboard.retap_down()
        dino.duck(True)
    if decision.action == policy.JUMP:
        keyboard.jump()
        dino.jump(speed)


def save_pgm(path: str, frame) -> None:
    """의존성 없이 화면을 저장한다 (PGM 은 대부분의 뷰어에서 열린다)."""
    height, width = frame.shape
    with open(path, "wb") as fp:
        fp.write(b"P5\n%d %d\n255\n" % (width, height))
        fp.write(frame.astype("uint8").tobytes())


def calibrate_with_retry(grab, attempts: int = 30, wait: float = 0.2) -> vision.Calibration:
    last: Optional[Exception] = None
    for _ in range(attempts):
        try:
            return vision.calibrate(grab())
        except vision.CalibrationError as exc:
            last = exc
            time.sleep(wait)
    raise last if last else vision.CalibrationError("게임을 찾지 못했습니다.")


def build_state(observation: vision.Observation, speed: float,
                dino: policy.DinoState) -> policy.GameState:
    return policy.GameState(speed=speed, obstacles=observation.obstacles, dino=dino)


def run(args: argparse.Namespace) -> int:
    grab, close = vision.make_grabber()
    try:
        if args.region:
            left, top, width, height = args.region
            base = {"left": left, "top": top, "width": width, "height": height}
            frame = grab(base)
            calib = vision.calibrate(frame)
            calib.left += left
            calib.right += left
            calib.ground_row += top
        else:
            calib = calibrate_with_retry(grab)
        if args.scale:
            calib.scale = args.scale

        region = calib.region
        print(f"게임을 찾았습니다 — 캔버스 {calib.left}~{calib.right}, "
              f"지평선 y={calib.ground_row}, 배율 {calib.scale:.2f}"
              f"{', 밤 모드' if calib.night else ''}")

        if args.calibrate:
            save_pgm("dino-bot-calibration.pgm", grab(region))
            print("인식한 영역을 dino-bot-calibration.pgm 으로 저장했습니다.")
            observation = vision.observe(grab(region), calib)
            print(f"보이는 장애물 {len(observation.obstacles)}개: " + ", ".join(
                f"x={o.x:.0f} y={o.y:.0f} {o.w:.0f}x{o.h:.0f}" for o in observation.obstacles))
            print(f"공룡 높이 y={observation.dino_top}")
            return 0

        cfg = policy.Config()
        if args.margin is not None:
            cfg.margin = args.margin
        keyboard = Keyboard(dry_run=args.dry_run)
        speed_est = vision.SpeedEstimator()
        dino = DinoModel()

        print("자동 플레이를 시작합니다. 멈추려면 Ctrl+C.")
        started = False
        deaths = 0
        idle_since: Optional[float] = None
        run_started = time.perf_counter()
        frozen_since: Optional[float] = None
        last_positions: tuple = ()
        last_tick = time.perf_counter()
        started_at = time.perf_counter()
        min_period = 1.0 / args.fps if args.fps else 0.0

        while True:
            now = time.perf_counter()
            if args.duration and now - started_at > args.duration:
                break
            elapsed_ms = (now - last_tick) * 1000.0
            last_tick = now
            frames = max(1.0, elapsed_ms / FRAME_MS)
            cfg.lag_frames = max(1.0, min(cfg.max_lag_frames, frames))

            observation = vision.observe(grab(region), calib)
            speed = speed_est.update(observation.obstacles, now * 1000.0)

            # 화면이 멈춰 있으면(장애물이 있는데 움직이지 않으면) 죽은 것이다.
            positions = tuple(round(o.x, 1) for o in observation.obstacles)
            if positions and positions == last_positions:
                frozen_since = frozen_since or now
            else:
                frozen_since = None
            last_positions = positions

            if frozen_since and now - frozen_since > 0.6:
                deaths += 1
                lasted = frozen_since - run_started
                policy.tune_margin(cfg, score=lasted, good_run_score=args.good_run)
                print(f"죽었습니다 ({deaths}번째, {lasted:.0f}초 버팀). "
                      f"마진 {cfg.margin:.0f}px 로 조정하고 다시 시작합니다.")
                keyboard.release_all()
                dino.sync_grounded()
                speed_est.reset(6.0)
                time.sleep(0.9)                    # 게임이 재시작을 받아 줄 때까지
                keyboard.jump()
                frozen_since = None
                last_positions = ()
                run_started = time.perf_counter()
                time.sleep(0.3)
                continue

            dino.advance(frames)
            sync_dino_from_screen(dino, observation)

            if observation.obstacles:
                idle_since = None
            else:
                # 장애물이 한참 보이지 않으면 게임이 멈춰 있는 것이다 (시작 전/재시작 직후).
                if idle_since is None:
                    idle_since = now
                if not started or now - idle_since > 4.0:
                    keyboard.jump()
                    dino.jump(speed)
                    started = True
                    idle_since = now
                    run_started = now
                    continue

            state = build_state(observation, speed, dino.state)
            decision = policy.decide(state, cfg)

            apply_decision(decision, keyboard, dino, speed)

            if args.debug:
                sys.stdout.write("\r" + vision.render_ascii(observation, speed, decision.action)
                                 + f" margin={cfg.margin:.0f} lag={cfg.lag_frames:.1f}   ")
                sys.stdout.flush()

            if min_period:
                rest = min_period - (time.perf_counter() - now)
                if rest > 0:
                    time.sleep(rest)
    except KeyboardInterrupt:
        print("\n멈췄습니다.")
    finally:
        try:
            Keyboard(dry_run=True).release_all()
        except Exception:
            pass
        close()
    return 0


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="크롬 다이노 게임을 화면만 보고 대신 플레이합니다.")
    parser.add_argument("--region", nargs=4, type=int, metavar=("LEFT", "TOP", "W", "H"),
                        help="게임이 있는 화면 영역을 직접 지정 (자동 탐지 실패 시)")
    parser.add_argument("--scale", type=float, help="화면 픽셀 / 게임 단위 배율을 직접 지정")
    parser.add_argument("--margin", type=float, help="가로 안전 마진(px). 기본 6")
    parser.add_argument("--fps", type=float, default=120.0, help="초당 최대 관측 횟수 (기본 120)")
    parser.add_argument("--duration", type=float, help="이 시간(초)만 플레이하고 종료")
    parser.add_argument("--good-run", type=float, default=30.0, dest="good_run",
                        help="이 시간(초) 이상 버티면 잘 달린 것으로 보고 마진을 좁힌다")
    parser.add_argument("--calibrate", action="store_true",
                        help="인식 결과만 확인하고 끝낸다 (키 입력 없음)")
    parser.add_argument("--debug", action="store_true", help="보고 있는 화면과 판단을 출력")
    parser.add_argument("--dry-run", action="store_true",
                        help="키를 실제로 누르지 않는다 (판단만 확인)")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    return run(parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
