#!/usr/bin/env python3
"""
Lightweight Mock API Server for PNetLab V8 Frontend Development.
Serves OpenAPI contract endpoints with zero external dependencies (pure Python 3 stdlib).
Port: 4010
"""

import json
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

PORT = 4010

MOCK_RESPONSES = {
    ("GET", "/api/health"): {
        "code": 200, "status": "success", "message": "OK"
    },
    ("POST", "/api/auth"): {
        "code": 200, "status": "success", "message": "User authenticated (90013)."
    },
    ("GET", "/api/auth"): {
        "code": 200, "status": "success",
        "data": {"username": "admin", "role": "admin", "email": "admin@pnetlab.local", "pod": 0}
    },
    ("GET", "/api/auth/logout"): {
        "code": 200, "status": "success", "message": "User logged out."
    },
    ("GET", "/api/folders"): {
        "code": 200, "status": "success",
        "data": {
            "folders": [
                {"id": 1, "name": "CCNA Labs", "path": "/CCNA Labs"},
                {"id": 2, "name": "CCNP Enterprise", "path": "/CCNP Enterprise"}
            ],
            "labs": [
                {"id": 101, "name": "BGP-Flapping-Lab.unl", "path": "/CCNA Labs/BGP-Flapping-Lab.unl", "nodes_count": 6}
            ]
        }
    },
    ("GET", "/api/list/templates"): {
        "code": 200, "status": "success",
        "data": [
            {"template": "cisco-iol", "name": "Cisco IOL Router", "type": "iol", "icon": "router.png"},
            {"template": "linux", "name": "Ubuntu 24.04 Server", "type": "qemu", "icon": "linux.png"},
            {"template": "docker-alpine", "name": "Alpine Linux Container", "type": "docker", "icon": "docker.png"}
        ]
    },
    ("GET", "/api/labs/session/nodes"): {
        "code": 200, "status": "success",
        "data": {
            "1": {"id": 1, "name": "R1-Core", "type": "qemu", "template": "cisco-iol", "status": 2, "cpu": 1, "ram": 1024, "left": 240, "top": 180},
            "2": {"id": 2, "name": "R2-Edge", "type": "qemu", "template": "cisco-iol", "status": 0, "cpu": 1, "ram": 1024, "left": 540, "top": 180}
        }
    },
    ("POST", "/api/labs/session/nodes/start"): {
        "code": 200, "status": "success", "message": "Node started."
    },
    ("POST", "/api/labs/session/nodes/stop"): {
        "code": 200, "status": "success", "message": "Node stopped."
    }
}

class MockApiHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def _handle_request(self, method):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if not path:
            path = "/"

        key = (method, path)
        data = MOCK_RESPONSES.get(key)

        if data is None:
            # Fallback matching
            for (m, p), resp in MOCK_RESPONSES.items():
                if m == method and path.startswith(p):
                    data = resp
                    break

        if data is not None:
            body = json.dumps(data).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._send_cors_headers()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            err = json.dumps({"code": 404, "status": "fail", "message": f"Mock endpoint not found: {method} {path}"}).encode("utf-8")
            self.send_response(404)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._send_cors_headers()
            self.send_header("Content-Length", str(len(err)))
            self.end_headers()
            self.wfile.write(err)

    def do_GET(self):
        self._handle_request("GET")

    def do_POST(self):
        self._handle_request("POST")

    def do_PUT(self):
        self._handle_request("PUT")

    def do_DELETE(self):
        self._handle_request("DELETE")

    def log_message(self, format, *args):
        print(f"[Mock Server 4010] {self.client_address[0]} - {format % args}", flush=True)

if __name__ == "__main__":
    server_address = ("0.0.0.0", PORT)
    httpd = HTTPServer(server_address, MockApiHandler)
    print(f"==================================================", flush=True)
    print(f"🚀 PNetLab Mock API Server running on port {PORT}", flush=True)
    print(f"👉 CORS Enabled (*). Ready for Frontend Team!", flush=True)
    print(f"==================================================", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Mock Server...")
        httpd.server_close()
