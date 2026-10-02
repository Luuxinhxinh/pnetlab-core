#!/bin/bash
# PNetLab docker-node telnet console bridge — entry point called by device_docker.php
# in place of the stubbed docker_wrapper. Thin launcher for the python telnet bridge
# (no extra package deps; python3 is already required by the stack).
# Usage: docker_console.sh <tcp-port> <container> <cmd> [args...]
exec /usr/bin/python3 /opt/unetlab/wrappers/docker_console.py "$@"
