#!/usr/bin/env python3

# scripts/config_mikrotik.py
#
# Import/Export script for Mikrotik.
#
# @author Andrea Dainese <andrea.dainese@gmail.com>
# @author Alain Degreffe <eczema@ecze.com>
# @copyright 2014-2016 Andrea Dainese
# @copyright 2017-2021 Alain Degreffe
# @license BSD-3-Clause https://github.com/dainok/unetlab/blob/master/LICENSE
# @link http://www.eve-ng.net/
# @version 20211212

import getopt
import multiprocessing
import os
import re
import sys
import time

import pexpect

OPTS = None
ARGS = None

IP = '127.0.0.1'
PORT = 23

USER_NAME = 'admin'
USER_PASS = ''

CONTIMEOUT = 5 #Maximum time for console connection
EXPTIMEOUT = 20 #Maximum time for each short expect
LONGTIMEOUT = 30 # Maximum time for each long expect
TIMEOUT = 60 # Maximum run time (CONTIMEOUT is included)

ACTION = None
FILENAME = None

MTK_PROMPT = r"\]\s> "

def usage():
    ' Usage '
    print('Usage: %s <standard options>' %(sys.argv[0]));
    print('Standard Options:');
    print('-a <s>    *Action can be:')
    print('           - get: get the startup-configuration and push it to a file')
    print('           - put: put the file as startup-configuration')
    print('-f <s>    *File');
    print('-p <n>    *Console port');
    print('-t <n>     Timeout (default = %i)' %(TIMEOUT));
    print('-i <ip>    Router\'s ip (default = 127.0.0.1)');
    print('* Mandatory option')

def now():
    ' Return current UNIX time in milliseconds '
    return int(round(time.time() * 1000))

def node_login(handler):
    ' Send an empty line, and wait for the login prompt '
    i = -1
    while i == -1:
        print('wait prompt...')
        try:
            handler.send('\r\n')
            i = handler.expect(['Login:',
                MTK_PROMPT],
                 timeout=CONTIMEOUT)
        except pexpect.exceptions.TIMEOUT:
            handler.send('\r\n')
    if i == 0:
        # Need to send username and password
        handler.send(USER_NAME + '+c512wt')
        handler.send('\r\n')
        try:
            handler.expect('Password:', timeout=EXPTIMEOUT)
        except pexpect.exceptions.TIMEOUT:
            print('ERROR: error waiting for "Password:" prompt.')
            node_quit(handler)
            return False
        handler.send(USER_PASS)
        handler.send('\r\n')
        j = handler.expect ([ r"\[Y/n\]",
            r"Change your password",
            MTK_PROMPT],
            timeout=TIMEOUT)
        if j == 0:
            handler.send('n\r\n')
            _newpass = handler.expect([r"Change your password",MTK_PROMPT],timeout=EXPTIMEOUT)
            if _newpass == 0:
                handler.send('eve\r\n')
                handler.send('eve\r\n')
                time.sleep(1)
                handler.send('/password\r\n')
                handler.send('eve\r\n')
                handler.send('\r\n')
                handler.send('\r\n')
                time.sleep(1)
                #clear expect
                clear_buffer(handler)
                handler.expect(r".*",timeout=EXPTIMEOUT)
                return True
            elif _newpass == 1:
                time.sleep(1)
                return True
        if j == 1:
            handler.send('eve\r\n')
            handler.send('eve\r\n')
            handler.send('/password\r\n')
            handler.send('eve\r\n')
            handler.send('\r\n')
            handler.send('\r\n')
            time.sleep(1)
            clear_buffer(handler)
            handler.expect(r".*",timeout=EXPTIMEOUT)
            return True
        if j == 2:
            time.sleep(1)
            return True
        return True
    elif i == 1:
        #Already logged in on serial console
        handler.send('\f\r\n')
        clear_buffer(handler)
        try:
             handler.expect(r".*",timeout=EXPTIMEOUT)
        except pexpect.exceptions.TIMEOUT:
            return True
        time.sleep(1)
        return True
    else:
        # Unexpected output
        node_quit(handler)
        handler.send('#unexpected\r\n')
        return False
    return True

def node_quit(handler):
    ' Quit '
    if handler.isalive():
        handler.send('/quit')
        handler.send('\r\n')
        time.sleep(1)
    handler.close()

def clear_buffer(handler):
    ' Clearing all "expect" buffer '
    while True:
        try:
            handler.send("\r\n")
            handler.expect(
                MTK_PROMPT, timeout=EXPTIMEOUT)
            break
        except pexpect.exceptions.TIMEOUT:
            time.sleep(0.5)
            continue

def config_get(handler):
    ' Get '
    # Run /export and drain ALL console output, then parse. This is robust to
    # RouterOS versions (e.g. v6.49) whose console echoes the command
    # character-by-character with cursor-control escapes and repeats the prompt
    # inline: the old code did expect(MTK_PROMPT), which matched the ECHOED
    # prompt (before any config had arrived), and a following clear_buffer()
    # then overwrote handler.before -> a near-empty capture. The v7 "+c512wt"
    # login suffix happens to suppress that echo, so only older images broke.
    clear_buffer(handler)
    handler.send('/export')
    handler.send('\r\n')
    time.sleep(6)
    data = ''
    while True:
        try:
            data += handler.read_nonblocking(size=100000, timeout=3)
        except pexpect.exceptions.TIMEOUT:
            break
        except pexpect.exceptions.EOF:
            break
    # Strip ANSI CSI sequences (colours, erase-to-EOL, cursor moves) and the
    # RIS full-reset, plus bare CRs used for the char-by-char echo redraw.
    data = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", data)
    data = re.sub(r"\x1b[c=>]", "", data)
    data = data.replace("\r", "")
    # The real export begins at the RouterOS header comment; everything before
    # it is login banner + command echo noise.
    match = re.search(r"^#[^\n]*by RouterOS.*$", data, re.MULTILINE)
    if match is None:
        print('ERROR: could not find export header in console output.')
        node_quit(handler)
        return False
    data = data[match.start():]
    # Cut at the trailing prompt line that follows the export.
    data = re.split(r"\n\[[^\]\n]*\]\s*>", data)[0]
    data = re.sub(r"\n{3,}", "\n\n", data)
    return data.strip() + "\n"

def config_put(handler):
    ' Put '
    clear_buffer(handler)
    handler.send('/system reset-configuration no-defaults=yes')
    handler.send('\r\n')
    time.sleep(3)
    handler.send('y\r\n')
    time.sleep(5)
    try:
        handler.expect('Login: ', timeout=TIMEOUT)
    except pexpect.exceptions.TIMEOUT:
        return False
    return True

def config_import(handler, config):
    ' Import '
    clear_buffer(handler)
    handler.send('/ip dhcp-client remove numbers=0')
    handler.send('\r\n')
    try:
        handler.expect(MTK_PROMPT, timeout=EXPTIMEOUT)
    except pexpect.exceptions.TIMEOUT:
        return False
    configs = re.split(r"\n", config)
    for cmd in configs:
        if cmd == '':
            continue
        handler.send(cmd)
        handler.send('\r\n')
        time.sleep(0.1)
    time.sleep(3)
    handler.send('/\r\n')
    time.sleep(1)
    try:
        handler.expect(MTK_PROMPT, timeout=EXPTIMEOUT)
    except pexpect.exceptions.TIMEOUT:
        return False
    return True

def main(action, filename, port):
    try:
        tmp = CONTIMEOUT
        handler = pexpect.spawnu('telnet %s %i' %(IP, port), maxread=100000)
        handler.crlf = '\r\n'
        while tmp > 0:
            time.sleep(0.1)
            tmp = tmp - 0.1
            if handler.isalive():
                break
        if action == 'get':
            if handler.isalive() is False:
                print('ERROR: cannot connect to port "%i".' %(port))
                node_quit(handler)
                sys.exit(1)
            lgst = node_login(handler)
            if lgst is False:
                print('ERROR: failed to login.')
                node_quit(handler)
                sys.exit(1)
            config = config_get(handler)
            if config in [False, None]:
                print('ERROR: failed to retrieve config.')
                node_quit(handler)
                sys.exit(1)
            try:
                fdc = open(filename, 'a')
                fdc.write(config)
                fdc.close()
            except:
                print('ERROR: cannot write config to file.')
                node_quit(handler)
                sys.exit(1)
        elif action == 'put':
            if (handler.isalive() != True):
                print('ERROR: cannot connect to port "%i".' %(port))
                node_quit(handler)
                sys.exit(1)
            lgst = node_login(handler)
            if lgst is False:
                print('ERROR: failed to login.')
                node_quit(handler)
                sys.exit(1)
            config_rsc = ''
            with open(filename, 'r') as fileconf:
                config_rsc = fileconf.read()
                config_rsc = re.sub(r"\\\n\s+", "", config_rsc)
            config = config_put(handler)
            if config is False:
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
            lgst = node_login(handler)
            if lgst is False:
                print('ERROR: failed to login.')
                node_quit(handler)
                sys.exit(1)
            lgst = config_import(handler, config_rsc)
            if lgst is False:
                print('ERROR: failed to push config.')
                node_quit(handler)
                sys.exit(1)
        node_quit(handler)
        sys.exit(0)
    except Exception as e:
        print('ERROR: got an exception')
        print(type(e)) # the exception instance
        print(e.args) # arguments stored in .args
        print(e) # __str__ allows args to be printed directly,
        node_quit(handler)
        sys.exit(1)

if __name__ == '__main__':
    try:
        OPTS, ARGS = getopt.getopt(
            sys.argv[1:], 'a:p:t:f:i', ['action=', 'port=', 'timeout=', 'file=', 'address='])
    except getopt.GetoptError:
        usage()
        sys.exit(3)

    for o, a in OPTS:
        if o in ['-a', '--action']:
            ACTION = a
        elif o in ['-f', '--file']:
            FILENAME = a
        elif o in ['-p', '--port']:
            try:
                PORT = int(a)
            except TypeError:
                PORT = -1
        elif o in ['-t', '--timeout']:
            try:
                TIMEOUT = int(a)
            except TypeError:
                TIMEOUT = -1
        elif o in ['-i', '--address']:
            IP = a
        else:
            print('ERROR: invalid parameter.')

    # Checking mandatory parameters
    if ACTION is None or PORT is None or FILENAME is None:
        usage()
        print('ERROR: missing mandatory parameters.')
        sys.exit(1)
    if ACTION not in ['get', 'put']:
        usage()
        print('ERROR: invalid action.')
        sys.exit(1)
    if TIMEOUT < 0:
        usage()
        print('ERROR: timeout must be 0 or higher.')
        sys.exit(1)
    if PORT < 0:
        usage()
        print('ERROR: port must be 32768 or higher.')
        sys.exit(1)
    if ACTION == 'get' and os.path.exists(FILENAME):
        usage()
        print('ERROR: destination file already exists.')
        sys.exit(1)
    if ACTION == 'put' and not os.path.exists(FILENAME):
        usage()
        print('ERROR: source file does not already exist.')
        sys.exit(1)
    if ACTION == 'put':
        try:
            fd = open(FILENAME, 'r')
            config = fd.read()
            fd.close()
        except:
            usage()
            print('ERROR: cannot read from file.')
            sys.exit(1)

    # Backgrounding the script
    END_BEFORE = now() + TIMEOUT * 1000
    MAIN_PROCESS = multiprocessing.Process(
        target=main, name="Main", args=(ACTION, FILENAME, PORT))
    MAIN_PROCESS.start()

    while MAIN_PROCESS.is_alive() and now() < END_BEFORE:
        # Waiting for the child process to end
        time.sleep(1)
    if MAIN_PROCESS.is_alive():
        # Timeout occurred
        print('ERROR: timeout occurred.')
        MAIN_PROCESS.terminate()
        sys.exit(127)
    if MAIN_PROCESS.exitcode != 0:
        sys.exit(127)
    sys.exit(0)
