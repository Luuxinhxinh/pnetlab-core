#!/usr/bin/env python3

# scripts/config_xrv.py
#
# Import/Export script for vIOS.
#
# @author Andrea Dainese <andrea.dainese@gmail.com>
# @author Alain Degreffe <eczema@ecze.com>
# @copyright 2014-2016 Andrea Dainese
# @copyright 2017-2018 Alain Degreffe
# @license BSD-3-Clause https://github.com/dainok/unetlab/blob/master/LICENSE
# @link http://www.eve-ng.net/
# @version 20181203

import getopt, multiprocessing, os, pexpect, re, subprocess, sys, time

username = 'admin'
password = 'cisco'
secret = 'cisco'
conntimeout = 3     # Maximum time for console connection
expctimeout = 3     # Maximum time for each short expect
longtimeout = 30    # Maximum time for each long expect
timeout = 60        # Maximum run time (conntimeout is included)

def node_login(handler):
    # Send an empty line, and wait for the login prompt
    i = -1
    while i == -1:
        try:
            handler.sendline('\r\n')
            i = handler.expect([
                'Username:',
                r'\(config',
                '[^)]#',
                'Uncommitted changes found'], timeout = 5)
        except:
            i = -1

    if i == 0:
        # Need to send username and password
        handler.sendline(username)
        try:
            handler.expect('Password:', timeout = expctimeout)
        except:
            print('ERROR: error waiting for "Password:" prompt.')
            node_quit(handler)
            return False

        handler.sendline(password)
        try:
            handler.expect('[^)]#', timeout = expctimeout)
        except:
            print('ERROR: error waiting for "#" prompt.')
            node_quit(handler)
            return False
        return True
    elif i == 1:
        # Config mode detected, need to exit
        # Clearing all "expect" buffer
        while True:
            try:
                handler.expect('#', timeout = 0.1)
            except:
                break
        handler.sendline('end')
        try:
            i = handler.expect(['[^)]#', 'Uncommitted changes found'], timeout = expctimeout)
        except:
            print('ERROR: error waiting for ["#", "Uncommitted changes found"] prompt.')
            node_quit(handler)
            return False

        if i == 0:
            # Nothing to do
            return True
        elif i == 1:
            handler.sendline('no')
            try:
                handler.expect('[^)]#', timeout = expctimeout)
            except:
                print('ERROR: error waiting for "#" prompt.')
                node_quit(handler)
                return False
            return True
        else:
            # Unexpected output
            node_quit(handler)
            return False

        return True
    elif i == 2:
        # Nothing to do
        return True
    elif i == 3:
        # Need to exit the commit prompt
        handler.sendline('no')
        try:
            handler.expect('[^)]#', timeout = longtimeout)
        except:
            print('ERROR: error waiting for "#" prompt.')
            node_quit(handler)
            return False
        return True
    else:
        # Unexpected output
        node_quit(handler)
        return False

def node_firstlogin(handler):
    # Send an empty line, and wait for the login prompt
    i = -1
    while i == -1:
        try:
            handler.sendline('\r\n')
            i = handler.expect('Username:', timeout = 5)
        except:
            i = -1

    if i == 0:
        # Need to send username and password
        handler.sendline(username)
        try:
            handler.expect('Password:', timeout = expctimeout)
        except:
            print('ERROR: error waiting for "Password:" prompt.')
            node_quit(handler)
            return False

        handler.sendline(password)
        try:
            handler.expect('[^)]#', timeout = expctimeout)
        except:
            print('ERROR: error waiting for "#" prompt.')
            node_quit(handler)
            return False
        return True
    else:
        # Unexpected output
        node_quit(handler)
        return False


def node_quit(handler):
    if handler.isalive() == True:
        handler.sendline('quit\n')
    handler.close()

def config_get(handler):
    # Clearing all "expect" buffer
    while True:
        try:
            handler.expect('#', timeout = 0.1)
        except:
            break

    # Disable paging
    handler.sendline('terminal length 0')
    try:
        handler.expect('#', timeout = expctimeout)
    except:
        print('ERROR: error waiting for "#" prompt.')
        node_quit(handler)
        return False

    handler.sendline('configure terminal')
    try:
        handler.expect('#', timeout = expctimeout)
    except:
        print('ERROR: error waiting for "#" prompt.')
        node_quit(handler)
        return False

    handler.sendline('no logging console')
    try:
        handler.expect('#', timeout = expctimeout)
    except:
        print('ERROR: error waiting for "#" prompt.')
        node_quit(handler)
        return False

    handler.sendline('commit')
    try:
        handler.expect('#', timeout = expctimeout)
    except:
        print('ERROR: error waiting for "#" prompt.')
        node_quit(handler)
        return False

    handler.sendline('exit')
    try:
        handler.expect('#', timeout = expctimeout) 
    except:
        print('ERROR: error waiting for "#" prompt.')
        node_quit(handler)
        return False

    # Getting the config. Collect across any "--More--" pager prompts: on the XRd console
    # PTY "terminal length 0" does not reliably disable paging (the docker_console bridge can
    # reset the window size), so "show running-config" paginates. The old single
    # expect('\r\nend\r\n') hung at the first page and failed with "error waiting for end
    # marker". Advance past each pager prompt with a space; stop when the CLI prompt returns.
    handler.sendline('show running-config')
    config = ''
    while True:
        try:
            k = handler.expect(['--More--', r'RP/0/\S+#'], timeout = longtimeout)
        except:
            print('ERROR: error waiting for "end" marker.')
            node_quit(handler)
            return False
        config += handler.before.decode()
        if k == 0:
            handler.send(' ')   # next page (space, no newline)
        else:
            break

    # Manipulating the config
    config = re.sub('\x08', '', config, flags=re.DOTALL)                                    # pager backspaces
    config = re.sub(' *--More-- *', '', config, flags=re.DOTALL)                            # leftover pager text
    config = re.sub('\r', '', config, flags=re.DOTALL)                                      # Unix style
    config = re.sub(r'(?m)^[ \t]+!\s*$', '!', config)                                       # pager-spill indent on '!' separators
    config = re.sub('.*!! IOS XR Configuration', '!! IOS XR Configuration', config, flags=re.DOTALL)   # Header
    config = re.sub('no logging console' , '\n!\n' , config, flags=re.DOTALL) # suppress no login console
    # The capture now runs to the CLI prompt, so it already includes IOS XR's own trailing
    # 'end' marker. Normalise the tail to a single clean 'end' (the old footer synthesised one
    # because the capture used to stop just before it, which now produced a duplicate 'end').
    config = config.rstrip()
    if not re.search(r'\nend\Z', config):
        config += '\nend'
    config += '\n'
    return config

def config_put(filename, docker_id, timeout_sec=30, satellite_ip=None):
    # filename is the config file path
    # docker_id is the Docker container ID/name passed as parameter
    # timeout_sec is the timeout for docker cp operation
    docker_cmd = ['docker']
    if satellite_ip:
        docker_cmd = ['docker', '-H', 'ssh://root@%s' % (satellite_ip,)]

    # Vérifie que le container existe
    try:
        result = subprocess.run(docker_cmd + ['inspect', docker_id],
                              capture_output=True, check=True, timeout=5)
    except subprocess.CalledProcessError:
        print(f'ERROR: container "{docker_id}" does not exist.')
        return False
    except subprocess.TimeoutExpired:
        print(f'ERROR: timeout checking container "{docker_id}".')
        return False
    except Exception as e:
        print(f'ERROR: failed to check container "{docker_id}": {e}')
        return False
    
    # Crée le fichier firstboot.cfg dans le répertoire runtime (parent du fichier)
    runtime_dir = os.path.dirname(filename)
    tmpfile = os.path.join(runtime_dir, 'firstboot.cfg')
    
    try:
        # Lire le contenu du fichier source
        with open(filename, 'r') as fd:
            config_content = fd.read()
        
        # Écrire le contenu dans firstboot.cfg
        with open(tmpfile, 'w') as fd:
            fd.write(config_content)
    except Exception as e:
        print(f'ERROR: cannot create firstboot.cfg file: {e}')
        return False
    
    # Copie dans le container (root)
    try:
        result = subprocess.run(docker_cmd + ['cp', tmpfile, f'{docker_id}:/firstboot.cfg'],
                              capture_output=True, check=True, timeout=timeout_sec)
        print(f'OK: injected /firstboot.cfg into container {docker_id}')
        return True
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr.decode() if e.stderr else str(e)
        print(f'ERROR: failed to copy file to container "{docker_id}": {error_msg}')
        return False
    except subprocess.TimeoutExpired:
        print(f'ERROR: timeout copying file to container "{docker_id}".')
        return False
    except Exception as e:
        print(f'ERROR: failed to copy file to container "{docker_id}": {e}')
        return False

def usage():
    print('Usage: %s <standard options>' %(sys.argv[0]));
    print('Standard Options:');
    print('-a <s>    *Action can be:')
    print('           - get: get the startup-configuration and push it to a file')
    print('           - put: put the file as startup-configuration')
    print('-f <s>    *File');
    print('-p <n>    *Console port (mandatory for get, optional for put)');
    print('-i <s>    Docker container ID/name (mandatory for put)');
    print('-t <n>     Timeout (default = %i)' %(timeout));
    print('-s <s>    Satellite IP (optional; for put: docker over ssh to satellite)');
    print('* Mandatory option')

def now():
    # Return current UNIX time in milliseconds
    return int(round(time.time() * 1000))

def main(action, filename, port=None, docker_id=None, timeout_sec=None, satellite_ip=None):
    handler = None
    try:
        if action == 'get':
            # Connect to the device via telnet
            if port is None:
                print('ERROR: port is required for get action.')
                sys.exit(1)
            tmp = conntimeout
            while (tmp > 0):
                handler = pexpect.spawn('telnet 127.0.0.1 %i' %(port))
                time.sleep(0.1)
                tmp = tmp - 0.1
                if handler.isalive() == True:
                    break

            if (handler.isalive() != True):
                print('ERROR: cannot connect to port "%i".' %(port))
                if handler:
                    node_quit(handler)
                sys.exit(1)
            rc = node_login(handler)
            if rc != True:
                print('ERROR: failed to login.')
                node_quit(handler)
                sys.exit(1)
            config = config_get(handler)
            if config in [False, None]:
                print('ERROR: failed to retrieve config.')
                node_quit(handler)
                sys.exit(1)

            try:
                fd = open(filename, 'a')
                fd.write(config)
                fd.close()
            except:
                print('ERROR: cannot write config to file.')
                node_quit(handler)
                sys.exit(1)
        elif action == 'put':
            # For PUT, we don't need telnet connection, use docker cp directly
            if docker_id is None:
                print('ERROR: docker ID (-i) is required for put action.')
                sys.exit(1)
            rc = config_put(filename, docker_id, timeout_sec or 30, satellite_ip)
            if rc != True:
                print('ERROR: failed to push config.')
                sys.exit(1)

            # Remove lock file
            lock = '%s/.lock' %(os.path.dirname(filename))

            if os.path.exists(lock):
                os.remove(lock)

            # Mark as configured
            configured = '%s/.configured' %(os.path.dirname(filename))
            if not os.path.exists(configured):
                open(configured, 'a').close()

        if handler and handler.isalive():
            node_quit(handler)
        # Return (do not sys.exit) so multiprocessing sets child exitcode 0 reliably
        return

    except Exception as e:
        print('ERROR: got an exception')
        print(type(e))  # the exception instance
        print(e.args)   # arguments stored in .args
        print(e)        # __str__ allows args to be printed directly,
        if handler:
            node_quit(handler)
        sys.exit(1)

if __name__ == "__main__":
    action = None
    filename = None
    port = None
    docker_id = None
    satellite_ip = None

    # Getting parameters from command line
    try:
        opts, args = getopt.getopt(sys.argv[1:], 'a:p:t:f:i:s:', ['action=', 'port=', 'timeout=', 'file=', 'id=', 'satellite='])
    except getopt.GetoptError as e:
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
            except:
                port = -1
        elif o in ('-i', '--id'):
            docker_id = a
        elif o in ('-s', '--satellite'):
            satellite_ip = a
        elif o in ('-t', '--timeout'):
            try:
                timeout = int(a)
            except:
                timeout = -1
        else:
            print('ERROR: invalid parameter.')

    # Checking mandatory parameters
    if action == None or filename == None:
        usage()
        print('ERROR: missing mandatory parameters.')
        sys.exit(1)
    if action not in ['get', 'put']:
        usage()
        print('ERROR: invalid action.')
        sys.exit(1)
    if action == 'get' and port == None:
        usage()
        print('ERROR: port (-p) is required for get action.')
        sys.exit(1)
    if action == 'put' and docker_id == None:
        usage()
        print('ERROR: docker ID (-i) is required for put action.')
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
    if action == 'put' and not os.path.exists(filename):
        usage()
        print('ERROR: source file does not already exist.')
        sys.exit(1)

    # Backgrounding the script
    end_before = now() + timeout * 1000
    p = multiprocessing.Process(target=main, name="Main", kwargs={
        'action': action,
        'filename': filename,
        'port': port,
        'docker_id': docker_id,
        'timeout_sec': timeout,
        'satellite_ip': satellite_ip,
    })
    p.start()

    while (p.is_alive() and now() < end_before):
        # Waiting for the child process to end
        time.sleep(1)

    if p.is_alive():
        # Timeout occurred
        print('ERROR: timeout occurred.')
        p.terminate()
        p.join(timeout=30)

    # Reap child so exitcode is set (avoids exitcode None right after is_alive() becomes false)
    p.join(timeout=120)
    if p.exitcode is None:
        print('ERROR: subprocess exit code unavailable.')
        sys.exit(127)

    if p.exitcode != 0:
        sys.exit(127)

    sys.exit(0)
