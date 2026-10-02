#!/usr/bin/env python3
"""Take one bounded, stable snapshot of a worker configuration file."""

import argparse
import os
import stat
import sys


def snapshot(source, destination, max_bytes, claim=False):
    fd = None
    out_fd = None
    destination_created = False
    try:
        flags = (os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) |
                 getattr(os, "O_NOFOLLOW", 0))
        fd = os.open(source, flags)
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise ValueError("configuration source is not a regular file")
        named = os.lstat(source)
        if (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
            raise ValueError("configuration source path changed")
        if claim:
            os.unlink(source)
            # unlink intentionally changes ctime. Take the stability baseline
            # afterwards, while ensuring content metadata did not change during
            # the open/name-removal window.
            before = os.fstat(fd)
            if (opened.st_size, opened.st_mtime_ns) != (
                    before.st_size, before.st_mtime_ns):
                raise ValueError("configuration source changed while being claimed")
        else:
            before = opened
        if before.st_size > max_bytes:
            raise ValueError("configuration source is too large")
        chunks = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > max_bytes or os.read(fd, 1):
            raise ValueError("configuration source is too large")
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
                before.st_ctime_ns) != (after.st_dev, after.st_ino,
                after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("configuration source changed while being read")

        out_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        destination_created = True
        view = memoryview(data)
        while view:
            written = os.write(out_fd, view)
            if written <= 0:
                raise OSError("short configuration snapshot write")
            view = view[written:]
        os.fsync(out_fd)
        os.close(out_fd)
        out_fd = None
    except Exception:
        if destination_created:
            try:
                os.unlink(destination)
            except FileNotFoundError:
                pass
        raise
    finally:
        if fd is not None:
            os.close(fd)
        if out_fd is not None:
            os.close(out_fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--claim", action="store_true")
    parser.add_argument("--max-bytes", type=int, required=True)
    parser.add_argument("source")
    parser.add_argument("destination")
    args = parser.parse_args()
    if not 1 <= args.max_bytes <= 16 * 1024 * 1024:
        parser.error("max-bytes out of bounds")
    try:
        snapshot(args.source, args.destination, args.max_bytes, args.claim)
    except (OSError, ValueError) as exc:
        print("configuration snapshot failed: %s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
