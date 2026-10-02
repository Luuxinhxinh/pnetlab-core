#!/usr/bin/env python3
"""PNetLab docker-node telnet console bridge — replaces the stubbed docker_wrapper.

The shipped /opt/unetlab/wrappers/docker_wrapper is a licensing stub (prints
"Download PNETLab from pnetlab.com" and binds nothing), so docker-node web consoles
never open. This bridge listens on <port> and, per client connection, runs <cmd>
inside <container> via `docker -H unix:///var/run/docker.sock exec -it` on a PTY, speaking
enough of the telnet protocol (IAC negotiation, server WILL ECHO/SGA, NAWS window
size, CR-LF / CR-NUL -> CR) that guacd's telnet client and a plain telnet client
render the node CLI cleanly. Reconnectable: a fresh exec is forked per client.

Usage: docker_console.py [--name=<title>] <port> <container> <cmd> [args...]
"""
import os, sys, pty, select, socket, signal, struct, fcntl, termios, subprocess

DOCKER_H = "unix:///var/run/docker.sock"
IAC, DONT, DO, WONT, WILL, SB, SE = 255, 254, 253, 252, 251, 250, 240
ECHO, SGA, NAWS = 1, 3, 31
TITLE_MAX = 63


def clean_title(name):
    """Printable-only, length-capped node name for an OSC-0 title escape.

    device.php already strips shell metacharacters from the node name before
    it ever reaches argv, but not control bytes -- and this string lands
    verbatim in another user's terminal (SecureCRT et al. interpret ESC/BEL
    as the START of the very escape we're emitting), so filter defensively
    rather than trust the caller.
    """
    return "".join(ch for ch in name if 0x20 <= ord(ch) < 0x7F)[:TITLE_MAX]

# Idle self-cleanup: the listener binds <port> for the lifetime of the container.
# If the container is deleted, an idle listener (no client ever connected) would
# otherwise hold the port forever and collide with a later node that reuses this
# node-id/port (getNodeStatus sees the port LISTEN and reports the new node as
# already running, so its start silently no-ops). So poll between accepts and exit
# once the container is gone. MAX_MISSES tolerates a transient docker-daemon blip.
CHECK_INTERVAL = 30   # seconds between idle container-existence checks
MAX_MISSES = 2        # consecutive misses (~60s) before giving up the port


def container_exists(container):
    """True if the container still exists (any state); False only on a definitive
    'no such object'. On a transient docker error we return True so a daemon blip
    never tears down a live console."""
    try:
        r = subprocess.run(
            ["docker", "-H", DOCKER_H, "inspect", container],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10,
        )
        if r.returncode == 0:
            return True
        # Definitive "gone" only on a no-such-object error; any other non-zero
        # (daemon unreachable, timeout) is transient -> keep the console alive.
        # Match case-insensitively: docker's wording/casing varies by version
        # ("Error: No such object" vs "error: no such object").
        return b"no such" not in r.stderr.lower()
    except Exception:
        return True


def container_running(container):
    """True only if the container is inspectable AND State.Running is true.
    On any docker error (daemon blip, timeout) we return None so the caller can
    tell "definitely stopped" from "couldn't tell" and avoid a false negative."""
    try:
        r = subprocess.run(
            ["docker", "-H", DOCKER_H, "inspect",
             "--format", "{{.State.Running}}", container],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
        )
        if r.returncode != 0:
            # Docker writes "Error: No such object" to stderr (not stdout), so
            # stderr must be captured (not DEVNULL'd) for this check to ever
            # match. Match case-insensitively, same as container_exists above.
            if b"no such" in (r.stderr or b"").lower():
                return False
            return None
        return r.stdout.strip() == b"true"
    except Exception:
        return None


def set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def serve(conn, container, cmd, title=""):
    # Tell the client: server echoes + suppresses go-ahead; please report window size.
    conn.sendall(bytes([IAC, WILL, ECHO, IAC, WILL, SGA, IAC, DO, NAWS]))
    # xterm/SecureCRT OSC-0 window-title escape: unlike dynamips/IOL consoles,
    # a bare docker exec PTY has nothing that ever sets one, so a native
    # console client falls back to captioning its tab/session with the raw
    # host:port. Emitted once up front, from the caller-supplied node name.
    if title:
        conn.sendall(b"\x1b]0;" + title.encode("ascii", "replace") + b"\x07")
    # Don't `docker exec` into a stopped container: that returns the raw daemon
    # error "container <id> is not running", which the web console then streams on
    # every reconnect. Show a clean status line and close instead, so a node that
    # is merely stopped (not wiped) reads as "not running" rather than an error
    # loop. Only bail on a DEFINITE stop (running is False); on an inconclusive
    # probe (None) we proceed so a docker-daemon blip never blocks a live console.
    if container_running(container) is False:
        conn.sendall(b"\r\n[node is not running - start it to open the console]\r\n")
        return
    pid, fd = pty.fork()
    if pid == 0:  # child -> the node CLI
        os.execvp("docker", ["docker", "-H", DOCKER_H, "exec", "-it", container] + cmd)
        os._exit(127)

    state, verb, sb = 0, 0, bytearray()
    try:
        while True:
            r, _, _ = select.select([conn, fd], [], [])
            if conn in r:
                data = conn.recv(4096)
                if not data:
                    break
                out = bytearray()
                for b in data:
                    if state == 0:
                        if b == IAC:
                            state = 1
                        else:
                            out.append(b)
                    elif state == 1:                      # after IAC
                        if b in (DO, DONT, WILL, WONT):
                            verb, state = b, 2
                        elif b == SB:
                            sb = bytearray(); state = 3
                        elif b == IAC:                    # escaped 0xFF
                            out.append(IAC); state = 0
                        else:                             # other 2-byte cmd
                            state = 0
                    elif state == 2:                      # IAC <verb> <opt>
                        if verb == DO:
                            conn.sendall(bytes([IAC, WILL if b in (ECHO, SGA) else WONT, b]))
                        elif verb == WILL:
                            conn.sendall(bytes([IAC, DO if b in (SGA, NAWS) else DONT, b]))
                        state = 0
                    elif state == 3:                      # collecting SB ... IAC SE
                        if b == IAC:
                            state = 4
                        else:
                            sb.append(b)
                    elif state == 4:                      # in SB, saw IAC
                        if b == SE:
                            if sb and sb[0] == NAWS and len(sb) >= 5:
                                cols = (sb[1] << 8) | sb[2]
                                rows = (sb[3] << 8) | sb[4]
                                if rows and cols:
                                    set_winsize(fd, rows, cols)
                            state = 0
                        elif b == IAC:                    # escaped 0xFF inside SB
                            sb.append(IAC); state = 3
                        else:
                            state = 3
                # Telnet sends Enter as CR-LF or CR-NUL; the CLI wants a single CR.
                buf = bytes(out).replace(b"\r\n", b"\r").replace(b"\r\x00", b"\r")
                if buf:
                    os.write(fd, buf)
            if fd in r:
                try:
                    data = os.read(fd, 4096)
                except OSError:
                    data = b""
                if not data:
                    break
                if 0xFF in data:                          # escape IAC in CLI output
                    data = data.replace(b"\xff", b"\xff\xff")
                conn.sendall(data)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass


def main():
    args = sys.argv[1:]
    title = ""
    if args and args[0].startswith("--name="):
        title = clean_title(args[0][len("--name="):])
        args = args[1:]
    if len(args) < 3:
        sys.stderr.write(
            "usage: docker_console.py [--name=<title>] <port> <container> <cmd> [args...]\n"
        )
        sys.exit(2)
    port, container, cmd = int(args[0]), args[1], args[2:]

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port))
    srv.listen(5)
    srv.settimeout(CHECK_INTERVAL)

    misses = 0
    while True:
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            # Idle tick: release the port once the container is gone so a later
            # node reusing this id/port can start (upg/docker-console-orphan).
            if container_exists(container):
                misses = 0
            elif (misses := misses + 1) >= MAX_MISSES:
                break
            continue
        except OSError:
            continue
        misses = 0
        # double-fork so connection handlers reparent to init (no zombies)
        pid = os.fork()
        if pid == 0:
            if os.fork() == 0:
                srv.close()
                conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                try:
                    serve(conn, container, cmd, title)
                finally:
                    try:
                        conn.close()
                    except OSError:
                        pass
                os._exit(0)
            os._exit(0)
        os.waitpid(pid, 0)
        conn.close()

    try:
        srv.close()
    except OSError:
        pass


if __name__ == "__main__":
    main()
