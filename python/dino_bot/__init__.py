"""크롬 다이노 게임을 화면만 보고 대신 플레이하는 봇."""

from .policy import Config, DinoState, GameState, Obstacle, decide, simulate

__all__ = ["Config", "DinoState", "GameState", "Obstacle", "decide", "simulate"]
