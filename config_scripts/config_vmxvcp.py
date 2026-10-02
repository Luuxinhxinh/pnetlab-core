#!/usr/bin/env python3

# scripts/config_vmxvcp.py
#
# Import/Export script for Juniper vMX VCP.
#
# @author Andrea Dainese <andrea.dainese@gmail.com>
# @author Alain Degreffe <eczema@ecze.com>
# @author Christopher Lim <cli@machfira.ch>
# @copyright 2014-2016 Andrea Dainese
# @copyright 2017-2018 Alain Degreffe
# @copyright 2019-2020 Christopher Lim
# @license BSD-3-Clause https://github.com/dainok/unetlab/blob/master/LICENSE
# @link http://www.eve-ng.net/
# @version 20200608
import getopt, multiprocessing, os, pexpect, re, sys, time

username = 'root'
password = 'Juniper'
conntimeout = 3     # Maximum time for console connection
expctimeout = 6     # Maximum time for each short expect
longtimeout = 60    # Maximum time for each long expect
boottimeout = 15    # Maximum time to wait for boot to finish (check for Auto-Upgrade message)
timeout = 60        # Maximum run time (conntimeout is included) -> this is never used as it is always overridden!
location = -1       # Initial value of the location to return to
license = None      # variable used for the license if license.txt exists

def node_login(handler):
    # Send an empty line while waiting for the login prompt
    global location
    while location == -1:
        try:
            handler.sendline('\r\n')
            location = handler.expect([
                'login: $',
                r'[\w_-]+@?[\w_-]+% $',
                r'[\w_-]+@?[\w_-]+> $',
                r'[\w_-]+@?[\w_-]+# $',
                r'[\w_-]+@?[\w_-]*:\~ # $'], timeout = 5)
        except:
            location = -1
    if location == 0:
        # Need to send username and password
        handler.sendline(username)
        try:
            j = handler.expect([r'[\w_-]+@?[\w_-]*:\~ # $', 'Password:'], timeout = longtimeout)
        except:
            print(r'ERROR: error waiting for ["[\w_-]+@?[\w_-]*:\~ # $", "password:"] prompt.')
            node_quit(handler)
            return False
        if j == 0:
            # Nothing to do
            return True
        elif j == 1:
            handler.sendline(password)
            try:
                handler.expect(r'[\w_-]+@?[\w_-]*:\~ # $', timeout = longtimeout)
            except:
                print(r'ERROR: error waiting for "[\w_-]+@?[\w_-]*:\~ # $" prompt.')
                node_quit(handler)
                return False
            return True
        else:
            # Unexpected output
            node_quit(handler)
            return False
    elif location == 1:
        # Nothing to do
        return True
    elif location == 2:
        # Exit from CLI mode
        handler.sendline('exit')
        try:
            handler.expect(r'[\w_-]+@?[\w_-]*:\~ # $', timeout = expctimeout)
        except:
            print('ERROR: error waiting for root prompt.')
            node_quit(handler)
            return False
        return True
    elif location == 3:
        # Exit from configuration mode
        handler.sendline('top')
        try:
            handler.expect(r'[\w_-]+@?[\w_-]+# $', timeout = expctimeout)
        except:
            print('ERROR: error waiting for configuration prompt.')
            node_quit(handler)
            return False
        handler.sendline('exit')
        try:
            handler.expect(r'[\w_-]+@?[\w_-]+> $', timeout = expctimeout)
        except:
            print('ERROR: error waiting for cli prompt.')
            node_quit(handler)
            return False
        # Exit from CLI mode
        handler.sendline('exit')
        try:
            handler.expect(r'[\w_-]*@[\w_-]*:\~ #', timeout = expctimeout)
        except:
            print('ERROR: error waiting for root prompt.')
            node_quit(handler)
            return False
        return True
    elif location == 4:
        return True
    else:
        # Unexpected output
        node_quit(handler)
        return False

def node_quit(handler):
    if handler.isalive() == True:        
        handler.sendline('')
    handler.close()

def config_get(handler):
    # Clearing all "expect" buffer
    while True:
        try:
            handler.expect(r'[\w_-]+@?[\w_-]+# $', timeout = 0.1)
        except:
            break
    # Go into CLI mode
    handler.sendline('cli')
    try:
        handler.expect(r'[\w_-]+@?[\w_-]+> $', timeout = longtimeout)
    except:
        print('ERROR: error waiting for cli prompt.')
        node_quit(handler)
        return False
    # Disable paging
    handler.sendline('set cli screen-length 0')
    try:
        handler.expect(r'[\w_-]+@?[\w_-]+> $', timeout = longtimeout)
    except:
        print('ERROR: error waiting for cli prompt.')
        node_quit(handler)
        return False
    # Getting the config
    handler.sendline('show configuration | display set')
    try:
        handler.expect(r'[\w_-]+@?[\w_-]+> $', timeout = longtimeout)
    except:
        print('ERROR: error waiting for cli prompt.')
        node_quit(handler)
        return False
    # Catch the config and put it into a variable
    config = handler.before.decode()
    # Default paging
    time.sleep(1)
    handler.sendline('set cli screen-length 24')
    try:
        handler.expect(r'[\w_-]+@?[\w_-]+> $', timeout = longtimeout)
    except:
        print('ERROR: error waiting for cli prompt.')
        node_quit(handler)
        return False
    handler.sendline('exit')
    handler.sendline('history -c')
    handler.sendline('clear')
    # Exit from linux mode
    if location == 0:
        handler.sendline('exit')
        try:
            handler.expect(['login:'], timeout = expctimeout)
        except:
            print('ERROR: error waiting for login prompt.')
            node_quit(handler)
            return False
    # Enter cli mode
    if location >= 2:
        handler.sendline('cli')
        try:
            handler.expect(r'[\w_-]+@?[\w_-]+> $', timeout = longtimeout)
        except:
            print('ERROR: error waiting for cli prompt.')
            node_quit(handler)
            return False
    # Enter config mode
    if location == 3:
        handler.sendline('edit')
        try:
            handler.expect([r'[\w_-]+@?[\w_-]+# $'], timeout = expctimeout)
        except:
            print('ERROR: error waiting for config prompt.')
            node_quit(handler)
            return False
    # Manipulating the config to look as required
    config = re.sub('\r', '', config)                                                           # Unix style
    config = re.sub('^(?!(^set)).+$', '', config, flags=re.MULTILINE)                           # Remove anything but set commands
    #config = re.sub('.*show configuration \| display set', '', config)                          # Remove Header
    #config = re.sub('\n[\w_-]+@?[\w_-]+>.*', '\n', config)                                      # Remove Footer
    config = re.sub('\n\n+', '\n', config)                                                      # Remove double newlines
    config = re.sub('^\n|\n$', '', config)                                                      # Remove empty lines at the beginning and end
    return config

def config_put(handler):
    # Create empty file
    handler.sendline('touch /var/tmp/emptyfile')
    # mount drive and wait for boot to finish, speculating on a console message
    handler.sendline('mount -t cd9660 /dev/cd1 /mnt')
    try:
        handler.expect('mount_cd9660', timeout = expctimeout)
        handler.sendline('mount -t cd9660 /dev/cd0 /mnt')
    except:
        pass
    try:
        handler.expect(['delete chassis auto-image-upgrade'], timeout = boottimeout)
    except:
        print('NOTIFICATION: Auto image Upgrade log entry not found, continuing...')
    time.sleep(expctimeout)
    # Go into CLI mode
    handler.sendline('cli')
    try:
        handler.expect(r'[\w_-]+@?[\w_-]+> $', timeout = longtimeout)
    except:
        print('ERROR: error waiting for cli prompt.')
        node_quit(handler)
        return False
    # Go to configure mode
    handler.sendline('edit private')
    try:
        handler.expect(r'[\w_-]+@?[\w_-]+# $', timeout = longtimeout)
    except:
        print('ERROR: error waiting for config prompt.')
        node_quit(handler)
        return False
    # disable auto-upgrade, special handling needed in case access is currently locked by auto-upgrade, does not cause an error if it does not work because this part is not crucial if the rest works
    handler.sendline('delete chassis auto-image-upgrade')
    loops = 1
    while loops <= 5:
        handler.sendline('commit')
        try:
            handler.expect('commit complete', timeout = expctimeout)
        except:
            print('ERROR: error waiting for commit complete message.')
            loops += 1
        loops = 10
    # Load empty config
    handler.sendline('load override /var/tmp/emptyfile')
    try:
        handler.expect('load complete', timeout = longtimeout)
    except:
        print('ERROR: error waiting for "load complete" message.')
        node_quit(handler)
        return False
    # Load the config from mounted directory
    handler.sendline('load set /mnt/juniper.conf')
    try:
        handler.expect('load complete', timeout = longtimeout)
    except:
        print('ERROR: error waiting for "load complete" message.')
        node_quit(handler)
        return False
    # Save/Commit
    connectionlost = -1
    handler.sendline('commit')
    time.sleep(expctimeout)
    try:
        connectionlost = handler.expect([r'[\w_-]+@?[\w_-]+# $', r'[\w_-]+@?[\w_-]*:\~ # $'], timeout = longtimeout)
    except:
        print('ERROR: error waiting for configuration or root prompt.')
        node_quit(handler)
        return False
    # Apply a license if it exists
    if not license == None:
        handler.sendline('run request system license add terminal')
        try:
            handler.expect('license key', timeout = longtimeout)
        except:
            print('ERROR: error waiting for license prompt.')
            node_quit(handler)
            return False
        handler.sendline(license + "\n")
        handler.sendcontrol('d')
        try:
            handler.expect(r'[\w_-]+@?[\w_-]+# $', timeout = longtimeout)
        except:
            print('ERROR: error waiting for configuration prompt.')
            node_quit(handler)
            return False
    # Exit configuration mode
    if connectionlost == 0:
        handler.sendline('exit')
        try:
            handler.expect(r'[\w_-]+@?[\w_-]+> $', timeout = longtimeout)
        except:
            print('ERROR: error waiting for cli prompt.')
            node_quit(handler)
            return False
    # Exit cli mode to clear session data (does not log you out)
    if connectionlost == 0:
        handler.sendline('exit')
        try:
            handler.expect([r'[\w_-]+@?[\w_-]*:\~ # $'], timeout = longtimeout)
        except:
            print('ERROR: error waiting for root prompt.')
            node_quit(handler)
            return False
    # Clear history
    handler.sendline('history -c')
    handler.sendline('clear')
    try:
        handler.expect([r'[\w_-]+@?[\w_-]*:\~ # $'], timeout = longtimeout)
    except:
        print('ERROR: error waiting for root prompt.')
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
        # Login to the device and go to the required prompt
        rc = node_login(handler)
        if rc != True:
            print('ERROR: failed to login.')
            node_quit(handler)
            sys.exit(1)
        # If the wanted action is to "get" the config, capture the config and write it into a file
        if action == 'get':
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
        # If the wanted action is to "put" the config, push the config to the device
        elif action == 'put':
            rc = config_put(handler)
            if rc != True:
                print('ERROR: failed to push config.')
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
    licensefile = None
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
            licensefile = '%s/license.txt' %(os.path.dirname(filename))
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
        # If a license file exists, put it into a variable
        if os.path.exists(licensefile):
            try:
                fd = open(licensefile, 'r')
                license = re.sub(r"\r\n|\r", "\n", fd.read())
                fd.close()
            except:
                usage()
                print('ERROR: cannot read from license file.')
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
