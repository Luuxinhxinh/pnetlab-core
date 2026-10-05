"""Crash-safe usage writes and per-user reservations for brokered AI runs."""
import contextlib
import datetime
import json
import os
import tempfile


class UsageLedger:
    def __init__(self, path, owner=None):
        self.path = path
        self.owner = owner

    @contextlib.contextmanager
    def locked(self, path, nonblocking=False):
        import fcntl  # appliance-only; keep pure accounting portable for tests
        os.makedirs(os.path.dirname(path), mode=0o750, exist_ok=True)
        # Root-owned paths under data/ai. Do not follow a substituted symlink.
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
            except BlockingIOError:
                raise ValueError("An AI run is already active for this user. Wait for it to finish.")
            yield
        finally:
            os.close(fd)

    def read(self):
        try:
            with open(self.path) as fh:
                value = json.load(fh)
            if not isinstance(value, dict):
                raise ValueError("Invalid AI usage ledger")
            return value
        except FileNotFoundError:
            return {}
        # Corruption fails closed: never reset an existing budget to zero.

    def used(self, pod, day=None):
        day = day or datetime.date.today().isoformat()
        return max(0, int(self.read().get(day, {}).get(str(pod), 0)))

    def add(self, pod, tokens, day=None):
        day = day or datetime.date.today().isoformat()
        with self.locked(self.path + ".lock"):
            ledger = self.read()
            ledger.setdefault(day, {})[str(pod)] = max(0, self.used(pod, day) + int(tokens))
            for key in sorted(ledger)[:-14]:
                ledger.pop(key, None)
            fd, tmp = tempfile.mkstemp(prefix=".usage-", dir=os.path.dirname(self.path))
            try:
                with os.fdopen(fd, "w") as fh:
                    json.dump(ledger, fh)
                    fh.flush()
                    os.fsync(fh.fileno())
                if self.owner:
                    self.owner(tmp)
                else:
                    os.chmod(tmp, 0o640)
                os.replace(tmp, self.path)
                directory_fd = os.open(os.path.dirname(self.path), os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)

    @contextlib.contextmanager
    def reserve(self, pod, cap, ceiling=50000):
        # Holding this OS lock reserves the allowance until job completion.
        # A broker crash releases it automatically; no stale reservation file.
        with self.locked(self.path + ".run-%d" % pod, nonblocking=True):
            day = datetime.date.today().isoformat()
            with self.locked(self.path + ".lock"):
                remaining = max(0, cap - self.used(pod, day)) if cap else ceiling
                allowance = min(ceiling, remaining)
                if allowance <= 0:
                    raise ValueError("Daily AI token cap reached. Try again tomorrow.")
            yield allowance, day
