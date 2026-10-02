PNetLab offline Docker image store
==================================

This directory holds prebuilt, license-clean Docker image archives that the
Dashboard -> "Docker Devices" page installs offline (one click -> `docker load`,
no internet, no scp). It is INTENTIONALLY a sibling of addons/docker/ so the
docker-image-watcher (which only watches addons/docker/) does NOT auto-load
these — they are loaded on demand by the catalog entry's Install action.

Catalog: /opt/unetlab/html/ishare2/devices.json  (entries device_id 51-53)
Each entry's device_script does: docker load -i <this dir>/<archive>.

Expected archives (shipped in the PNetLab bundle, NOT in git — too large):
    tacplus-f4-0-4-28.tar.gz   -> tacplus:f4.0.4.28   (TACACS+ / Shrubbery tac_plus)
    radius-3-2-1.tar.gz        -> radius:3.2.1        (FreeRADIUS)
    syslog-3-38.tar.gz         -> syslog:3.38         (syslog-ng)

All three are open-source (debian-slim + apt for freeradius/syslog-ng, Shrubbery
source for tac_plus; no Cisco-proprietary content) and are built from
https://github.com/CiscoLearning/cml-docker-containers — so they may be bundled
and redistributed. If an archive is missing, Install reports "Image archive not
found" and the node simply won't be available until the archive is present.

The matching node templates ship in html/templates/{amd,intel}/{tacplus,radius,
syslog}.yml; after Install the image's repo:tag matches the template stem so the
node type appears in Add Node automatically.
