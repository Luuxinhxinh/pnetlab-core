#!/usr/bin/env python3
"""
tests/run_all_safety_net.py
BỘ TEST TỔNG AN TOÀN (SAFETY NET MASTER TEST RUNNER) CHO PNETLAB V8
Thực thi toàn bộ các bài kiểm thử TDD phân tầng theo 3 Seams cốt lõi:
- Seam 1: Privilege Broker Socket Daemon (/run/pnetlab/broker.sock)
- Seam 2: Public HTTP REST API Routes (Authentication, Sessions, Folders)
- Seam 3: Lab & Node Lifecycle Management (Topology, Networks, Nodes)
"""

import sys
import os
import unittest
import time

if "/opt/unetlab" not in sys.path:
    sys.path.insert(0, "/opt/unetlab")

def run():
    print("=" * 70)
    print(" 🚀 BẮT ĐẦU CHẠY BỘ TEST TỔNG TDD SAFETY NET CHO PNETLAB V8")
    print("=" * 70)

    loader = unittest.TestLoader()
    suite = loader.discover(start_dir="/opt/unetlab/tests/safety_net", pattern="test_*.py")

    runner = unittest.TextTestRunner(verbosity=2)
    start_time = time.time()
    result = runner.run(suite)
    elapsed = time.time() - start_time

    print("=" * 70)
    print(f"⏱️ Tổng thời gian chạy: {elapsed:.2f}s")
    print(f"📊 Kết quả: Tổng số tests: {result.testsRun} | Thành công: {result.testsRun - len(result.failures) - len(result.errors)} | Thất bại: {len(result.failures)} | Lỗi: {len(result.errors)}")
    print("=" * 70)

    if result.wasSuccessful():
        print("🎉 TẤT CẢ HỢP ĐỒNG SAFETY NET ĐỀU ĐẠT CHUẨN XANH 100%!")
        print("👉 Hệ thống sẵn sàng cho quá trình Refactor mà không sợ phá vỡ chức năng cũ.")
        sys.exit(0)
    else:
        print("❌ PHÁT HIỆN HỢP ĐỒNG BỊ PHÁ VỠ! Vui lòng kiểm tra lại trước khi refactor.")
        sys.exit(1)

if __name__ == "__main__":
    run()
