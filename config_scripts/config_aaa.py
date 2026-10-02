#!/usr/bin/env python3

# config_scripts/config_aaa.py
#
# Import (put) script for editable-config Docker server nodes (TACACS+, FreeRADIUS, ...).
#
# It pushes the node's startup-config (edited in the PNetLab GUI: right-click node ->
# Startup-config) into the container as /firstboot.cfg via `docker cp`. The node's
# in-container supervisor (firststart.sh, bind-mounted via the template dock_args)
# then applies /firstboot.cfg to the daemon's real config file and (re)starts it.
#
# This is the put-only sibling of config_xrd.py (the XRd telnet "get" path is not
# applicable to plain server containers). "get" is accepted as a no-op so the GUI
# Startup-config editor stays enabled.
#
# @license BSD-3-Clause https://github.com/dainok/unetlab/blob/master/LICENSE
# @link http://www.eve-ng.net/

import getopt, multiprocessing, os, subprocess, sys, time

timeout = 60        # Maximum run time


def config_put(filename, docker_id, timeout_sec=30, satellite_ip=None):
    # filename = startup-config in the node runtime dir; docker_id = container name.
    docker_cmd = ['docker', '-H', 'unix:///var/run/docker.sock']
    if satellite_ip:
        # On a satellite host the container lives there; reach it over ssh.
        docker_cmd = ['docker', '-H', 'ssh://root@%s' % (satellite_ip,)]

    try:
        subprocess.run(docker_cmd + ['inspect', docker_id],
                       capture_output=True, check=True, timeout=5)
    except subprocess.CalledProcessError:
        print('ERROR: container "%s" does not exist.' % (docker_id,))
        return False
    except Exception as e:
        print('ERROR: failed to check container "%s": %s' % (docker_id, e))
        return False

    # Stage a copy named firstboot.cfg in the runtime dir, then docker cp it in.
    runtime_dir = os.path.dirname(filename)
    tmpfile = os.path.join(runtime_dir, 'firstboot.cfg')
    try:
        with open(filename, 'r') as fd:
            content = fd.read()
        with open(tmpfile, 'w') as fd:
            fd.write(content)
    except Exception as e:
        print('ERROR: cannot stage firstboot.cfg: %s' % (e,))
        return False

    try:
        subprocess.run(docker_cmd + ['cp', tmpfile, '%s:/firstboot.cfg' % (docker_id,)],
                       capture_output=True, check=True, timeout=timeout_sec)
        print('OK: injected /firstboot.cfg into container %s' % (docker_id,))
        return True
    except subprocess.CalledProcessError as e:
        msg = e.stderr.decode() if e.stderr else str(e)
        print('ERROR: failed to copy config into "%s": %s' % (docker_id, msg))
        return False
    except Exception as e:
        print('ERROR: failed to copy config into "%s": %s' % (docker_id, e))
        return False


def config_get(filename, docker_id, timeout_sec=30, satellite_ip=None):
    # Pull the container's current /firstboot.cfg back out into the node's
    # startup-config, so an in-container GUI's edits (e.g. the AAA Suite node,
    # which writes its config blob to /firstboot.cfg) round-trip into PNetLab's
    # persisted Startup-config. Guarded + best-effort: if no container is given,
    # or it has no /firstboot.cfg (the plain TACACS+/RADIUS/Syslog/Browser nodes),
    # this is a silent no-op so the shared script stays backward-compatible.
    if not docker_id:
        return True
    docker_cmd = ['docker', '-H', 'unix:///var/run/docker.sock']
    if satellite_ip:
        docker_cmd = ['docker', '-H', 'ssh://root@%s' % (satellite_ip,)]
    try:
        subprocess.run(docker_cmd + ['cp', '%s:/firstboot.cfg' % (docker_id,), filename],
                       capture_output=True, check=True, timeout=timeout_sec)
        print('OK: pulled /firstboot.cfg from %s into startup-config' % (docker_id,))
    except Exception:
        # No such file (non-GUI node) or container gone — leave startup-config as-is.
        pass
    return True


def usage():
    print('Usage: %s -a put -i <container> -f <startup-config> [-t <timeout>] [-s <satellite_ip>]' % (sys.argv[0],))
    print('       %s -a get -i <container> -f <file>   (pulls /firstboot.cfg out if present; else no-op)' % (sys.argv[0],))


def now():
    return int(round(time.time() * 1000))


def main(action, filename, docker_id=None, timeout_sec=None, satellite_ip=None):
    try:
        if action == 'get':
            # Pull the container's live config blob back out (AAA Suite GUI node);
            # a silent no-op for the headless server nodes with no /firstboot.cfg.
            config_get(filename, docker_id, timeout_sec or 30, satellite_ip)
            return
        elif action == 'put':
            if docker_id is None:
                print('ERROR: docker ID (-i) is required for put action.')
                sys.exit(1)
            rc = config_put(filename, docker_id, timeout_sec or 30, satellite_ip)
            if rc is not True:
                print('ERROR: failed to push config.')
                sys.exit(1)

            lock = '%s/.lock' % (os.path.dirname(filename),)
            if os.path.exists(lock):
                os.remove(lock)
            configured = '%s/.configured' % (os.path.dirname(filename),)
            if not os.path.exists(configured):
                open(configured, 'a').close()
        return
    except Exception as e:
        print('ERROR: got an exception')
        print(type(e))
        print(e)
        sys.exit(1)


if __name__ == "__main__":
    action = None
    filename = None
    docker_id = None
    satellite_ip = None

    try:
        opts, args = getopt.getopt(sys.argv[1:], 'a:p:t:f:i:s:',
                                   ['action=', 'port=', 'timeout=', 'file=', 'id=', 'satellite='])
    except getopt.GetoptError:
        usage()
        sys.exit(3)

    for o, a in opts:
        if o in ('-a', '--action'):
            action = a
        elif o in ('-f', '--file'):
            filename = a
        elif o in ('-i', '--id'):
            docker_id = a
        elif o in ('-s', '--satellite'):
            satellite_ip = a
        elif o in ('-t', '--timeout'):
            try:
                timeout = int(a)
            except ValueError:
                timeout = -1

    if action is None or filename is None:
        usage()
        print('ERROR: missing mandatory parameters.')
        sys.exit(1)
    if action not in ['get', 'put']:
        usage()
        print('ERROR: invalid action.')
        sys.exit(1)
    if action == 'put' and docker_id is None:
        usage()
        print('ERROR: docker ID (-i) is required for put action.')
        sys.exit(1)
    if timeout < 0:
        usage()
        print('ERROR: timeout must be 0 or higher.')
        sys.exit(1)
    # For put the startup-config must exist; if it does not, there is nothing to
    # push and the container falls back to its appliance default (/default.cfg).
    if action == 'put' and not os.path.exists(filename):
        print('INFO: no startup-config yet; container will use its default.')
        # The container is up on its default config, so clear the transient start
        # lock device_docker.php sets before the push. Without this the node stays
        # at status 3 (running+locked) — which has no LED colour — so its monitoring
        # LED (and the 3D pedestal) never turns green. The push-success path removes
        # this same lock in main(); the no-config path skipped it.
        lock = '%s/.lock' % (os.path.dirname(filename),)
        if os.path.exists(lock):
            try:
                os.remove(lock)
            except OSError:
                pass
        sys.exit(0)

    end_before = now() + timeout * 1000
    p = multiprocessing.Process(target=main, name="Main", kwargs={
        'action': action,
        'filename': filename,
        'docker_id': docker_id,
        'timeout_sec': timeout,
        'satellite_ip': satellite_ip,
    })
    p.start()
    while p.is_alive() and now() < end_before:
        time.sleep(1)
    if p.is_alive():
        print('ERROR: timeout occurred.')
        p.terminate()
        p.join(timeout=30)
    p.join(timeout=120)
    if p.exitcode is None:
        print('ERROR: subprocess exit code unavailable.')
        sys.exit(127)
    if p.exitcode != 0:
        sys.exit(127)
    sys.exit(0)
