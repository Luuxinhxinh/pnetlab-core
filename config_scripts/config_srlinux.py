#!/usr/bin/env python3

# config_scripts/config_srlinux.py
#
# Import/Export script for the srlinux-ixr-{d2l,d3,d3l} Docker templates.
#
# Unlike plain "srlinux" (handled natively by device_srlinux.php via its own
# sr_cli export/import), the ixr templates fall through to the generic
# device_docker.php, which drives config scripts over a docker-exec contract:
#   put: nohup <script> -a put -i docker<session> -f <startup-config> -t <timeout>
#   get: <script> -a get -i docker<session> -f <unique-tmp-file> -t 120
# This is NOT the EVE upstream config_srlinux.py (that version is
# console/pexpect-based and expects "-p <port>" for get) — that contract does
# not exist here. put/get are mirrored from device_srlinux.php's own
# import (:564-576) / export (:600-614) logic, but driven by docker exec
# instead of the in-process PHP calls device_srlinux.php makes for the native
# srlinux device class.
#
# @license BSD-3-Clause https://github.com/dainok/unetlab/blob/master/LICENSE
# @link http://www.eve-ng.net/

import getopt, multiprocessing, os, subprocess, sys, time

timeout = 300        # Maximum run time


def docker_base_cmd(satellite_ip=None):
    if satellite_ip:
        return ['docker', '-H', 'ssh://root@%s' % (satellite_ip,)]
    return ['docker', '-H=unix:///var/run/docker.sock']


def config_put(filename, docker_id, timeout_sec=30, satellite_ip=None):
    # device_docker.php fires `put` unconditionally on every start, even when
    # the node has no startup-config yet. Mirror device_srlinux.php's own
    # `if (file_exists(...))` guard: silently succeed when there is nothing
    # to push.
    if not os.path.exists(filename):
        print('INFO: no startup-config yet; nothing to push.')
        return True

    docker_cmd = docker_base_cmd(satellite_ip)

    try:
        subprocess.run(docker_cmd + ['inspect', docker_id],
                       capture_output=True, check=True, timeout=5)
    except subprocess.CalledProcessError:
        print('ERROR: container "%s" does not exist.' % (docker_id,))
        return False
    except Exception as e:
        print('ERROR: failed to check container "%s": %s' % (docker_id, e))
        return False

    # Mirror device_srlinux.php:147-158 -- prepend "enter candidate" so the
    # config lands in the candidate datastore rather than the running one.
    try:
        with open(filename, 'r') as fd:
            content = fd.read()
    except Exception as e:
        print('ERROR: cannot read "%s": %s' % (filename, e))
        return False

    runtime_dir = os.path.dirname(filename)
    tmpfile = os.path.join(runtime_dir, 'startup-config.candidate')
    try:
        with open(tmpfile, 'w') as fd:
            fd.write('enter candidate' + '\n' + content)
    except Exception as e:
        print('ERROR: cannot stage candidate config: %s' % (e,))
        return False

    try:
        subprocess.run(docker_cmd + ['cp', tmpfile, '%s:startup-config' % (docker_id,)],
                       capture_output=True, check=True, timeout=timeout_sec)
    except subprocess.CalledProcessError as e:
        msg = e.stderr.decode() if e.stderr else str(e)
        print('ERROR: failed to copy config into "%s": %s' % (docker_id, msg))
        return False
    except Exception as e:
        print('ERROR: failed to copy config into "%s": %s' % (docker_id, e))
        return False
    finally:
        try:
            os.remove(tmpfile)
        except OSError:
            pass

    # sr_cli may not be ready yet right after container start (still booting
    # sr_linux). Poll/retry the exec until it succeeds or the timeout budget
    # expires, rather than a single fixed sleep.
    deadline = time.time() + timeout_sec
    exec_cmd = docker_cmd + ['exec', '-u', 'root', docker_id,
                              'sr_cli', 'source', 'startup-config', 'auto-commit']
    last_err = None
    while time.time() < deadline:
        try:
            result = subprocess.run(exec_cmd, capture_output=True, timeout=30)
            if result.returncode == 0:
                print('OK: sourced startup-config into %s' % (docker_id,))
                return True
            last_err = (result.stderr or result.stdout or b'').decode(errors='replace')
        except subprocess.TimeoutExpired:
            last_err = 'exec timed out'
        except Exception as e:
            last_err = str(e)
        time.sleep(2)

    print('ERROR: sr_cli source startup-config auto-commit did not succeed in "%s": %s' % (docker_id, last_err))
    return False


def config_get(filename, docker_id, timeout_sec=30, satellite_ip=None):
    docker_cmd = docker_base_cmd(satellite_ip)

    try:
        subprocess.run(docker_cmd + ['inspect', docker_id],
                       capture_output=True, check=True, timeout=5)
    except subprocess.CalledProcessError:
        print('ERROR: container "%s" does not exist.' % (docker_id,))
        return False
    except Exception as e:
        print('ERROR: failed to check container "%s": %s' % (docker_id, e))
        return False

    # Mirror device_srlinux.php export() (:600-614): dump the running/candidate
    # state to a file inside the container, then docker cp it out.
    try:
        subprocess.run(docker_cmd + ['exec', '-u', 'root', docker_id, 'bash', '-c',
                                      'sr_cli info flat from state | more > export-config'],
                       capture_output=True, check=True, timeout=timeout_sec)
    except subprocess.CalledProcessError as e:
        msg = e.stderr.decode() if e.stderr else str(e)
        print('ERROR: failed to export config inside "%s": %s' % (docker_id, msg))
        return False
    except Exception as e:
        print('ERROR: failed to export config inside "%s": %s' % (docker_id, e))
        return False

    try:
        subprocess.run(docker_cmd + ['cp', '%s:export-config' % (docker_id,), filename],
                       capture_output=True, check=True, timeout=timeout_sec)
    except subprocess.CalledProcessError as e:
        msg = e.stderr.decode() if e.stderr else str(e)
        print('ERROR: failed to copy export-config from "%s": %s' % (docker_id, msg))
        return False
    except Exception as e:
        print('ERROR: failed to copy export-config from "%s": %s' % (docker_id, e))
        return False

    print('OK: exported config from %s to %s' % (docker_id, filename))
    return True


def usage():
    print('Usage: %s -a put -i <container> -f <startup-config> [-t <timeout>] [-s <satellite_ip>]' % (sys.argv[0],))
    print('       %s -a get -i <container> -f <file> [-t <timeout>] [-s <satellite_ip>]' % (sys.argv[0],))


def now():
    return int(round(time.time() * 1000))


def main(action, filename, docker_id=None, timeout_sec=None, satellite_ip=None):
    try:
        if action == 'get':
            if docker_id is None:
                print('ERROR: docker ID (-i) is required for get action.')
                sys.exit(1)
            rc = config_get(filename, docker_id, timeout_sec or 30, satellite_ip)
            if rc is not True:
                print('ERROR: failed to retrieve config.')
                sys.exit(1)
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
        opts, args = getopt.getopt(sys.argv[1:], 'a:t:f:i:s:',
                                   ['action=', 'timeout=', 'file=', 'id=', 'satellite='])
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
    if docker_id is None:
        usage()
        print('ERROR: docker ID (-i) is required.')
        sys.exit(1)
    if timeout < 0:
        usage()
        print('ERROR: timeout must be 0 or higher.')
        sys.exit(1)
    # get's destination must not already exist -- device_docker.php's export()
    # creates a unique tempname and removes the placeholder before calling us.
    if action == 'get' and os.path.exists(filename):
        usage()
        print('ERROR: destination file already exists.')
        sys.exit(1)

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
