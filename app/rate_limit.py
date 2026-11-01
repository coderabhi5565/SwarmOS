"""In-memory sliding-window rate limiting for the public demo.

One API process serves the demo, so per-process state is enough. It resets on
restart, which is acceptable for abuse protection on a free tier; it is not an
accounting system.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float = 3600.0, max_keys: int = 10_000):
        self.limit = limit
        self.window = window_seconds
        self.max_keys = max_keys
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def acquire(self, key: str, now: float | None = None) -> int | None:
        """Record one hit for ``key``. Return None if allowed, else seconds to wait."""
        if self.limit <= 0:
            return None
        now = time.monotonic() if now is None else now
        with self._lock:
            hits = self._hits.get(key)
            if hits is None:
                if len(self._hits) >= self.max_keys:
                    self._evict_idle(now)
                hits = self._hits[key] = deque()
            while hits and now - hits[0] >= self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                return max(1, math.ceil(self.window - (now - hits[0])))
            hits.append(now)
            return None

    def _evict_idle(self, now: float) -> None:
        idle = [key for key, hits in self._hits.items() if not hits or now - hits[-1] >= self.window]
        for key in idle:
            del self._hits[key]
        if len(self._hits) >= self.max_keys:
            # Still full of active keys: drop the oldest rather than grow without bound.
            oldest = min(self._hits, key=lambda key: self._hits[key][-1])
            del self._hits[oldest]
