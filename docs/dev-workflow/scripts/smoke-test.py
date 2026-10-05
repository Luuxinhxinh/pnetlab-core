#!/usr/bin/env python3
"""
scripts/smoke-test.py
Kiểm tra tính toàn vẹn (Smoke Test) hệ thống PNet v8:
1. Unix Domain Socket Broker (/run/pnetlab/broker.sock) - Bỏ qua trên GitHub Actions
2. KVM Hardware Acceleration (/dev/kvm) - Bỏ qua trên GitHub Actions
3. Linting cú pháp PHP toàn bộ file API/Driver - Chạy cả Local và CI
"""

import sys
import os
import socket
import json
import subprocess

IS_CI = os.getenv("GITHUB_ACTIONS") == "true" or os.getenv("CI") == "true"
SOCKET_PATH = "/run/pnetlab/broker.sock"

# Định vị thư mục gốc của repository (thư mục cha của docs/)
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(CURRENT_DIR, "..", "..", ".."))
if not os.path.exists(os.path.join(REPO_ROOT, "html")):
    # Fallback nếu chạy trực tiếp trong /opt/unetlab
    if os.path.exists("/opt/unetlab/html"):
        REPO_ROOT = "/opt/unetlab"
    else:
        REPO_ROOT = os.getcwd()

def print_step(msg):
    print(f"👉 {msg}")

def check_broker_socket():
    if IS_CI:
        print_step("Kiểm tra Broker Socket: Bỏ qua trong môi trường GitHub Actions.")
        return True

    print_step("Kiểm tra kết nối Unix Domain Socket của Broker...")
    if not os.path.exists(SOCKET_PATH):
        print(f"❌ THẤT BẠI: Không tìm thấy socket tại {SOCKET_PATH}. Broker chưa chạy?")
        return False
    
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(2.0)
        sock.connect(SOCKET_PATH)
        
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
    if IS_CI:
        print_step("Kiểm tra KVM: Bỏ qua trong môi trường GitHub Actions.")
        return True

    print_step("Kiểm tra KVM Hardware Acceleration...")
    if os.path.exists("/dev/kvm"):
        print("✅ /dev/kvm tồn tại và sẵn sàng cho QEMU.")
        return True
    else:
        print("⚠️ CẢNH BÁO: /dev/kvm không tìm thấy. QEMU sẽ chạy ở chế độ Software Emulation chậm.")
        return False

def check_php_syntax():
    print_step(f"Kiểm tra cú pháp PHP toàn bộ file API/Driver tại {REPO_ROOT}...")
    php_dirs = [
        os.path.join(REPO_ROOT, "html", "api.php"),
        os.path.join(REPO_ROOT, "html", "devices")
    ]
    has_error = False
    checked_count = 0
    
    for path in php_dirs:
        if os.path.exists(path):
            if os.path.isfile(path):
                checked_count += 1
                res = subprocess.run(["php", "-l", path], capture_output=True, text=True)
                if res.returncode != 0:
                    print(f"❌ LỖI SYNTAX: {path}\n{res.stderr}")
                    has_error = True
            elif os.path.isdir(path):
                for root, _, files in os.walk(path):
                    for file in files:
                        if file.endswith(".php"):
                            checked_count += 1
                            fpath = os.path.join(root, file)
                            res = subprocess.run(["php", "-l", fpath], capture_output=True, text=True)
                            if res.returncode != 0:
                                print(f"❌ LỖI SYNTAX: {fpath}\n{res.stderr}")
                                has_error = True

    if checked_count == 0:
        print(f"⚠️ CẢNH BÁO: Không tìm thấy file PHP nào trong {php_dirs} để kiểm tra.")
    elif not has_error:
        print(f"✅ Đã kiểm tra {checked_count} file PHP core hợp lệ, không có lỗi cú pháp (Linting Passed).")

    return not has_error

def main():
    print("=" * 60)
    print(" 🚀 BẮT ĐẦU SMOKE TEST HỆ THỐNG PNET V8 BACKEND")
    if IS_CI:
        print(" ℹ️ Chạy trong chế độ GitHub Actions CI (Tầng 1 - Linting & Syntax)")
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
        print("❌ PHÁT HIỆN LỖI TRONG QUÁ TRÌNH KIỂM THỬ! VUI LÒNG KIỂM TRA LẠI.")
        sys.exit(1)

if __name__ == "__main__":
    main()
