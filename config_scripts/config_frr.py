#!/usr/bin/env python3

# config_scripts/config_frr.py
#
# Import/export script for FRRouting Docker nodes.
#
# root-wrapper-only: this runs as root via unl_wrapper. It is not safe to invoke
# as www-data, and raw Docker access here is not a precedent for bypassing the
# broker elsewhere.
#
# @license BSD-3-Clause https://github.com/dainok/unetlab/blob/master/LICENSE
# @link http://www.eve-ng.net/

import getopt, multiprocessing, os, subprocess, sys, time

timeout = 60        # Maximum run time


def docker_command(satellite_ip=None):
    docker_cmd = ['docker', '-H', 'unix:///var/run/docker.sock']
    if satellite_ip:
        docker_cmd = ['docker', '-H', 'ssh://root@%s' % (satellite_ip,)]
    return docker_cmd


def command_error(error):
    if error.stderr:
        if isinstance(error.stderr, bytes):
            return error.stderr.decode(errors='replace').strip()
        return str(error.stderr).strip()
    return str(error)


def config_put(filename, docker_id, timeout_sec=30, satellite_ip=None):
    # filename is the startup-config in the node runtime dir; docker_id is the
    # container name passed by device_docker.php.
    docker_cmd = docker_command(satellite_ip)

    try:
        subprocess.run(docker_cmd + ['inspect', docker_id],
                       capture_output=True, check=True, timeout=5)
    except subprocess.CalledProcessError:
        print('ERROR: container "%s" does not exist.' % (docker_id,))
        return False
    except subprocess.TimeoutExpired:
        print('ERROR: timeout checking container "%s".' % (docker_id,))
        return False
    except Exception as e:
        print('ERROR: failed to check container "%s": %s' % (docker_id, e))
        return False

    if not os.path.exists(filename):
        # Nothing to push. Return the "no-op" sentinel (None) rather than True:
        # main() must NOT touch .configured in this case. Marking a node
        # configured when no config was pushed makes the engine skip writing
        # startup-config into the runningPath on every LATER start, so a config
        # added after the node's first start would never reach the container.
        print('INFO: no startup-config yet; container keeps its default config.')
        return None

    runtime_dir = os.path.dirname(filename)
    tmpfile = os.path.join(runtime_dir, 'frr.conf')
    try:
        with open(filename, 'r') as fd:
            content = fd.read()
        with open(tmpfile, 'w') as fd:
            fd.write(content)
    except Exception as e:
        print('ERROR: cannot stage frr.conf: %s' % (e,))
        return False

    try:
        subprocess.run(docker_cmd + ['cp', tmpfile, '%s:/etc/frr/frr.conf' % (docker_id,)],
                       capture_output=True, check=True, timeout=timeout_sec)
    except subprocess.CalledProcessError as e:
        print('ERROR: failed to copy config into "%s": %s' % (docker_id, command_error(e)))
        return False
    except subprocess.TimeoutExpired:
        print('ERROR: timeout copying config into "%s".' % (docker_id,))
        return False
    except Exception as e:
        print('ERROR: failed to copy config into "%s": %s' % (docker_id, e))
        return False

    try:
        subprocess.run(docker_cmd + ['exec', docker_id, 'chown', 'frr:frr', '/etc/frr/frr.conf'],
                       capture_output=True, check=True, timeout=timeout_sec)
    except subprocess.CalledProcessError as e:
        print('ERROR: failed to chown FRR config in "%s": %s' % (docker_id, command_error(e)))
        return False
    except subprocess.TimeoutExpired:
        print('ERROR: timeout chowning FRR config in "%s".' % (docker_id,))
        return False
    except Exception as e:
        print('ERROR: failed to chown FRR config in "%s": %s' % (docker_id, e))
        return False

    try:
        subprocess.run(docker_cmd + ['exec', docker_id, 'vtysh', '-b'],
                       capture_output=True, check=True, timeout=timeout_sec)
        print('OK: applied FRR startup-config in container %s' % (docker_id,))
        return True
    except subprocess.CalledProcessError as e:
        print('ERROR: failed to apply FRR config in "%s": %s' % (docker_id, command_error(e)))
        return False
    except subprocess.TimeoutExpired:
        print('ERROR: timeout applying FRR config in "%s".' % (docker_id,))
        return False
    except Exception as e:
        print('ERROR: failed to apply FRR config in "%s": %s' % (docker_id, e))
        return False


def config_get(filename, docker_id, timeout_sec=30, satellite_ip=None):
    # Export the live running configuration. A failed vtysh is a hard failure;
    # do not fall back to the potentially stale /etc/frr/frr.conf file.
    docker_cmd = docker_command(satellite_ip)
    runtime_dir = os.path.dirname(filename)
    tmpfile = os.path.join(runtime_dir, '.frr-running-config')

    try:
        subprocess.run(docker_cmd + ['inspect', docker_id],
                       capture_output=True, check=True, timeout=5)
    except subprocess.CalledProcessError:
        print('ERROR: container "%s" does not exist.' % (docker_id,))
        return False
    except subprocess.TimeoutExpired:
        print('ERROR: timeout checking container "%s".' % (docker_id,))
        return False
    except Exception as e:
        print('ERROR: failed to check container "%s": %s' % (docker_id, e))
        return False

    try:
        with open(tmpfile, 'w') as fd:
            subprocess.run(docker_cmd + [
                'exec', docker_id, 'vtysh', '-c', 'show running-config'
            ], stdout=fd, stderr=subprocess.PIPE, check=True, timeout=timeout_sec)

        if not os.path.isfile(tmpfile) or os.path.getsize(tmpfile) == 0:
            print('ERROR: vtysh returned an empty running-config.')
            return False

        os.replace(tmpfile, filename)
        print('OK: exported live running-config from container %s' % (docker_id,))
        return True
    except subprocess.CalledProcessError as e:
        print('ERROR: failed to retrieve running-config from "%s": %s' % (docker_id, command_error(e)))
        return False
    except subprocess.TimeoutExpired:
        print('ERROR: timeout retrieving running-config from "%s".' % (docker_id,))
        return False
    except Exception as e:
        print('ERROR: failed to retrieve running-config from "%s": %s' % (docker_id, e))
        return False
    finally:
        if os.path.exists(tmpfile):
            try:
                os.remove(tmpfile)
            except OSError:
                pass


def usage():
    print('Usage: %s <standard options>' % (sys.argv[0],))
    print('Standard Options:')
    print('-a <s>    *Action can be:')
    print('           - get: get the running-configuration and push it to a file')
    print('           - put: put the file as startup-configuration')
    print('-f <s>    *File')
    print('-p <n>    Console port (accepted for compatibility; not used)')
    print('-i <s>    Docker container ID/name (mandatory)')
    print('-t <n>    Timeout (default = %i)' % (timeout,))
    print('-s <s>    Satellite IP (optional; for remote Docker)')
    print('* Mandatory option')


def now():
    # Return current UNIX time in milliseconds
    return int(round(time.time() * 1000))


def main(action, filename, docker_id=None, timeout_sec=None, satellite_ip=None):
    try:
        if docker_id is None:
            print('ERROR: docker ID (-i) is required.')
            sys.exit(1)

        if action == 'get':
            rc = config_get(filename, docker_id, timeout_sec or 30, satellite_ip)
        elif action == 'put':
            rc = config_put(filename, docker_id, timeout_sec or 30, satellite_ip)
        else:
            print('ERROR: invalid action.')
            sys.exit(1)

        if rc is None:
            # put with nothing to push — success, but deliberately not
            # ".configured" (see config_put).
            return
        if rc is not True:
            print('ERROR: failed to process FRR config.')
            sys.exit(1)

        if action == 'put':
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
    port = None
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
        elif o in ('-p', '--port'):
            try:
                port = int(a)
            except ValueError:
                port = -1
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
    if port is not None and port < 0:
        usage()
        print('ERROR: port must be 32768 or higher.')
        sys.exit(1)
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

    while (p.is_alive() and now() < end_before):
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
