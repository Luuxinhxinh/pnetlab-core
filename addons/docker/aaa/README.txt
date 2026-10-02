PNetLab "AAA Suite" node (image pnet-aaa:1.0)
=============================================

One Debian container running THREE AAA services together, configured through a
web GUI instead of hand-editing raw config text:

  * FreeRADIUS        (RADIUS auth, udp/1812-1813)
  * Shrubbery tac_plus (TACACS+ auth, tcp/49)
  * rsyslog           (Syslog collector, udp+tcp/514)

This REPLACES the three former separate Cisco-CML AAA nodes (TACACS+ / FreeRADIUS
/ Syslog-NG) — they have been removed from the build in favour of this single
unified node with a web GUI.

How to configure
-----------------
Open the node's console (console: vnc) — it shows the configuration GUI, rendered
by an in-container WebKitGTK kiosk browser pointed at the node's own web GUI on
http://localhost:8080. The same GUI is also reachable at  http://<node-lab-ip>:8080
from the lab (set the node IP via the normal right-click -> node edit; the AAA
services bind 0.0.0.0 so they answer on the lab interface, eth1).

Default GUI login: admin / admin  (change it under Settings).

Tabs: Dashboard (service up/down + restart), RADIUS (NAS clients + users + a Test
button), TACACS+ (key + users + Test), Syslog (receiver + live message tail), and
Raw (edit each service's native config verbatim — the escape hatch).

There is NO appliance default.cfg here (unlike the separate nodes): the GUI bakes
its own defaults, and the node's editable config is one JSON blob.

Persistence
-----------
The GUI's configuration is stored as a single JSON blob in /firstboot.cfg inside
the container, which IS the node's PNetLab Startup-config:

  * Boot: config_aaa.py pushes the node's Startup-config -> /firstboot.cfg; the GUI
    loads it and renders each daemon's native config.
  * GUI edits write /firstboot.cfg and apply live (the affected daemon restarts).
  * Edits persist across a normal node stop/start (the container is reused).

To make GUI edits DURABLE across a full lab close/re-open or export (which can
recreate the container), copy the JSON shown on the GUI Settings page into the
node's PNetLab Startup-config editor. (PNetLab docker nodes do not support config
export, so the platform cannot pull it back automatically.)

Defaults: RADIUS client lab/0.0.0.0/0 secret testing123, user testuser/testpassword
+ admin/cisco; TACACS+ key cisco123, user admin/cisco priv15 (enable cisco) +
operator/cisco priv1; Syslog listens udp+tcp/514 -> /var/log/aaa/messages.
