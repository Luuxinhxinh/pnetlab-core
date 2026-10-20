"""
tests/safety_net/test_seam_lab_lifecycle.py
TDD Safety Net - Seam 3: Lab & Node Lifecycle Management Interface
Kiểm tra các hợp đồng quản lý bài lab theo chuẩn API thực tế của PNetLab:
1. Đọc thông tin bài lab: POST /api/labs/get {"path": "/12.unl"}
2. Xem trước toàn bộ topology/nodes/networks: POST /api/labs/preview {"path": "/12.unl"}
3. Đọc dữ liệu lab lớn: POST /api/labs/preview {"path": "/StressTest-BGP-Flap-Bloat.unl"}
4. Quản lý hành vi khởi tạo trống khi file chưa tồn tại (Legacy EVE-NG/PNetLab behavior)
"""

import unittest
from tests.safety_net.test_seam_rest_api import PNetAPIClient

class TestLabLifecycleSafetyNet(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = PNetAPIClient()
        assert cls.client.login(), "Đăng nhập admin thất bại trong TestLabLifecycleSafetyNet"

    def test_01_get_lab_details(self):
        """Hợp đồng xem chi tiết bài lab đã tồn tại: POST /api/labs/get."""
        status, resp = self.client.request("POST", "/api/labs/get", {"path": "/12.unl"})
        self.assertEqual(status, 200)
        self.assertEqual(resp.get("status"), "success")
        data = resp.get("data", {})
        self.assertEqual(data.get("name"), "12")
        self.assertIn("version", data)

    def test_02_preview_lab_topology_and_nodes(self):
        """Hợp đồng preview toàn bộ topology (nodes, networks, lines): POST /api/labs/preview."""
        status, resp = self.client.request("POST", "/api/labs/preview", {"path": "/12.unl"})
        self.assertEqual(status, 200)
        self.assertEqual(resp.get("status"), "success")
        data = resp.get("data", {})
        self.assertIn("nodes", data)
        self.assertIn("networks", data)
        self.assertIn("labinfo", data)

    def test_03_preview_complex_bgp_lab(self):
        """Hợp đồng đọc cấu trúc bài lab phức tạp: StressTest-BGP-Flap-Bloat.unl."""
        status, resp = self.client.request("POST", "/api/labs/preview", {"path": "/StressTest-BGP-Flap-Bloat.unl"})
        self.assertEqual(status, 200)
        self.assertEqual(resp.get("status"), "success")
        data = resp.get("data", {})
        nodes = data.get("nodes", {})
        self.assertTrue(len(nodes) > 0, "Stress test lab phải chứa các nodes mạng")

    def test_04_missing_lab_auto_seeds_empty_lab(self):
        """Đặc tính nguyên bản PNetLab: Nếu file lab chưa có, hệ thống tự động khởi tạo empty lab template."""
        status, resp = self.client.request("POST", "/api/labs/get", {"path": "/new_test_lab_sample.unl"})
        self.assertEqual(status, 200)
        self.assertEqual(resp.get("status"), "success")
        data = resp.get("data", {})
        self.assertEqual(data.get("name"), "new_test_lab_sample")
        self.assertIn("id", data)

    def test_05_invalid_lab_filename_rejected(self):
        """Hợp đồng từ chối file lab không hợp lệ (không có đuôi .unl hoặc ký tự cấm)."""
        status, resp = self.client.request("POST", "/api/labs/get", {"path": "/invalid_extension.txt"})
        self.assertEqual(status, 400)
        self.assertEqual(resp.get("status"), "fail")


if __name__ == "__main__":
    unittest.main(verbosity=2)
