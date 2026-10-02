#!/usr/bin/env python3

# scripts/config_ceos
#
# Import/Export script for Nokia SRLinux.
#
# @author Generated for EVE-NG
# @copyright 2024
# @license BSD-3-Clause
# @link http://www.eve-ng.net/
# @version 20240123

import getopt, multiprocessing, os, pexpect, re, subprocess, sys, time

username = 'admin'
password = 'eve'
conntimeout = 10     # Maximum time for console connection
expctimeout = 10     # Maximum time for each short expect
longtimeout = 60     # Maximum time for each long expect
timeout = 300        # Maximum run time (conntimeout is included)

def get_docker_name(path=None):
    """
    Calculate docker name from path (or current directory if path is None).
    Docker name format: {uuid}-{lab_id}-{node_id}
    Path format: /opt/unetlab/tmp/{lab_id}/{uuid}/{node_id}
    """
    if path is None:
        path = os.getcwd()
    # Normalize the path (remove trailing slashes)
    path = os.path.normpath(path)
    
    # Check if path looks like a node runtime path (/opt/unetlab/tmp/...)
    # If not, try to extract from filename if available
    if not path.startswith('/opt/unetlab/tmp/'):
        # Path doesn't look like a node runtime path
        # Try to use current directory anyway, but log a warning
        pass
    
    # Get node_id (basename of path)
    node_id = os.path.basename(path)
    # Get uuid (basename of parent dir)
    parent_dir = os.path.dirname(path)
    uuid = os.path.basename(parent_dir)
    # Get lab_id (basename of parent of parent dir)
    parent_parent_dir = os.path.dirname(parent_dir)
    lab_id = os.path.basename(parent_parent_dir)
    # Docker name format: {uuid}-{lab_id}-{node_id}
    docker_name = f"{uuid}-{lab_id}-{node_id}"
    return docker_name

def node_login(handler):
    """
    Login to cEOS console and get to prompt ending with #
    The console may be at different states:
    - Login prompt
    - Enable mode prompt (#)
    - Config mode prompt (config)#
    """
    # Send an empty line, and wait for the login prompt
    i = -1
    while i == -1:
        try:
            handler.sendline('\r\n')
            i = handler.expect([
                'login:',
                'Password:',
                '.*#.*',
                '.*\$.*',
                '.*>.*'], timeout = 5)
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
            handler.expect(['.*#.*', '.*\$.*'], timeout = expctimeout)
        except:
            print('ERROR: error waiting for shell prompt.')
            node_quit(handler)
            return False
        
        # Now we're logged in, should be at enable mode prompt
        try:
            handler.expect('.*#.*', timeout = expctimeout)
        except:
            print('ERROR: error waiting for "#" prompt after login.')
            node_quit(handler)
            return False
        return True
    elif i == 1:
        # Already at password prompt
        handler.sendline(password)
        try:
            handler.expect('.*#.*', timeout = expctimeout)
        except:
            print('ERROR: error waiting for "#" prompt after password.')
            node_quit(handler)
            return False
        return True
    elif i == 2:
        # Already at prompt ending with # - should be in enable mode
        handler.sendline('')
        try:
            handler.expect('.*#.*', timeout = 1)
            return True
        except:
            print('ERROR: error waiting for "#" prompt.')
            node_quit(handler)
            return False
    elif i == 3:
        # At prompt ending with $, might need to enable
        handler.sendline('enable')
        try:
            handler.expect('.*#.*', timeout = expctimeout)
        except:
            print('ERROR: error waiting for "#" prompt after enable.')
            node_quit(handler)
            return False
        return True
    elif i == 4:
        # At prompt ending with >, need to enable
        handler.sendline('enable')
        try:
            handler.expect('.*#.*', timeout = expctimeout)
        except:
            print('ERROR: error waiting for "#" prompt after enable.')
            node_quit(handler)
            return False
        return True
    else:
        # Unexpected output
        node_quit(handler)
        return False

def node_quit(handler):
    if handler.isalive() == True:
        handler.sendline('exit\n')
    handler.close()

def config_get(handler, filename, satellite_ip=None):
    """
    Get config from cEOS:
    1. Login and get to prompt ending with #
    2. Ensure we're in enable mode (not config mode)
    3. Execute 'write' command
    4. Wait 3 seconds
    5. Copy /mnt/flash/startup-config from docker to filename
    """
    # Set docker command prefix
    docker_cmd = ['docker']
    if satellite_ip:
        docker_cmd = ['docker', '-H', f'ssh://root@{satellite_ip}']
    
    # Login and get to prompt ending with #
    rc = node_login(handler)
    if rc != True:
        print('ERROR: failed to login.')
        node_quit(handler)
        return False

    # Clear expect buffer
    while True:
        try:
            handler.expect('.*#.*', timeout = 0.1)
        except:
            break

    # Make sure we're at the prompt and check if we're in config mode
    handler.sendline('')
    try:
        i = handler.expect(['.*\(config.*#.*', '.*#.*'], timeout = expctimeout)
    except:
        print('ERROR: error waiting for "#" prompt.')
        node_quit(handler)
        return False

    # Ensure we're in enable mode (not config mode)
    # If we're in config mode (prompt contains "(config"), exit to enable mode
    if i == 0:
        # We're in config mode, need to exit to enable mode
        handler.sendline('end')
        try:
            handler.expect('.*#.*', timeout = expctimeout)
        except:
            print('ERROR: error waiting for "#" prompt after end command.')
            node_quit(handler)
            return False

    # Execute 'write' command to save startup-config
    handler.sendline('write')
    try:
        handler.expect('.*#.*', timeout = longtimeout)
    except:
        print('ERROR: error waiting for "#" prompt after write command.')
        node_quit(handler)
        return False

    # Wait 3 seconds for write to complete
    time.sleep(3)

    # Get docker name from current directory
    # Note: script should be executed from node runtime path via chdir() in cli.php
    cwd = os.getcwd()
    docker_name = get_docker_name()
    
    # Docker name format: {uuid}-{lab_id}-{node_id}
    # UUID can contain dashes, so we can't just split by '-' to validate
    # Just check that docker_name is not empty
    if not docker_name:
        print(f'ERROR: invalid docker name calculated: "{docker_name}" from path: "{cwd}"')
        node_quit(handler)
        return False
    
    # Verify docker exists
    try:
        result = subprocess.run(docker_cmd + ['inspect', docker_name], 
                              capture_output=True, check=True, timeout=5)
    except subprocess.CalledProcessError:
        print(f'ERROR: container "{docker_name}" does not exist (calculated from path: "{cwd}").')
        node_quit(handler)
        return False
    except subprocess.TimeoutExpired:
        print(f'ERROR: timeout checking container "{docker_name}".')
        node_quit(handler)
        return False
    except Exception as e:
        print(f'ERROR: failed to check container "{docker_name}": {e}')
        node_quit(handler)
        return False

    # Copy startup-config from docker to filename
    try:
        result = subprocess.run(docker_cmd + ['cp', f'{docker_name}:/mnt/flash/startup-config', filename],
                              capture_output=True, check=True, timeout=longtimeout)
        print(f'OK: copied startup-config from container {docker_name} to {filename}')
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr.decode() if e.stderr else str(e)
        print(f'ERROR: failed to copy startup-config from container "{docker_name}": {error_msg}')
        node_quit(handler)
        return False
    except subprocess.TimeoutExpired:
        print(f'ERROR: timeout copying startup-config from container "{docker_name}".')
        node_quit(handler)
        return False
    except Exception as e:
        print(f'ERROR: failed to copy startup-config from container "{docker_name}": {e}')
        node_quit(handler)
        return False

    return True

def config_put(filename, docker_id=None, timeout_sec=30, satellite_ip=None):
    """
    Put config to cEOS:
    1. Use docker_id if provided, otherwise calculate docker name from current directory
    2. Copy filename to /mnt/flash/startup-config in docker
    """
    # Set docker command prefix
    docker_cmd = ['docker']
    if satellite_ip:
        docker_cmd = ['docker', '-H', f'ssh://root@{satellite_ip}']
    
    # Use provided docker_id or calculate from current directory (script is executed from node runtime path)
    if docker_id:
        docker_name = docker_id
    else:
        docker_name = get_docker_name()
    
    # Verify docker exists
    try:
        result = subprocess.run(docker_cmd + ['inspect', docker_name], 
                              capture_output=True, check=True, timeout=5)
    except subprocess.CalledProcessError:
        print(f'ERROR: container "{docker_name}" does not exist.')
        return False
    except subprocess.TimeoutExpired:
        print(f'ERROR: timeout checking container "{docker_name}".')
        return False
    except Exception as e:
        print(f'ERROR: failed to check container "{docker_name}": {e}')
        return False

    # Copy config file to docker
    try:
        result = subprocess.run(docker_cmd + ['cp', filename, f'{docker_name}:/mnt/flash/startup-config'],
                              capture_output=True, check=True, timeout=timeout_sec)
        print(f'OK: copied config file to /mnt/flash/startup-config in container {docker_name}')
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr.decode() if e.stderr else str(e)
        print(f'ERROR: failed to copy config file to container "{docker_name}": {error_msg}')
        return False
    except subprocess.TimeoutExpired:
        print(f'ERROR: timeout copying config file to container "{docker_name}".')
        return False
    except Exception as e:
        print(f'ERROR: failed to copy config file to container "{docker_name}": {e}')
        return False

    return True

def usage():
    print('Usage: %s <standard options>' %(sys.argv[0]));
    print('Standard Options:');
    print('-a <s>    *Action can be:')
    print('           - get: get the startup-configuration and push it to a file')
    print('           - put: put the file as startup-configuration')
    print('-f <s>    *File');
    print('-p <n>    *Console port (mandatory for get, optional for put)');
    print('-i <s>    Docker container ID/name (optional for put, calculated from current dir if not provided)');
    print('-t <n>     Timeout (default = %i)' %(timeout));
    print('-s <s>     Satellite IP (for remote Docker)');
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

            rc = config_get(handler, filename, satellite_ip)
            if rc != True:
                print('ERROR: failed to retrieve config.')
                if handler:
                    node_quit(handler)
                sys.exit(1)
        elif action == 'put':
            # For PUT, we don't need telnet connection, use docker cp directly
            rc = config_put(filename, docker_id, timeout_sec or longtimeout, satellite_ip)
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
        sys.exit(0)

    except Exception as e:
        print('ERROR: got an exception')
        print(type(e))  # the exception instance
        print(e.args)   # arguments stored in .args
        print(e)        # __str__ allows args to be printed directly,
        if handler:
            node_quit(handler)
        return False

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
        elif o in ('-t', '--timeout'):
            try:
                timeout = int(a)
            except:
                timeout = -1
        elif o in ('-i', '--id'):
            docker_id = a
        elif o in ('-s', '--satellite'):
            satellite_ip = a
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
        print('ERROR: source file does not exist.')
        sys.exit(1)

    # Backgrounding the script
    end_before = now() + timeout * 1000
    # Use kwargs to avoid issues with argument order
    p = multiprocessing.Process(target=main, name="Main", kwargs={
        'action': action,
        'filename': filename,
        'port': port,
        'docker_id': docker_id,
        'timeout_sec': timeout,
        'satellite_ip': satellite_ip
    })
    p.start()

    while (p.is_alive() and now() < end_before):
        # Waiting for the child process to end
        time.sleep(1)

    if p.is_alive():
        # Timeout occurred
        print('ERROR: timeout occurred.')
        p.terminate()
        sys.exit(127)

    if p.exitcode != 0:
        sys.exit(127)

    sys.exit(0)
