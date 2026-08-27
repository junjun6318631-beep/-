"""키 입력. 실제 키보드를 누르는 부분만 따로 떼어 두었다 (테스트에서는 가짜로 바꿔 끼운다)."""

from __future__ import annotations


class Keyboard:
    """스페이스(점프)와 아래키(숙이기/빠른 착지)를 누른다."""

    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run
        self.down_held = False
        self.presses = 0
        self._controller = None
        self._key = None
        if not dry_run:
            from pynput.keyboard import Controller, Key   # 실제로 쓸 때만 필요
            self._controller = Controller()
            self._key = Key

    def jump(self) -> None:
        self.presses += 1
        if self.dry_run:
            return
        # 스페이스는 짧게 눌렀다 뗀다. 같은 프레임 안에서 처리되므로 점프 높이는 그대로다.
        self._controller.press(self._key.space)
        self._controller.release(self._key.space)

    def hold_down(self) -> None:
        if self.down_held:
            return
        self.down_held = True
        if not self.dry_run:
            self._controller.press(self._key.down)

    def release_down(self) -> None:
        if not self.down_held:
            return
        self.down_held = False
        if not self.dry_run:
            self._controller.release(self._key.down)

    def retap_down(self) -> None:
        """착지하면서 게임이 숙이기를 풀었을 때 다시 눌러 준다."""
        self.release_down()
        self.hold_down()

    def release_all(self) -> None:
        self.release_down()
