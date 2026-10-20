"""
tests/safety_net/test_seam_rest_api.py
TDD Safety Net - Seam 2: Public HTTP REST API Interface (/api/*)
Kiểm tra các hợp đồng API công khai cốt lõi của PNetLab v8 trên Web Server Apache/Slim:
1. Xác thực Authentication (Login / Logout / Auth check)
2. Thao tác Folders & Labs list
3. Danh mục Templates & Template Types
4. Quản lý phiên làm việc và bảo mật HTTP status code (401, 412, 200)
"""

import unittest
import urllib.request
import urllib.parse
import json

BASE_URL = "http://127.0.0.1"

class PNetAPIClient:
    """Helper client HTTP lưu trữ token cookie thủ công."""
    def __init__(self, base_url=BASE_URL):
        self.base_url = base_url
        self.token = None

    def request(self, method, path, data=None):
        url = self.base_url + path
        headers = {}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Cookie"] = f"token={self.token}"

        body = json.dumps(data).encode("utf-8") if data is not None else None
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                status = resp.status
                # Trích xuất cookie nếu có
                set_cookie = resp.headers.get("Set-Cookie")
                if set_cookie and "token=" in set_cookie:
                    parts = set_cookie.split(";")
                    for part in parts:
                        if part.strip().startswith("token="):
                            self.token = part.strip().split("=")[1]
                content = resp.read().decode("utf-8")
                return status, json.loads(content)
        except urllib.error.HTTPError as e:
            content = e.read().decode("utf-8")
            try:
                data = json.loads(content)
            except Exception:
                data = {"raw": content}
            return e.code, data

    def login(self, username="admin", password="pnet"):
        status, resp = self.request("POST", "/api/auth", {"username": username, "password": password})
        return status == 200 and resp.get("status") == "success" and bool(self.token)


class TestRestApiSafetyNet(unittest.TestCase):
    def setUp(self):
        self.client = PNetAPIClient()

    def test_01_unauthenticated_request_rejected(self):
        """Hợp đồng bảo mật: Chưa đăng nhập truy cập /api/folders phải bị từ chối 412 hoặc 401."""
        status, resp = self.client.request("GET", "/api/folders")
        self.assertIn(status, [401, 412], f"Status phải là 401 hoặc 412, nhận: {status}")
        self.assertIn(resp.get("status"), ["fail", "unauthorized", "forbidden"])

    def test_02_login_invalid_credentials(self):
        """Hợp đồng đăng nhập: Sai mật khẩu phải trả về 401 Unauthorized."""
        status, resp = self.client.request("POST", "/api/auth", {"username": "admin", "password": "wrong_password_123"})
        self.assertEqual(status, 401)
        self.assertEqual(resp.get("status"), "unauthorized")

    def test_03_login_valid_credentials(self):
        """Hợp đồng đăng nhập thành công: Trả về HTTP 200 và cấp Token Cookie."""
        status, resp = self.client.request("POST", "/api/auth", {"username": "admin", "password": "pnet"})
        self.assertEqual(status, 200)
        self.assertEqual(resp.get("status"), "success")
        self.assertIsNotNone(self.client.token, "Phải cấp cookie 'token' sau khi login")

    def test_04_authenticated_get_auth_profile(self):
        """Hợp đồng lấy thông tin tài khoản hiện tại: GET /api/auth."""
        self.assertTrue(self.client.login(), "Login phải thành công")
        status, resp = self.client.request("GET", "/api/auth")
        self.assertEqual(status, 200)
        self.assertEqual(resp.get("status"), "success")
        data = resp.get("data", {})
        self.assertEqual(data.get("username"), "admin")
        self.assertEqual(str(data.get("role")), "0", "admin phải có role 0")

    def test_05_authenticated_list_folders_and_labs(self):
        """Hợp đồng duyệt thư mục lab: GET /api/folders."""
        self.assertTrue(self.client.login(), "Login phải thành công")
        status, resp = self.client.request("GET", "/api/folders")
        self.assertEqual(status, 200)
        self.assertEqual(resp.get("status"), "success")
        data = resp.get("data", {})
        self.assertIn("folders", data)
        self.assertIn("labs", data)

    def test_06_list_template_types(self):
        """Hợp đồng lấy danh mục template thiết bị hỗ trợ: GET /api/list/template-types."""
        self.assertTrue(self.client.login(), "Login phải thành công")
        status, resp = self.client.request("GET", "/api/list/template-types")
        self.assertEqual(status, 200)
        self.assertEqual(resp.get("status"), "success")
        data = resp.get("data", {})
        types = list(data.keys()) if isinstance(data, dict) else [d.get("name") for d in data]
        self.assertTrue(len(types) > 0, "Danh sách templates không được rỗng")

    def test_07_logout_workflow(self):
        """Hợp đồng đăng xuất: GET /api/auth/logout xóa session."""
        self.assertTrue(self.client.login(), "Login phải thành công")
        status, resp = self.client.request("GET", "/api/auth/logout")
        self.assertEqual(status, 200)
        
        # Sau khi logout, gọi lại /api/folders phải bị chặn
        status_after, _ = self.client.request("GET", "/api/folders")
        self.assertIn(status_after, [401, 412], "Phải bị chặn sau khi logout")


if __name__ == "__main__":
    unittest.main(verbosity=2)
