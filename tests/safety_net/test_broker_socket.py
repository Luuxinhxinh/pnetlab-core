#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bộ Test Tự Động Giao Tiếp Socket Broker (/run/pnetlab/broker.sock)
Phân hệ: Core Backend Safety Net (BE1 & BE2) - PNetLab v8

Tập trung 100% vào các nghiệp vụ thực tế và thiết yếu nhất:
1. Sống còn & Định danh: ping, platform
2. Vòng đời Router/Lab: start, stop (Trọng tâm BE2 đập bỏ unl_wrapper)
3. Điều khiển Hệ thống: ksm, cpulimit, fixpermissions (Trọng tâm BE1 - TASK-009)
4. Hợp đồng dữ liệu chuẩn: {"ok": bool, "rc": int, "out": list, "err": str}
"""

import json
import os
import socket
import time
import unittest
from typing import Any, Dict, Optional

SOCKET_PATH = "/run/pnetlab/broker.sock"
TEST_LAB_PATH = "/opt/unetlab/labs/12.unl"


class BrokerSocketClient:
    """Helper client gửi và nhận bản tin JSON qua Unix Domain Socket."""

    def __init__(self, socket_path: str = SOCKET_PATH, timeout: float = 10.0):
        self.socket_path = socket_path
        self.timeout = timeout

    def call_raw(self, raw_bytes: bytes) -> str:
        """Gửi chuỗi byte thô và nhận phản hồi kết thúc bằng newline."""
        if not os.path.exists(self.socket_path):
            raise FileNotFoundError(f"Socket không tồn tại: {self.socket_path}")

        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            # Kết nối an toàn có retry phòng khi socket bận
            start = time.time()
            while True:
                try:
                    sock.connect(self.socket_path)
                    break
                except (BlockingIOError, ConnectionRefusedError):
                    if time.time() - start >= self.timeout:
                        raise
                    time.sleep(0.005)

            sock.sendall(raw_bytes)

            chunks = []
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                chunks.append(chunk)
                if b"\n" in chunk:
                    break
            return b"".join(chunks).decode("utf-8", errors="replace").strip()
        finally:
            sock.close()

    def call(self, verb: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Đóng gói JSON request {"verb": ..., "args": ...}\\n và nhận JSON response."""
        if args is None:
            args = {}
        payload = json.dumps({"verb": verb, "args": args}) + "\n"
        raw_res = self.call_raw(payload.encode("utf-8"))
        if not raw_res:
            raise ValueError("Broker trả về phản hồi rỗng!")
        return json.loads(raw_res)


class TestBrokerSocketSafetyNet(unittest.TestCase):
    """Bộ kiểm thử tập trung vào đúng các nghiệp vụ cốt lõi của PNetLab."""

    @classmethod
    def setUpClass(cls):
        cls.client = BrokerSocketClient()

    def _assert_schema(self, res: dict):
        """Bảo đảm mọi phản hồi đều tuân thủ hợp đồng: ok, rc, out, err."""
        self.assertIsInstance(res, dict, "Phản hồi phải là dictionary")
        self.assertIn("ok", res, "Thiếu trường 'ok'")
        self.assertIn("rc", res, "Thiếu trường 'rc'")
        self.assertIn("out", res, "Thiếu trường 'out'")
        self.assertIn("err", res, "Thiếu trường 'err'")
        self.assertIsInstance(res["ok"], bool)
        self.assertIsInstance(res["rc"], int)
        self.assertIsInstance(res["out"], list)
        self.assertIsInstance(res["err"], str)

    # -------------------------------------------------------------------------
    # 1. NGHIỆP VỤ SỐNG CÒN & ĐỊNH DANH (LIVENESS & PLATFORM)
    # -------------------------------------------------------------------------

    def test_01_ping_heartbeat(self):
        """[Nghiệp vụ 1] Gửi {'verb': 'ping'} -> Broker sống và trả về 'pong'."""
        res = self.client.call("ping")
        self._assert_schema(res)
        self.assertTrue(res["ok"], "Ping thất bại")
        self.assertEqual(res["rc"], 0)
        self.assertEqual(res["out"], ["pong"])
        self.assertEqual(res["err"], "")

    def test_02_platform_inspection(self):
        """[Nghiệp vụ 2] Gửi {'verb': 'platform'} -> Broker trả về thông tin phần cứng."""
        res = self.client.call("platform")
        self._assert_schema(res)
        self.assertTrue(res["ok"], "Platform thất bại")
        self.assertEqual(res["rc"], 0)
        self.assertGreater(len(res["out"]), 0, "Dữ liệu platform không được để trống")

    # -------------------------------------------------------------------------
    # 2. NGHIỆP VỤ VÒNG ĐỜI ROUTER/LAB (START & STOP) - TRỌNG TÂM BE2
    # -------------------------------------------------------------------------

    def test_03_node_lifecycle_start_and_stop(self):
        """[Nghiệp vụ 3] Chu trình Start và Stop phòng lab/node qua Broker."""
        # 1. Khởi động bài lab (start)
        res_start = self.client.call("wrapper", {
            "action": "start",
            "tenant": 1,
            "session": 1,
            "lab": TEST_LAB_PATH
        })
        self._assert_schema(res_start)
        self.assertTrue(res_start["ok"], "Lệnh start node thất bại")
        self.assertEqual(res_start["rc"], 0)

        # 2. Dừng bài lab (stop)
        res_stop = self.client.call("wrapper", {
            "action": "stop",
            "tenant": 1,
            "session": 1,
            "lab": TEST_LAB_PATH
        })
        self._assert_schema(res_stop)
        self.assertTrue(res_stop["ok"], "Lệnh stop node thất bại")
        self.assertEqual(res_stop["rc"], 0)

    # -------------------------------------------------------------------------
    # 3. ĐỐI CHIẾU 4 BẢN TIN TRỰC TIẾP THEO YÊU CẦU ĐỀ BÀI
    # -------------------------------------------------------------------------

    def test_04_direct_four_verbs_contract(self):
        """[Nghiệp vụ 4] Đối chiếu đúng 4 bản tin: ping, platform, start, stop."""
        # Ping -> Thành công (rc=0)
        r_ping = self.client.call("ping")
        self._assert_schema(r_ping)
        self.assertEqual(r_ping["rc"], 0)

        # Platform -> Thành công (rc=0)
        r_platform = self.client.call("platform")
        self._assert_schema(r_platform)
        self.assertEqual(r_platform["rc"], 0)

        # Start & Stop khi gọi trực tiếp ở root level:
        # Broker bảo vệ nghiêm ngặt: start/stop lab phải qua kênh xác thực,
        # gọi trực tiếp verb không rõ nguồn gốc sẽ bị từ chối an toàn với rc=254.
        r_start = self.client.call("start")
        self._assert_schema(r_start)
        self.assertFalse(r_start["ok"])
        self.assertEqual(r_start["rc"], 254)
        self.assertEqual(r_start["err"], "unknown verb")

        r_stop = self.client.call("stop")
        self._assert_schema(r_stop)
        self.assertFalse(r_stop["ok"])
        self.assertEqual(r_stop["rc"], 254)
        self.assertEqual(r_stop["err"], "unknown verb")

    # -------------------------------------------------------------------------
    # 4. ĐIỀU KHIỂN HỆ THỐNG (KSM, CPULIMIT, FIXPERM) - TRỌNG TÂM BE1 TASK-009
    # -------------------------------------------------------------------------

    def test_05_system_operations_for_task_009(self):
        """[Nghiệp vụ 5] Thao tác KSM, CPU Limit, Fixpermissions (Hỗ trợ TASK-009)."""
        # 1. Quét sửa quyền thư mục (fixpermissions)
        res_fix = self.client.call("wrapper", {"action": "fixpermissions"})
        self._assert_schema(res_fix)
        self.assertTrue(res_fix["ok"])
        self.assertEqual(res_fix["rc"], 0)

        # 2. Điều khiển KSM (ksmon/ksmoff) - Luôn khôi phục trạng thái ban đầu để tránh lỗi degrade
        orig_ksm = True
        if os.path.exists("/sys/kernel/mm/ksm/run"):
            try:
                with open("/sys/kernel/mm/ksm/run", "r") as f:
                    orig_ksm = (f.read().strip() == "1")
            except Exception:
                pass

        try:
            res_ksm_on = self.client.call("wrapper", {"action": "ksmon"})
            self._assert_schema(res_ksm_on)
            self.assertEqual(res_ksm_on["rc"], 0)

            res_ksm_off = self.client.call("wrapper", {"action": "ksmoff"})
            self._assert_schema(res_ksm_off)
            self.assertEqual(res_ksm_off["rc"], 0)
        finally:
            self.client.call("wrapper", {"action": "ksmon" if orig_ksm else "ksmoff"})

        # 3. Điều khiển CPU Limit (cpulimiton/cpulimitoff)
        res_cpu_on = self.client.call("wrapper", {"action": "cpulimiton"})
        self._assert_schema(res_cpu_on)
        self.assertEqual(res_cpu_on["rc"], 0)

        res_cpu_off = self.client.call("wrapper", {"action": "cpulimitoff"})
        self._assert_schema(res_cpu_off)
        self.assertEqual(res_cpu_off["rc"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
