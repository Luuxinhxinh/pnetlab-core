#!/usr/bin/env python3
"""
scripts/smoke-test.py
Kiểm tra tính toàn vẹn (Smoke Test) hệ thống PNet v8:
1. Unix Domain Socket Broker (/run/pnetlab/broker.sock) - Bỏ qua trên GitHub Actions
2. KVM Hardware Acceleration (/dev/kvm) - Chỉ cảnh báo trên Local, bỏ qua trên CI
3. Linting toàn diện cú pháp PHP toàn bộ file trong html/ (212 files)
4. Linting toàn diện cú pháp Python toàn bộ file daemon/backend trong scripts/ (26 files)
"""

import sys
import os
import socket
import json
import subprocess
import py_compile

IS_CI = os.getenv("GITHUB_ACTIONS") == "true" or os.getenv("CI") == "true"
SOCKET_PATH = "/run/pnetlab/broker.sock"

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(CURRENT_DIR, "..", "..", ".."))
if not os.path.exists(os.path.join(REPO_ROOT, "html")):
    if os.path.exists("/opt/unetlab/html"):
        REPO_ROOT = "/opt/unetlab"
    else:
        REPO_ROOT = os.getcwd()

def print_step(msg):
    print(f"👉 {msg}")

def check_kernel_kvm():
    if IS_CI:
        print_step("Kiểm tra KVM: Bỏ qua trong môi trường GitHub Actions.")
        return True

    print_step("Kiểm tra KVM Hardware Acceleration...")
    if os.path.exists("/dev/kvm"):
        print("✅ /dev/kvm sẵn sàng cho QEMU.")
    else:
        print("⚠️ CẢNH BÁO: không có /dev/kvm, QEMU sẽ chạy chậm (Software Emulation).")
    return True

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

def check_php_syntax():
    html_dir = os.path.join(REPO_ROOT, "html")
    print_step(f"Kiểm tra cú pháp PHP toàn diện tại {html_dir}...")
    files = []
    if os.path.exists(html_dir):
        for root, dirs, names in os.walk(html_dir):
            dirs[:] = [d for d in dirs if d not in ("vendor", "node_modules")]
            files += [os.path.join(root, n) for n in names if n.endswith(".php")]

    if not files:
        print(f"❌ LỖI: Không tìm thấy file PHP nào trong {html_dir}. Thư mục mã nguồn không hợp lệ!")
        return False

    bad = 0
    for f in files:
        r = subprocess.run(["php", "-l", f], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"❌ LỖI SYNTAX: {f}\n{r.stdout}{r.stderr}")
            bad += 1

    if bad == 0:
        print(f"✅ {len(files)} file PHP hợp lệ (PHP Linting Passed).")

    return bad == 0

def check_python_syntax():
    scripts_dir = os.path.join(REPO_ROOT, "scripts")
    print_step(f"Kiểm tra cú pháp Python Backend tại {scripts_dir}...")
    files = []
    if os.path.exists(scripts_dir):
        for root, dirs, names in os.walk(scripts_dir):
            dirs[:] = [d for d in dirs if d not in ("vendor", "node_modules")]
            files += [os.path.join(root, n) for n in names if n.endswith(".py")]

    if not files:
        print(f"❌ LỖI: Không tìm thấy file Python nào trong {scripts_dir}.")
        return False

    bad = 0
    for f in files:
        try:
            py_compile.compile(f, doraise=True)
        except Exception as e:
            print(f"❌ LỖI SYNTAX PYTHON: {f}\n{e}")
            bad += 1

    if bad == 0:
        print(f"✅ {len(files)} file Python backend/daemon hợp lệ (Python Compile Passed).")

    return bad == 0

def main():
    print("=" * 60)
    print(" 🚀 BẮT ĐẦU SMOKE TEST HỆ THỐNG PNET V8 BACKEND")
    if IS_CI:
        print(" ℹ️ Chế độ CI: Chạy kiểm tra toàn diện cú pháp PHP & Python")
    print("=" * 60)
    
    success = True
    success &= check_kernel_kvm()
    success &= check_broker_socket()
    success &= check_php_syntax()
    success &= check_python_syntax()
    
    print("=" * 60)
    if success:
        print("🎉 TẤT CẢ KIỂM THỬ KHỞI ĐỘNG ĐỀU ĐẠT! BACKEND SẴN SÀNG.")
        sys.exit(0)
    else:
        print("❌ PHÁT HIỆN LỖI TRONG QUÁ TRÌNH KIỂM THỬ! VUI LÒNG KIỂM TRA LẠI.")
        sys.exit(1)

if __name__ == "__main__":
    main()
