#!/usr/bin/env python3
import json
import uuid
import sys
import os
import xml.etree.ElementTree as ET
from xml.dom import minidom
from pathlib import Path

def convert_json_to_unl(json_path, output_unl_path=None):
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    lab_name = data.get("name", "CTF_Lab")
    lab_id = str(uuid.uuid4())
    countdown = str(data.get("timeout_minutes", 120))

    # Gốc XML chuẩn của PNetLab
    lab = ET.Element("lab", {
        "name": lab_name,
        "id": lab_id,
        "version": "1",
        "scripttimeout": "300",
        "countdown": countdown,
        "darkmode": "1",
        "mode3d": "0",
        "nogrid": "0",
        "joinable": "0",
        "openable": "0",
        "editable": "0"
    })

    topology = ET.SubElement(lab, "topology")

    # 1. Add Nodes
    nodes_elem = ET.SubElement(topology, "nodes")
    for n in data.get("nodes", []):
        node_attr = {
            "id": str(n["id"]),
            "name": n["name"],
            "type": n.get("type", "qemu"),
            "template": n.get("template", "linux"),
            "image": n.get("image", "linux-alpine"),
            "cpu": str(n.get("cpu", 1)),
            "ram": str(n.get("ram", 256)),
            "ethernet": str(len(n.get("interfaces", [{}]))),
            "console": n.get("console", "vnc"),
            "delay": "0",
            "icon": n.get("icon", "Server.png"),
            "left": str(n.get("left", 200)),
            "top": str(n.get("top", 200)),
            "config": "0",
            "config_data": n.get("config_data", "")
        }
        node_elem = ET.SubElement(nodes_elem, "node", node_attr)

        for iface in n.get("interfaces", []):
            iface_attr = {
                "id": str(iface.get("id", 0)),
                "name": iface.get("name", "eth0"),
                "type": "ethernet",
                "network_id": str(iface.get("network_id", 1)),
                "vid": "1",
                "vlanmode": "access"
            }
            ET.SubElement(node_elem, "interface", iface_attr)

    # 2. Add Networks (Bridges)
    nets_elem = ET.SubElement(topology, "networks")
    for net in data.get("networks", []):
        net_attr = {
            "id": str(net["id"]),
            "name": net["name"],
            "type": net.get("type", "bridge"),
            "left": str(net.get("left", 0)),
            "top": str(net.get("top", 0)),
            "visibility": "1" if net.get("left") else "0",
            "icon": "lan.png",
            "smart": "0"
        }
        ET.SubElement(nets_elem, "network", net_attr)

    rough_xml = ET.tostring(lab, "utf-8")
    reparsed = minidom.parseString(rough_xml)
    pretty_xml = reparsed.toprettyxml(indent="  ")

    if not output_unl_path:
        filename = f"{data.get('challenge_id', 'ctf_demo')}.unl"
        output_unl_path = Path("/opt/unetlab/labs") / filename
    else:
        output_unl_path = Path(output_unl_path)

    output_unl_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_unl_path, "w", encoding="utf-8") as f:
        f.write(pretty_xml)

    # Đặt quyền www-data cho file lab
    os.system(f"chown www-data:www-data '{output_unl_path}'")
    os.system(f"chmod 664 '{output_unl_path}'")

    print(f"[+] Thành công! Topo đã được bung ra tại: {output_unl_path}")
    print(f"[+] Bạn có thể vào Web PNetLab để mở lab: {output_unl_path.name}")
    return str(output_unl_path)

if __name__ == "__main__":
    json_input = sys.argv[1] if len(sys.argv) > 1 else "/opt/unetlab/scripts/ctf_attack_defense_2teams.json"
    out_file = sys.argv[2] if len(sys.argv) > 2 else "/opt/unetlab/labs/Attack_Defense_CTF_2Teams.unl"
    convert_json_to_unl(json_input, out_file)
