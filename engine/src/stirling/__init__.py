"""Stirling AI engine package."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .api.app import app as app

__all__ = [
    "app",
]


def __getattr__(name: str) -> Any:
    if name == "app":
        from .api.app import app

        return app
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
