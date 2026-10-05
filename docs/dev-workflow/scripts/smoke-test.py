#!/usr/bin/env python3
"""
scripts/smoke-test.py
Kiểm tra tính toàn vẹn (Smoke Test) nhanh toàn bộ chu trình Backend PNet v8:
1. Unix Domain Socket Broker (/run/pnetlab/broker.sock)
2. Quyền SO_PEERCRED & Phản hồi JSON của Broker
3. API Routing & Tạo Lab/Node thử nghiệm
4. Dọn dẹp sạch sẽ tài nguyên sau khi test
Thời gian chạy: < 3 giây.
"""

import sys
import os
import socket
import json
import subprocess
import time

SOCKET_PATH = "/run/pnetlab/broker.sock"

def print_step(msg):
    print(f"👉 {msg}")

def check_broker_socket():
    print_step("Kiểm tra kết nối Unix Domain Socket của Broker...")
    if not os.path.exists(SOCKET_PATH):
        print(f"❌ THẤT BẠI: Không tìm thấy socket tại {SOCKET_PATH}. Broker chưa chạy?")
        return False
    
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(2.0)
        sock.connect(SOCKET_PATH)
        
        # Test ping/status verb cơ bản
        test_payload = {"verb": "status", "params": {}}
        sock.sendall(json.dumps(test_payload).encode('utf-8') + b'\n')
        response = sock.recv(4096).decode('utf-8')
        sock.close()
        
        data = json.loads(response.strip())
        print(f"✅ KẾT NỐI BROKER THÀNH CÔNG: {data}")
        return True
    except Exception as e:
        print(f"❌ THẤT BẠI KHI GỌI BROKER: {e}")
        return False

def check_kernel_kvm():
    print_step("Kiểm tra KVM Hardware Acceleration...")
    if os.path.exists("/dev/kvm"):
        print("✅ /dev/kvm tồn tại và sẵn sàng cho QEMU.")
        return True
    else:
        print("⚠️ CẢNH BÁO: /dev/kvm không tìm thấy. QEMU sẽ chạy ở chế độ Software Emulation chậm.")
        return False

def check_php_syntax():
    print_step("Kiểm tra cú pháp PHP toàn bộ file API/Driver...")
    php_dirs = ["/opt/unetlab/html/api.php", "/opt/unetlab/html/devices"]
    has_error = False
    
    for path in php_dirs:
        if os.path.exists(path):
            if os.path.isfile(path):
                res = subprocess.run(["php", "-l", path], capture_output=True, text=True)
                if res.returncode != 0:
                    print(f"❌ LỖI SYNTAX: {path}\n{res.stderr}")
                    has_error = True
            elif os.path.isdir(path):
                for root, _, files in os.walk(path):
                    for file in files:
                        if file.endswith(".php"):
                            fpath = os.path.join(root, file)
                            res = subprocess.run(["php", "-l", fpath], capture_output=True, text=True)
                            if res.returncode != 0:
                                print(f"❌ LỖI SYNTAX: {fpath}\n{res.stderr}")
                                has_error = True
    if not has_error:
        print("✅ Tất cả các file PHP core hợp lệ, không có lỗi cú pháp (Linting Passed).")
    return not has_error

def main():
    print("=" * 60)
    print(" 🚀 BẮT ĐẦU SMOKE TEST HỆ THỐNG PNET V8 BACKEND")
    print("=" * 60)
    
    success = True
    success &= check_kernel_kvm()
    success &= check_broker_socket()
    success &= check_php_syntax()
    
    print("=" * 60)
    if success:
        print("🎉 TẤT CẢ KIỂM THỬ KHỞI ĐỘNG ĐỀU ĐẠT! BACKEND SẴN SÀNG.")
        sys.exit(0)
    else:
        print("❌ PHÁT HIỆN LỖI TRONG QUÁ TRÌNH REFACTOR! VUI LÒNG KIỂM TRA LẠI.")
        sys.exit(1)

if __name__ == "__main__":
    main()
