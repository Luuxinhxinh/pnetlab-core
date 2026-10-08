#!/usr/bin/env python3
"""
Bộ Test Tự Động Toàn Diện Cho Unix Domain Socket Broker (/run/pnetlab/broker.sock)
Phân hệ: Core Backend Safety Net (BE1)
Mục tiêu: Đóng băng hợp đồng dữ liệu (Contract Freeze), kiểm thử đa kịch bản
          (Happy Path, Boundary, Negative, Concurrency, Protocol Robustness)
          để làm lưới an toàn tuyệt đối trước khi BE2 đập bỏ unl_wrapper.
"""

import concurrent.futures
import json
import os
import re
import socket
import time
import unittest

SOCKET_PATH = "/run/pnetlab/broker.sock"


class BrokerSocketClient:
    """Helper client kết nối và gửi bản tin qua Unix Domain Socket."""

    def __init__(self, socket_path: str = SOCKET_PATH, timeout: float = 5.0):
        self.socket_path = socket_path
        self.timeout = timeout

    def call_raw(self, raw_bytes: bytes) -> str:
        """Gửi chuỗi byte thô vào socket và nhận kết quả chuỗi thô."""
        if not os.path.exists(self.socket_path):
            raise FileNotFoundError(f"Socket không tồn tại tại {self.socket_path}")

        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            start_conn = time.time()
            while True:
                try:
                    sock.connect(self.socket_path)
                    break
                except (BlockingIOError, ConnectionRefusedError):
                    if time.time() - start_conn >= self.timeout:
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
            return b"".join(chunks).decode("utf-8").strip()
        finally:
            sock.close()

    def call(self, verb: str, args: dict = None) -> dict:
        """Gửi request JSON chuẩn kết thúc bằng newline và parse phản hồi JSON."""
        if args is None:
            args = {}
        payload = json.dumps({"verb": verb, "args": args}) + "\n"
        raw_res = self.call_raw(payload.encode("utf-8"))
        if not raw_res:
            raise ValueError("Nhận được phản hồi rỗng từ Broker Socket!")
        return json.loads(raw_res)


class TestBrokerSocketComprehensiveSafetyNet(unittest.TestCase):
    """Bộ 20 kịch bản kiểm thử toàn diện bảo vệ Unix Socket Broker."""

    @classmethod
    def setUpClass(cls):
        cls.client = BrokerSocketClient()

    def _assert_valid_schema(self, res: dict):
        """Hàm kiểm tra hợp đồng cấu trúc schema: ok, rc, out, err."""
        self.assertIsInstance(res, dict, "Phản hồi phải là một dictionary JSON")
        self.assertIn("ok", res, "Thiếu trường bắt buộc 'ok'")
        self.assertIn("rc", res, "Thiếu trường bắt buộc 'rc'")
        self.assertIn("out", res, "Thiếu trường bắt buộc 'out'")
        self.assertIn("err", res, "Thiếu trường bắt buộc 'err'")
        self.assertIsInstance(res["ok"], bool, "Trường 'ok' phải là kiểu boolean")
        self.assertIsInstance(res["rc"], int, "Trường 'rc' phải là kiểu integer")
        self.assertIsInstance(res["out"], list, "Trường 'out' phải là kiểu list")
        self.assertIsInstance(res["err"], str, "Trường 'err' phải là kiểu string")

    # =========================================================================
    # NHÓM 1: KIỂM THỬ CHỨC NĂNG CỐT LÕI (HAPPY PATH / CORE VERBS CONTRACT)
    # =========================================================================

    def test_01_socket_file_presence_and_type(self):
        """[SC-01] Kiểm tra file socket tồn tại và đúng định dạng Unix Socket."""
        self.assertTrue(os.path.exists(SOCKET_PATH), f"Tệp socket {SOCKET_PATH} không tồn tại!")
        stat_info = os.stat(SOCKET_PATH)
        import stat
        self.assertTrue(stat.S_ISSOCK(stat_info.st_mode), f"{SOCKET_PATH} không phải là socket!")

    def test_02_ping_pong_liveness(self):
        """[SC-02] Kịch bản Ping-Pong: kiểm tra Broker còn sống và phản hồi tức thì."""
        res = self.client.call("ping")
        self._assert_valid_schema(res)
        self.assertTrue(res["ok"], "Ping phải trả về ok = True")
        self.assertEqual(res["rc"], 0, "Return code của ping phải bằng 0")
        self.assertEqual(res["out"], ["pong"], "Output ping phải là ['pong']")
        self.assertEqual(res["err"], "", "Lỗi phải rỗng khi ping thành công")

    def test_03_platform_identification(self):
        """[SC-03] Kịch bản Platform: định danh môi trường phần cứng/ảo hóa máy chủ."""
        res = self.client.call("platform")
        self._assert_valid_schema(res)
        self.assertTrue(res["ok"])
        self.assertEqual(res["rc"], 0)
        self.assertGreater(len(res["out"]), 0, "Platform output không được để trống")
        self.assertTrue(isinstance(res["out"][0], str))

    def test_04_system_uuid_inspection(self):
        """[SC-04] Kịch bản System UUID: kiểm tra mã UUID định danh hệ thống."""
        res = self.client.call("system_uuid")
        self._assert_valid_schema(res)
        self.assertTrue(res["ok"])
        self.assertEqual(res["rc"], 0)
        self.assertGreater(len(res["out"]), 0)
        uuid_str = res["out"][0].strip()
        self.assertGreater(len(uuid_str), 10, "UUID phải có độ dài hợp lệ")

    def test_05_qemu_cpu_policy_status(self):
        """[SC-05] Kịch bản QEMU CPU Policy: kiểm tra trạng thái cgroup quản lý CPU."""
        res = self.client.call("qemu_cpu_policy_status")
        self._assert_valid_schema(res)
        self.assertTrue(res["ok"])
        self.assertEqual(res["rc"], 0)
        self.assertGreater(len(res["out"]), 0)

    def test_06_plugin_list_discovery(self):
        """[SC-06] Kịch bản Plugin List: liệt kê các plugin và hooks đã đăng ký."""
        res = self.client.call("plugin_list")
        self._assert_valid_schema(res)
        self.assertTrue(res["ok"])
        self.assertEqual(res["rc"], 0)
        # Parse JSON trả về trong out[0]
        data = json.loads(res["out"][0])
        self.assertIn("plugins", data)
        self.assertIn("hooks", data)

    # =========================================================================
    # NHÓM 2: KIỂM THỬ TƯƠNG THÍCH NGƯỢC (LEGACY C WRAPPER EMULATION)
    # =========================================================================

    def test_07_wrapper_platform_action(self):
        """[SC-07] Kịch bản Wrapper Platform: kiểm tra action 'platform' bọc qua wrapper."""
        res = self.client.call("wrapper", {"action": "platform"})
        self._assert_valid_schema(res)
        self.assertTrue(res["ok"])
        self.assertEqual(res["rc"], 0)

    def test_08_wrapper_ksm_toggle_roundtrip(self):
        """[SC-08] Kịch bản KSM Toggle: bật và tắt cơ chế Kernel Samepage Merging."""
        # Bật KSM (ksmon)
        res_on = self.client.call("wrapper", {"action": "ksmon"})
        self._assert_valid_schema(res_on)
        self.assertTrue(res_on["ok"])
        self.assertEqual(res_on["rc"], 0)

        # Tắt KSM (ksmoff)
        res_off = self.client.call("wrapper", {"action": "ksmoff"})
        self._assert_valid_schema(res_off)
        self.assertTrue(res_off["ok"])
        self.assertEqual(res_off["rc"], 0)

    def test_09_wrapper_cpulimit_toggle_roundtrip(self):
        """[SC-09] Kịch bản CPU Limit Toggle: bật và tắt giới hạn xung CPU QEMU."""
        res_on = self.client.call("wrapper", {"action": "cpulimiton"})
        self._assert_valid_schema(res_on)
        self.assertTrue(res_on["ok"])
        self.assertEqual(res_on["rc"], 0)

        res_off = self.client.call("wrapper", {"action": "cpulimitoff"})
        self._assert_valid_schema(res_off)
        self.assertTrue(res_off["ok"])
        self.assertEqual(res_off["rc"], 0)

    def test_10_wrapper_fixpermissions(self):
        """[SC-10] Kịch bản Fix Permissions: quét sửa quyền thư mục /opt/unetlab."""
        res = self.client.call("wrapper", {"action": "fixpermissions"})
        self._assert_valid_schema(res)
        self.assertTrue(res["ok"])
        self.assertEqual(res["rc"], 0)

    # =========================================================================
    # NHÓM 3: KIỂM THỬ PHÒNG THỦ & BẮT LỖI ĐẦU VÀO (DEFENSIVE / NEGATIVE TESTS)
    # =========================================================================

    def test_11_unknown_verb_rejection(self):
        """[SC-11] Kịch bản Unknown Verb: broker phải từ chối verb lạ với rc=254."""
        res = self.client.call("malicious_unregistered_verb_xyz")
        self._assert_valid_schema(res)
        self.assertFalse(res["ok"])
        self.assertEqual(res["rc"], 254)
        self.assertEqual(res["err"], "unknown verb")
        self.assertEqual(res["out"], [])

    def test_12_invalid_wrapper_action_rejection(self):
        """[SC-12] Kịch bản Invalid Action: action không nằm trong whitelist phải bị chặn."""
        res = self.client.call("wrapper", {"action": "exploit_action_123"})
        self._assert_valid_schema(res)
        self.assertFalse(res["ok"])
        self.assertEqual(res["rc"], 254)
        self.assertEqual(res["err"], "bad action")

    def test_13_invalid_arg_value_rejection(self):
        """[SC-13] Kịch bản Arg Value Validation: tham số sai giá trị phải bị từ chối với rc=254."""
        res = self.client.call("ksm_toggle", {"enabled": "invalid_boolean_value"})
        self._assert_valid_schema(res)
        self.assertFalse(res["ok"], "Giá trị không hợp lệ phải trả về ok = False")
        self.assertEqual(res["rc"], 254, "Mã lỗi validation của broker phải là 254")
        self.assertEqual(res["err"], "bad arg enabled")

    def test_14_missing_required_args_for_lifecycle(self):
        """[SC-14] Kịch bản Missing Lifecycle Args: start node thiếu tenant/session/lab."""
        res = self.client.call("wrapper", {"action": "start"})
        self._assert_valid_schema(res)
        self.assertFalse(res["ok"])
        self.assertEqual(res["rc"], 254)
        self.assertIn("bad arg", res["err"])

    def test_15_invalid_arg_value_negative_integer(self):
        """[SC-15] Kịch bản Invalid Int Arg: tenant mang giá trị âm phải bị validator chặn."""
        res = self.client.call("wrapper", {
            "action": "start",
            "tenant": -1,
            "session": 1,
            "lab": "/opt/unetlab/labs/test.unl"
        })
        self._assert_valid_schema(res)
        self.assertFalse(res["ok"])
        self.assertEqual(res["rc"], 254)
        self.assertEqual(res["err"], "bad arg tenant")

    def test_16_path_traversal_protection(self):
        """[SC-16] Kịch bản Path Traversal: chặn đường dẫn chứa '../' ra ngoài labs/."""
        res = self.client.call("wrapper", {
            "action": "start",
            "tenant": 1,
            "session": 1,
            "lab": "/opt/unetlab/labs/../../etc/passwd"
        })
        self._assert_valid_schema(res)
        self.assertFalse(res["ok"])
        self.assertEqual(res["rc"], 254)

    # =========================================================================
    # NHÓM 4: KIỂM THỬ TÍNH BỀN VỮNG GIAO THỨC (PROTOCOL ROBUSTNESS & MALFORMED)
    # =========================================================================

    def test_17_malformed_json_syntax_resilience(self):
        """[SC-17] Kịch bản Malformed JSON: gửi cú pháp JSON sai, Broker không được crash."""
        raw_broken_json = b'{"verb": "ping", "args": {\n'
        raw_res = self.client.call_raw(raw_broken_json)
        res = json.loads(raw_res)
        self._assert_valid_schema(res)
        self.assertFalse(res["ok"])
        self.assertEqual(res["rc"], 255)
        self.assertEqual(res["err"], "broker error")

    def test_18_empty_line_request_resilience(self):
        """[SC-18] Kịch bản Empty Request: gửi dòng trắng ngắt quãng, Broker xử lý an toàn."""
        raw_res = self.client.call_raw(b"   \n")
        res = json.loads(raw_res)
        self._assert_valid_schema(res)
        self.assertFalse(res["ok"])
        self.assertEqual(res["rc"], 255)

    # =========================================================================
    # NHÓM 5: KIỂM THỬ XỬ LÝ ĐỒNG THỜI & HIỆU NĂNG (CONCURRENCY & STRESS)
    # =========================================================================

    def test_19_concurrent_multi_client_requests(self):
        """[SC-19] Kịch bản Concurrency: 20 luồng kết nối đồng thời, không nghẽn/deadlock."""
        num_workers = 20

        def worker_task(worker_id):
            client = BrokerSocketClient(timeout=3.0)
            # Luân phiên gọi ping hoặc platform
            if worker_id % 2 == 0:
                return client.call("ping")
            else:
                return client.call("platform")

        with concurrent.futures.ThreadPoolExecutor(max_workers=num_workers) as executor:
            futures = [executor.submit(worker_task, i) for i in range(num_workers)]
            for future in concurrent.futures.as_completed(futures):
                res = future.result()
                self._assert_valid_schema(res)
                self.assertTrue(res["ok"], f"Worker thất bại: {res}")
                self.assertEqual(res["rc"], 0)

    def test_20_latency_performance_sla(self):
        """[SC-20] Kịch bản SLA Latency: thời gian phản hồi ping phải dưới 50ms."""
        start_time = time.perf_counter()
        res = self.client.call("ping")
        elapsed_ms = (time.perf_counter() - start_time) * 1000

        self.assertTrue(res["ok"])
        # Trên Unix Socket cục bộ, độ trễ thường < 2ms, chặn trần 50ms cho máy ảo tải cao
        self.assertLess(elapsed_ms, 50.0, f"Độ trễ quá cao: {elapsed_ms:.2f}ms (kỳ vọng < 50ms)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
