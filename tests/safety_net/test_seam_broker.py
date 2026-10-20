"""
tests/safety_net/test_seam_broker.py
TDD Safety Net - Seam 1: Privilege Broker Socket Interface (/run/pnetlab/broker.sock)
Kiểm tra hợp đồng giao tiếp giữa Web/CLI và Daemon pnetlab-brokerd.py (126 verbs).
Đảm bảo tất cả các verbs sinh tử phản hồi đúng JSON schema:
{"ok": bool, "rc": int, "out": list, "err": str}
"""

import os
import socket
import json
import unittest

SOCKET_PATH = "/run/pnetlab/broker.sock"

class BrokerSocketClient:
    """Helper client gửi lệnh qua Unix Domain Socket của broker theo đúng giao thức broker.php."""
    def __init__(self, path=SOCKET_PATH, timeout=5.0):
        self.path = path
        self.timeout = timeout

    def call(self, verb, args=None):
        if not os.path.exists(self.path):
            raise RuntimeError(f"Broker socket not found at {self.path}")
        
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            sock.connect(self.path)
            # Lưu ý cốt lõi: Broker nhận key 'args', không phải 'params'
            payload = {"verb": verb, "args": args or {}}
            sock.sendall(json.dumps(payload).encode("utf-8") + b"\n")
            
            data = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
                if b"\n" in chunk:
                    break
            
            line = data.decode("utf-8").strip().split("\n")[0]
            return json.loads(line)
        finally:
            sock.close()


class TestBrokerCoreVerbsSafetyNet(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = BrokerSocketClient()

    def test_01_ping_pong_contract(self):
        """Hợp đồng Ping-Pong: Kiểm tra Broker daemon còn sống và phản hồi chuẩn."""
        resp = self.client.call("ping")
        self.assertTrue(resp.get("ok"), "Ping phải thành công ok=True")
        self.assertEqual(resp.get("rc"), 0, "rc phải bằng 0")
        self.assertIn("pong", resp.get("out", []), "out phải chứa 'pong'")

    def test_02_unknown_verb_rejection(self):
        """Hợp đồng từ chối verb lạ: Bảo vệ bảo mật, không crash daemon."""
        resp = self.client.call("non_existent_fake_verb_12345")
        self.assertFalse(resp.get("ok"), "Verb lạ phải trả về ok=False")
        self.assertEqual(resp.get("rc"), 254, "rc cho unknown verb phải là 254")
        self.assertEqual(resp.get("err"), "unknown verb")

    def test_03_wrapper_platform_verb(self):
        """Hợp đồng unl_wrapper action 'platform': Đọc thông tin nền tảng phần cứng ảo hóa."""
        resp = self.client.call("wrapper", {"action": "platform"})
        self.assertTrue(resp.get("ok"), "wrapper platform phải thành công")
        self.assertEqual(resp.get("rc"), 0)
        self.assertTrue(len(resp.get("out", [])) > 0, "Phải có chuỗi nhận diện platform")

    def test_04_system_uuid_verb(self):
        """Hợp đồng đọc System UUID máy chủ."""
        resp = self.client.call("system_uuid")
        self.assertTrue(resp.get("ok"))
        self.assertEqual(resp.get("rc"), 0)
        self.assertTrue(len(resp.get("out", [])) > 0, "Phải trả về chuỗi UUID")

    def test_05_ksm_verbs_contract(self):
        """Hợp đồng unl_wrapper toggle KSM (Kernel Samepage Merging)."""
        resp_on = self.client.call("wrapper", {"action": "ksmon"})
        self.assertTrue(resp_on.get("ok"), "ksmon phải thành công")
        self.assertEqual(resp_on.get("rc"), 0)

        resp_off = self.client.call("wrapper", {"action": "ksmoff"})
        self.assertTrue(resp_off.get("ok"), "ksmoff phải thành công")
        self.assertEqual(resp_off.get("rc"), 0)

    def test_06_cpulimit_verbs_contract(self):
        """Hợp đồng unl_wrapper toggle CPU Limit."""
        resp_on = self.client.call("wrapper", {"action": "cpulimiton"})
        self.assertTrue(resp_on.get("ok"), "cpulimiton phải thành công")
        self.assertEqual(resp_on.get("rc"), 0)

        resp_off = self.client.call("wrapper", {"action": "cpulimitoff"})
        self.assertTrue(resp_off.get("ok"), "cpulimitoff phải thành công")
        self.assertEqual(resp_off.get("rc"), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
