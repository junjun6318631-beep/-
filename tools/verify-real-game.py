#!/usr/bin/env python3
"""진짜 크롬 다이노 게임 코드에 봇을 붙여 헤드리스 크로미움에서 돌려 본다.

시뮬레이터가 아무리 원본을 옮겼다 해도 진짜 게임과 다를 수 있어서, 실제 게임 코드로
확인하는 경로를 따로 둔다. (실제로 이 검증에서 크롬 원본의 상수 이름 오타를
찾아 봇을 고쳤다.)

    pip install playwright
    python3 tools/verify-real-game.py --seconds 120

게임 소스(t-rex-runner)는 처음 한 번 내려받아 tools/.trex-cache/ 에 둔다.
인터넷과 playwright 가 필요하므로 기본 테스트(npm test)에는 넣지 않았다.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import pathlib
import socketserver
import sys
import threading
import time
import urllib.request

BASE = "https://raw.githubusercontent.com/wayou/t-rex-runner/gh-pages/"
FILES = ["index.html", "index.js", "assets/default_100_percent/100-offline-sprite.png"]
CACHE = pathlib.Path(__file__).resolve().parent / ".trex-cache"
BOT = pathlib.Path(__file__).resolve().parent.parent / "js" / "dino-bot.js"


def fetch_game() -> pathlib.Path:
    for name in FILES:
        target = CACHE / name
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        print(f"내려받는 중: {name}")
        with urllib.request.urlopen(BASE + name, timeout=60) as response:
            target.write_bytes(response.read())
    return CACHE


def serve(root: pathlib.Path, port: int):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    socketserver.TCPServer.allow_reuse_address = True
    server = socketserver.TCPServer(("127.0.0.1", port), handler)
    server.RequestHandlerClass.log_message = lambda *a, **k: None
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main() -> int:
    parser = argparse.ArgumentParser(description="진짜 다이노 게임으로 봇을 검증합니다.")
    parser.add_argument("--seconds", type=int, default=120, help="플레이 시간 (기본 120초)")
    parser.add_argument("--port", type=int, default=8731)
    parser.add_argument("--browser", default=None, help="크로미움 실행 파일 경로")
    args = parser.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright 가 필요합니다:  pip install playwright", file=sys.stderr)
        return 2

    root = fetch_game()
    server = serve(root, args.port)
    failures = []
    try:
        with sync_playwright() as pw:
            launch = {"args": ["--no-sandbox"]}
            if args.browser:
                launch["executable_path"] = args.browser
            browser = pw.chromium.launch(**launch)
            page = browser.new_page(viewport={"width": 1000, "height": 400})
            page.on("pageerror", lambda e: failures.append(str(e)))
            page.goto(f"http://127.0.0.1:{args.port}/index.html")
            page.wait_for_function("window.Runner && Runner.instance_ && Runner.instance_.tRex",
                                   timeout=20000)
            page.evaluate(BOT.read_text())          # 콘솔에 붙여넣는 것과 같다
            print(f"봇을 넣었습니다. {args.seconds}초 동안 플레이합니다.")

            snapshot = page.evaluate("() => DinoBot.api.snapshot(Runner.instance_).k")
            print("봇이 읽은 물리 상수:", snapshot)
            if snapshot.get("jumpVelocity") in (None, 0):
                failures.append("점프 속도 상수를 읽지 못했습니다 (예측이 어긋납니다)")

            for elapsed in range(args.seconds):
                time.sleep(1)
                state = page.evaluate("""() => ({
                    score: Math.round(Runner.instance_.distanceRan * 0.025),
                    speed: +Runner.instance_.currentSpeed.toFixed(2),
                    deaths: DinoBot.stats.deaths,
                    margin: DinoBot.cfg.margin
                })""")
                if (elapsed + 1) % 15 == 0:
                    print(f"  {elapsed + 1:4d}초   점수 {state['score']:7d}   속도 {state['speed']:5.2f}"
                          f"   죽음 {state['deaths']}회   마진 {state['margin']}px")
            final = page.evaluate("""() => ({
                score: Math.round(Runner.instance_.distanceRan * 0.025),
                deaths: DinoBot.stats.deaths,
                best: DinoBot.stats.best,
                speed: +Runner.instance_.currentSpeed.toFixed(2)
            })""")
            browser.close()
    finally:
        server.shutdown()

    print(f"\n결과: {args.seconds}초 동안 점수 {final['score']}, 죽음 {final['deaths']}회, "
          f"최종 속도 {final['speed']}")
    if failures:
        print("문제:", failures[:5], file=sys.stderr)
        return 1
    if final["deaths"]:
        print("한 번 이상 죽었습니다.", file=sys.stderr)
        return 1
    print("한 번도 죽지 않았습니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
