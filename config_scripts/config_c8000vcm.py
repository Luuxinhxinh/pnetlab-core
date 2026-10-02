#!/usr/bin/env python3

# config_c8000vcm.py
#
# Import/Export script for c8000v in controller mode.
#
# @author Torbjørn Bang <hei@torbjorn.dev>
# @copyright 2023 Torbjørn Bang
# @license BSD-3-Clause https://github.com/torbbang/eve-ng_c8000vcm/blob/main/LICENSE

# scripts/config_csr1000v.py
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

import getopt, multiprocessing, os, pexpect, re, sys, time

username = 'eveconfigscraper'
password = 'eveconfigscraper'
secret = 'eveconfigscraper'
conntimeout = 3     # Maximum time for console connection
expctimeout = 3     # Maximum time for each short expect
longtimeout = 30    # Maximum time for each long expect
timeout = 60        # Maximum run time (conntimeout is included)

def node_login(handler):
    i = -1
    while i == -1:
        try:
            handler.sendline('\r\n')
            i = handler.expect([
                'Username:',
                '\(config',
                'Uncommitted changes found',
                '>',
                '#'], timeout = 5)
        except:
            i = -1

    if i == 0:
        handler.sendline(username)
        try:
            handler.expect('Password:', timeout = expctimeout)
        except:
            print('ERROR: error waiting for "Password:" prompt.')
            node_quit(handler)
            return False

        handler.sendline(password)
        try:
            j = handler.expect(['Enter new password:', '>', '#'], timeout = expctimeout)
        except:
            print('ERROR: error waiting for ["Enter new password:", ">", "#"] prompt.')
            node_quit(handler)
            return False

        if j == 0:
            handler.sendline(password)
            try:
                handler.expect('Confirm password:', timeout = expctimeout)
            except:
                print('ERROR: error waiting for "Confirm password:" prompt.')
                node_quit(handler)
                return False
            handler.sendline(password)
            try:
                handler.expect('#', timeout = expctimeout)
            except:
                print('ERROR: error waiting for "#" prompt.')
                node_quit(handler)
                return False
            return True
        elif j == 1:
            handler.sendline(secret)
            try:
                handler.expect('#', timeout = expctimeout)
            except:
                print('ERROR: error waiting for "#" prompt.')
                node_quit(handler)
                return False
            return True
        elif j == 2:
            return True
        else:
            node_quit(handler)
            return False
    elif i == 1:
        handler.sendline('end')
        try:
            k = handler.expect(['#', 'Uncommitted changes found'], timeout = expctimeout)
        except:
            print('ERROR: error waiting for "#" or "Uncommitted changes found".')
            node_quit(handler)
            return False
        if k == 0:
            return True
        elif k == 1:
            handler.sendline('no')
            try:
                handler.expect('#')
            except:
                print('ERROR: error waiting for "#" prompt after not committing changes.')
                node_quit(handler)
                return False
            return True
        else:
            node_quit(handler)
            return False
    elif i == 2:
        handler.sendline('no')
        try:
            handler.expect('#')
        except:
            print('ERROR: error waiting for "#" prompt after not committing changes.')
            node_quit(handler)
            return False
        return True
    elif i == 3:
        handler.sendline('enable')
        try:
            j = handler.expect(['Password:', '#'])
        except:
            print('ERROR: error waiting for ["Password:", "#"] prompt.')
            node_quit(handler)
            return False
        if j == 0:
            handler.sendline(secret)
            try:
                handler.expect('#', timeout = expctimeout)
            except:
                print('ERROR: error waiting for "#" prompt.')
                node_quit(handler)
                return False
            return True
        elif j == 1:
            return True
        else:
            node_quit(handler)
            return False
    elif i == 4:
        return True
    else:
        node_quit(handler)
        return False

def node_quit(handler):
    if handler.isalive() == True:
        handler.sendline('exit\n')
    handler.close()

def cacert_check(handler):
    while True:
        try:
            handler.expect('#', timeout = 0.1)
        except:
            break

    handler.sendline('more flash:sdwan/usr/share/viptela/root-ca.crt')
    try:
        handler.expect('#', timeout = longtimeout)
    except:
        handler.sendline('')
        try:
            handler.expect('#', timeout = longtimeout)
        except:
            print('ERROR: error waiting for "#" prompt.')
            node_quit(handler)
            return False
    rootChainOutput = handler.before.decode()
    if len(rootChainOutput) > 2000:
        return False
    else:
        return True

def cacert_get(handler):
    while True:
        try:
            handler.expect('#', timeout = 0.1)
        except:
            break

    handler.sendline('more flash:sdwan/usr/share/viptela/root-ca.crt')
    try:
        handler.expect('#', timeout = longtimeout)
    except:
        print('ERROR: error waiting for "#" prompt.')
        node_quit(handler)
        return False
    cacert = handler.before.decode()

    cacert = re.sub('\r', '', cacert, flags=re.DOTALL)
    cacert = re.sub('.*more flash:sdwan/usr/share/viptela/root-ca.crt\n', '', cacert, flags=re.DOTALL)
    cacert = re.sub('\n\*.{20,22}%SEC_LOGIN-5-LOGIN_SUCCESS.*?\n', '', cacert, flags=re.DOTALL)
    cacert = re.sub('\n(?!.*\n).*', '', cacert, flags=re.DOTALL)

    return cacert

def config_get(handler):
    while True:
        try:
            handler.expect('#', timeout = 0.1)
        except:
            break

    handler.sendline('terminal length 0')
    try:
        handler.expect('#', timeout = expctimeout)
    except:
        print('ERROR: error waiting for "#" prompt.')
        node_quit(handler)
        return False

    handler.sendline('show sdwan running-config')
    try:
        handler.expect('#', timeout = longtimeout)
    except:
        print('ERROR: error waiting for "#" prompt.')
        node_quit(handler)
        return False
    config = handler.before.decode()

    config = re.sub('\r', '', config, flags=re.DOTALL)
    config = re.sub('.*show sdwan running-config\n', '', config, flags=re.DOTALL)
    config = re.sub('\n\*.{20,22}%SEC_LOGIN-5-LOGIN_SUCCESS.*?\n', '', config, flags=re.DOTALL)
    config = re.sub('\n(?!.*\n).*', '', config, flags=re.DOTALL)

    return config

def config_put(handler):
    while True:
        try:
            i = handler.expect(['%IOSXE-5-PLATFORM: R0/0: vip-bootstrap: All daemons up',
               '%IOSXE-3-PLATFORM: R0/0: vip-bootstrap: Error extracting config'], timeout * 8)
        except:
            return False
        return True

def usage():
    print('Usage: %s <standard options>' %(sys.argv[0]))
    print('Standard Options:')
    print('-a <s>    *Action can be:')
    print('           - get: get the startup-configuration and push it to a file')
    print('           - put: put the file as startup-configuration')
    print('-f <s>    *File')
    print('-p <n>    *Console port')
    print('-t <n>     Timeout (default = %i)' %(timeout))
    print('* Mandatory option')

def now():
    return int(round(time.time() * 1000))

def main(action, filename, port):
    try:
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

        if action == 'get':
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
            if cacert_check(handler) == True:
                cacert = cacert_get(handler)
                if cacert in [False, None]:
                    print('ERROR: failed to retrieve config.')
                    node_quit(handler)
                    sys.exit(1)

                bootstrapTemplate = ('Content-Type: multipart/mixed; boundary="==============u7fnxr6d=============="\n'
                                     'MIME-Version: 1.0\n'
                                     '--==============u7fnxr6d==============\n'
                                     '#cloud-config\n'
                                     'vinitparam:\n'
                                     ' - uuid : C8K-00000000-0000-0000-0000-000000000000\n'
                                     ' - otp : 00000000000000000000000000000000\n'
                                     ' - vbond : 203.0.113.1\n'
                                     ' - org : eve-lab\n'
                                     ' - rcc : true\n'
                                     'ca-certs:\n'
                                     '  trusted:\n'
                                     '  - |\n'
                                     '{cacert}\n'
                                     '  remove-defaults: false\n'
                                     '--==============u7fnxr6d==============\n'
                                     '#cloud-boothook\n'
                                     '{config}\n'
                                     '--==============u7fnxr6d==============--')

                cacert = '\n'.join([(4 * ' ') + line for line in cacert.split('\n')])
                config = '\n'.join([(2 * ' ') + line for line in config.split('\n')])
                outConfig = bootstrapTemplate.format(config=config, cacert=cacert)
            else:
                outConfig = config

            try:
                fd = open(filename, 'a')
                fd.write(outConfig)
                fd.close()
            except:
                print('ERROR: cannot write config to file.')
                node_quit(handler)
                sys.exit(1)

        elif action == 'put':
            rc = config_put(handler)
            if rc != True:
                print('ERROR: failed to push config.')
                node_quit(handler)
                sys.exit(1)

            lock = '%s/.lock' %(os.path.dirname(filename))
            if os.path.exists(lock):
                os.remove(lock)

            configured = '%s/.configured' %(os.path.dirname(filename))
            if not os.path.exists(configured):
                open(configured, 'a').close()

        node_quit(handler)
        sys.exit(0)

    except Exception as e:
        print('ERROR: got an exception')
        print(type(e))
        print(e.args)
        print(e)
        node_quit(handler)
        return False

if __name__ == "__main__":
    action = None
    filename = None
    port = None

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
                timeout = int(a)
            except:
                timeout = -1
        else:
            print('ERROR: invalid parameter.')

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
    if action == 'put':
        try:
            fd = open(filename, 'r')
            config = fd.read()
            fd.close()
        except:
            usage()
            print('ERROR: cannot read from file.')
            sys.exit(1)

    end_before = now() + timeout * 10000
    p = multiprocessing.Process(target=main, name="Main", args=(action, filename, port))
    p.start()

    while (p.is_alive() and now() < end_before):
        time.sleep(1)

    if p.is_alive():
        print('ERROR: timeout occurred.')
        p.terminate()
        sys.exit(127)

    if p.exitcode != 0:
        sys.exit(127)

    sys.exit(0)
