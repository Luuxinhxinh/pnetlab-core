#!/usr/bin/env python3

# scripts/config_veos.py
#
# Import/Export script for Arista vEOS.
#
# @author Andrea Dainese <andrea.dainese@gmail.com>
# @author Alain Degreffe <eczema@ecze.com>
# @author Christopher Lim <cli@machfira.ch>
# @copyright 2014-2016 Andrea Dainese
# @copyright 2017-2018 Alain Degreffe
# @copyright 2021-2021 Christopher Lim
# @license BSD-3-Clause https://github.com/dainok/unetlab/blob/master/LICENSE
# @link http://www.eve-ng.net/
# @version 20210427
import getopt, multiprocessing, os, pexpect, re, sys, time

username = 'admin'
password = 'password'
secret = 'password'
conntimeout = 3     # Maximum time for console connection
expctimeout = 6     # Maximum time for each short expect
longtimeout = 60    # Maximum time for each long expect
boottimeout = 30    # Maximum time to wait for boot to finish (check for Auto-Upgrade message)
timeout = 60        # Maximum run time (conntimeout is included) -> this is never used as it is always overridden!
location = -1       # Initial value of the location to return to
configput = -1      # Initial value of variable for testing if device is already configured and ZTP is active

def node_login(handler):
    # Send an empty line while waiting for the login prompt
    global location
    location = -1
    while location == -1:
        try:
            handler.sendline('\r\n')
            location = handler.expect([
                r'\n[\w_-]+ login: $',
                r'\n[\w_-]+>$',
                r'\n[\w_-]+#$',
                r'\n\[[\w_-]+@?[\w_-]+ \~\]\$ $',
                r'\n[\w_-]+\(config[\w_-]*\)#$'], timeout = 5)
        except:
            location = -1
    if location == 0:
        # Need to send username and password
        handler.sendline(username)
        try:
            j = handler.expect([r'\n[\w_-]+>$', 'Password: $'], timeout = longtimeout)
        except:
            print(r'ERROR: error waiting for ["[\w_-]+>$", "Password: $"] prompt.')
            node_quit(handler)
            return False
        if j == 0:
            # Nothing to do
            pass
        elif j == 1:
            handler.sendline(password)
            try:
                handler.expect(r'[\w_-]+>$', timeout = longtimeout)
            except:
                print(r'ERROR: error waiting for "[\w_-]+>$" prompt.')
                node_quit(handler)
                return False
    if location < 2:
        # Enter enable mode
        handler.sendline('enable')
        try:
            j = handler.expect([r'\n[\w_-]+#$', 'Password: $'], timeout = longtimeout)
        except:
            print(r'ERROR: error waiting for ["[\w_-]+#$", "Password: $"] prompt.')
            node_quit(handler)
            return False
        if j == 0:
        # Nothing to do
            return True
        elif j == 1:
            handler.sendline(secret)
            try:
                handler.expect(r'[\w_-]+#$', timeout = longtimeout)
            except:
                print(r'ERROR: error waiting for "[\w_-]+#$" prompt.')
                node_quit(handler)
                return False
            return True
        else:
            # Unexpected output
            node_quit(handler)
            return False
    elif location == 2:
        # Nothing to do
        return True
    elif location == 3:
        # Exit from shell
        handler.sendline('logout')
        try:
            handler.expect(r'[\w_-]+\(config[\w_-]*\)#$', timeout = expctimeout)
        except:
            print(r'ERROR: error waiting for "[\w_-]+\(config[\w_-]*\)#$" prompt.')
            node_quit(handler)
            return False
        return True
    elif location == 4:
        # Nothing to do
        return True
    else:
        # Unexpected output
        node_quit(handler)
        return False

def node_quit(handler):
    if handler.isalive() == True:
        handler.sendline('')
    handler.close()

def config_get_pre(handler):
    # Disable paging
    handler.sendline('run terminal length 32767')
    handler.sendline('run terminal length 0')
    try:
        handler.expect(r'[\w_-]+(\(config[\w_-]*\))?#$', timeout = expctimeout)
    except:
        print('ERROR: error waiting for prompt (2).')
        node_quit(handler)
        return False
    return True

def config_get_post(handler):
    # Default paging
    handler.sendline('run terminal length 24')
    handler.sendline('run no terminal length')
    handler.sendline('clear history')
    handler.sendcontrol('l')
    try:
        handler.expect(r'[\w_-]+(\(config[\w_-]*\))?#$', timeout = expctimeout)
    except:
        print('ERROR: error waiting for prompt (3).')
        node_quit(handler)
        return False
    # Return to original location
    if location == 0:
        # Exit to login prompt
        handler.sendline('logout')
        try:
            handler.expect(r'[\w_-]+ login: $', timeout = expctimeout)
        except:
            print('ERROR: error waiting for login prompt.')
            node_quit(handler)
            return False
    if location == 1:
        # Exit to prompt
        handler.sendline('disable')
        try:
            handler.expect(r'[\w_-]+>$', timeout = expctimeout)
        except:
            print('ERROR: error waiting for prompt (0).')
            node_quit(handler)
            return False
    if location == 2:
        # Nothing to do, stay in enable mode
        pass
    if location == 3:
        handler.sendline('bash')
        try:
            handler.expect(r'\[[\w_-]+@?[\w_-]+ \~\]\$ $', timeout = expctimeout)
        except:
            print('ERROR: error waiting for bash prompt.')
            node_quit(handler)
            return False
    if location == 4:
        # Nothing to do, stay in config mode
        pass
    return True

def config_get(handler):
    while True:
        try:
            handler.expect(r'[\w_-]+(\(config[\w_-]*\))?#$', timeout = 0.1)
        except:
            break
    # Getting the config
    handler.sendline('more system:running-config')
    try:
        handler.expect(r'[\w_-]+(\(config[\w_-]*\))?#$', timeout = expctimeout)
    except:
        print('ERROR: error waiting for prompt (1).')
        node_quit(handler)
        return False
    # Catch the config and put it into a variable
    config = handler.before.decode()
    # Manipulating the config to look as required
    config = re.sub('\r', '', config)                                                           # Unix style
    config = re.sub('.*more system:running-config\n', '', config, flags=re.DOTALL)              # Header
    config = re.sub('\n\n+', '\n', config)                                                      # Remove double newlines
    config = re.sub('\x1b', '', config)                                                         # Remove chars at the end
    config = re.sub(r'\[.*$', '', config)                                                        # Remove chars at the end
    config = re.sub('^\n|\n$', '', config)                                                      # Remove empty lines at the beginning and end
    return config

def config_disztp(handler):
    # Disable Zerotouch
    handler.sendline('\r\n')
    handler.sendline('zerotouch disable')
    time.sleep(boottimeout)
    return True
    
def config_put_pre(handler):
    # Send an empty line while waiting for the login prompt
    global configput
    configput = -1
    while configput == -1:
        try:
            handler.sendline('\r\n')
            configput = handler.expect([
                'No startup-config was found',
                '\nlocalhost login: $',
                r'\n[\w_-]+ login: $'], timeout = 5)
        except:
            configput = -1
    return configput

def config_put(handler):
    # Go to configure mode
    handler.sendline('configure terminal')
    try:
        handler.expect(r'[\w_-]+\(config[\w_-]*\)#$', timeout = expctimeout)
    except:
        print('ERROR: error waiting for config prompt.')
        node_quit(handler)
        return False
    # Pushing the config
    for line in config.splitlines():
        handler.sendline(line)
        try:
            handler.expect('\r\n', timeout = longtimeout)
        except:
            print('ERROR: error waiting for EOL.')
            node_quit(handler)
            return False
    # save config
    handler.sendline('copy running-config startup-config')
    handler.sendline('clear history')
    handler.sendcontrol('l')
    try:
        handler.expect(r'[\w_-]+(\(config[\w_-]*\))?#$', timeout = expctimeout)
    except:
        print('ERROR: error waiting for config prompt.')
        node_quit(handler)
        return False
    return True

def usage():
    print('Usage: %s <standard options>' %(sys.argv[0]));
    print('Standard Options:');
    print('-a <s>    *Action can be:')
    print('           - get: get the startup-configuration and push it to a file')
    print('           - put: put the file as startup-configuration')
    print('-f <s>    *File');
    print('-p <n>    *Console port');
    print('-t <n>     Timeout (default = %i)' %(timeout));
    print('* Mandatory option')

def now():
    # Return current UNIX time in milliseconds
    return int(round(time.time() * 1000))

def main():
    try:
        # Connect to the device
        tmp = conntimeout
        while (tmp > 0):
            handler = pexpect.spawn('telnet 127.0.0.1 %i' %(port))
            time.sleep(0.1)
            tmp = tmp - 0.1
            if handler.isalive() == True:
                break
        if (handler.isalive() != True):
            print('ERROR: cannot connect to port "%i".' %(port))
            node_quit(handler)
            sys.exit(1)
        # If the wanted action is to "get" the config, capture the config and write it into a file
        if action == 'get':
            # Login to the device and go to the required prompt
            rc = node_login(handler)
            if rc != True:
                print('ERROR: failed to login (1).')
                node_quit(handler)
                sys.exit(1)
            rc = config_get_pre(handler)
            if rc != True:
                print('ERROR: failed to retrieve config (pre).')
                node_quit(handler)
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
            rc = config_get_post(handler)
            if rc != True:
                print('ERROR: failed to retrieve config (post).')
                node_quit(handler)
        # If the wanted action is to "put" the config, push the config to the device
        elif action == 'put':
            cs = config_put_pre(handler)
            if cs == 0:                
                rc = node_login(handler)
                if rc != True:
                    print('ERROR: failed to login (2).')
                    node_quit(handler)
                    sys.exit(1)
                config_disztp(handler)
                rc = node_login(handler)
                if rc != True:
                    print('ERROR: failed to login (3).')
                    node_quit(handler)
                    sys.exit(1)
                rc = config_put(handler)
                if rc != True:
                    print('ERROR: failed to push config (1).')
                    node_quit(handler)
                    sys.exit(1)
            elif cs == 1:
                rc = node_login(handler)
                if rc != True:
                    print('ERROR: failed to login (4).')
                    node_quit(handler)
                    sys.exit(1)
                rc = config_put(handler)
                if rc != True:
                    print('ERROR: failed to push config (2).')
                    node_quit(handler)
                    sys.exit(1)
            elif cs == 2:
                pass
            else:
                print('ERROR: Unexptected Error (1).')
                node_quit(handler)
                sys.exit(1)
            # Remove lock file
            lock = '%s/.lock' %(os.path.dirname(filename))
            if os.path.exists(lock):
                os.remove(lock)
            # Mark as configured
            configured = '%s/.configured' %(os.path.dirname(filename))
            if not os.path.exists(configured):
                open(configured, 'a').close()
        node_quit(handler)
        sys.exit(0)
    except Exception as e:
        print('ERROR: got an exception')
        print(type(e))  # the exception instance
        print(e.args)   # arguments stored in .args
        print(e)        # __str__ allows args to be printed directly,
        node_quit(handler)
        return False

if __name__ == "__main__":
    action = None
    filename = None
    port = None
    # Getting parameters from command line
    try:
        opts, args = getopt.getopt(sys.argv[1:], 'a:p:t:f:', ['action=', 'port=', 'timeout=', 'file='])
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
                timeout = int(a) * 1000
            except:
                timeout = -1
        else:
            print('ERROR: invalid parameter.')
    # Checking mandatory parameters
    if action == None or port == None or filename == None:
        usage()
        print('ERROR: missing mandatory parameters.')
        sys.exit(1)
    if action not in ['get', 'put']:
        usage()
        print('ERROR: invalid action.')
        sys.exit(1)
    if timeout < 0:
        usage()
        print('ERROR: timeout must be 0 or higher.')
        sys.exit(1)
    if port < 0:
        usage()
        print('ERROR: port must be 0 or higher.')
        sys.exit(1)
    if action == 'get' and os.path.exists(filename):
        usage()
        print('ERROR: destination file already exists.')
        sys.exit(1)
    if action == 'put' and not os.path.exists(filename):
        usage()
        print('ERROR: source file does not already exist.')
        sys.exit(1)
    if action == 'put':
        try:
            fd = open(filename, 'r')
            config = fd.read()
            fd.close()
        except:
            usage()
            print('ERROR: cannot read from file.')
            sys.exit(1)
    # Backgrounding the script
    end_before = now() + timeout
    p = multiprocessing.Process(target=main, name="Main")
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
