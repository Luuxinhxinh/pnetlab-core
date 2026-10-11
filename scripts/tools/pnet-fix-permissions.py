#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pnet-fix-permissions.py - PNetLab v8 Permission Standardization & Cleanup Tool
Phân hệ: BE1 Tools / System Administration & DevOps
Quy chuẩn: ENGINEERING_RULES.md (PEP 8, Type Hints, Clean Architecture)

Nhiệm vụ:
1. Chuẩn hóa quyền www-data:www-data (775/664) cho /opt/unetlab/data và /opt/unetlab/html.
2. Chuẩn hóa quyền cho /opt/unetlab/plugins (Plugin SPI của BE2) và Slim 4 API.
3. Bảo vệ an toàn tuyệt đối các tệp nhạy cảm (dbcreds.json 0600, extauth 0700).
4. Khởi tạo thư mục runtime /run/pnetlab sẵn sàng cho Broker Socket.
5. Dọn sạch rác khóa IP tại /dev/shm/pnet-authfail (triệt tiêu lỗi đăng nhập 500/khóa IP).
6. Cấp quyền thực thi (+x) cho các script hệ thống và công cụ quản trị.
"""

import glob
import os
import shutil
import stat
import sys
from typing import Dict, List, Tuple

# Bảng màu ANSI phục vụ hiển thị CLI trực quan
C_RESET = "\033[0m"
C_GREEN = "\033[1;32m"
C_YELLOW = "\033[1;33m"
C_RED = "\033[1;31m"
C_CYAN = "\033[1;36m"
C_BOLD = "\033[1m"


def check_root() -> None:
    """Kiểm tra quyền thực thi root."""
    if os.geteuid() != 0:
        print(f"{C_RED}[LỖI]{C_RESET} Script này bắt buộc phải chạy với quyền root (sudo)!")
        print(f"👉 Vui lòng chạy: {C_YELLOW}sudo python3 {sys.argv[0]}{C_RESET}")
        sys.exit(1)


def get_user_group_ids(user: str, group: str) -> Tuple[int, int]:
    """Lấy UID và GID an toàn từ tên hệ thống."""
    import pwd
    import grp
    try:
        uid = pwd.getpwnam(user).pw_uid
    except KeyError:
        uid = 0
    try:
        gid = grp.getgrnam(group).gr_gid
    except KeyError:
        gid = 0
    return uid, gid


def fix_tree_permissions(
    root_path: str,
    user: str,
    group: str,
    dir_mode: int = 0o775,
    file_mode: int = 0o664,
    exclude_paths: List[str] = None
) -> Tuple[int, int]:
    """
    Quét đệ quy cây thư mục và cấp lại quyền cho thư mục và file.
    Trả về: (số thư mục đã sửa, số file đã sửa)
    """
    if not os.path.exists(root_path):
        return 0, 0

    if exclude_paths is None:
        exclude_paths = []

    uid, gid = get_user_group_ids(user, group)
    dir_count = 0
    file_count = 0

    for dirpath, dirnames, filenames in os.walk(root_path):
        # Bỏ qua các đường dẫn nằm trong danh sách loại trừ
        if any(os.path.commonpath([dirpath, ex]) == ex for ex in exclude_paths if os.path.exists(ex)):
            continue

        try:
            os.chown(dirpath, uid, gid)
            os.chmod(dirpath, dir_mode)
            dir_count += 1
        except OSError:
            pass

        for fname in filenames:
            fpath = os.path.join(dirpath, fname)
            if any(fpath == ex or fpath.startswith(ex + "/") for ex in exclude_paths):
                continue

            try:
                os.chown(fpath, uid, gid)
                os.chmod(fpath, file_mode)
                file_count += 1
            except OSError:
                pass

    return dir_count, file_count


def secure_protected_assets() -> List[str]:
    """Siết chặt các vùng bảo mật đặc biệt (Credentials, PKI, Extauth)."""
    messages: List[str] = []

    # 1. /opt/unetlab/data/dbcreds.json
    dbcreds = "/opt/unetlab/data/dbcreds.json"
    if os.path.exists(dbcreds):
        try:
            os.chown(dbcreds, 0, 0)
            os.chmod(dbcreds, 0o600)
            messages.append(f"Siết quyền an toàn 0600 cho {dbcreds}")
        except OSError as exc:
            messages.append(f"Cảnh báo: Không thể chmod {dbcreds}: {exc}")

    # 2. /opt/unetlab/database_backup
    db_backup = "/opt/unetlab/database_backup"
    if os.path.exists(db_backup):
        try:
            os.chown(db_backup, 0, 0)
            os.chmod(db_backup, 0o700)
            for f in glob.glob(os.path.join(db_backup, "*.sql")):
                os.chmod(f, 0o600)
            messages.append(f"Bảo vệ thư mục sao lưu CSDL {db_backup} (mode 0700)")
        except OSError:
            pass

    # 3. /opt/unetlab/data/extauth
    extauth = "/opt/unetlab/data/extauth"
    if os.path.exists(extauth):
        try:
            os.chown(extauth, 0, 0)
            os.chmod(extauth, 0o700)
            cfg = os.path.join(extauth, "config.json")
            if os.path.exists(cfg):
                os.chmod(cfg, 0o600)
            messages.append(f"Bảo vệ vùng cấu hình xác thực ngoài {extauth} (mode 0700)")
        except OSError:
            pass

    return messages


def setup_runtime_dir() -> str:
    """Tạo thư mục runtime /run/pnetlab cho Broker Socket."""
    run_dir = "/run/pnetlab"
    uid, gid = get_user_group_ids("www-data", "www-data")

    os.makedirs(run_dir, exist_ok=True)
    try:
        os.chown(run_dir, uid, gid)
        os.chmod(run_dir, 0o775)
        return f"Thư mục runtime {run_dir} sẵn sàng (mode 0775, owner www-data)"
    except OSError as exc:
        return f"Cảnh báo: Không thể cấp quyền cho {run_dir}: {exc}"


def clean_auth_fail_cache() -> int:
    """Dọn sạch cache chặn IP tại /dev/shm/pnet-authfail."""
    auth_fail_dir = "/dev/shm/pnet-authfail"
    removed_count = 0

    if os.path.exists(auth_fail_dir):
        for item in os.listdir(auth_fail_dir):
            item_path = os.path.join(auth_fail_dir, item)
            try:
                if os.path.isfile(item_path) or os.path.islink(item_path):
                    os.unlink(item_path)
                    removed_count += 1
                elif os.path.isdir(item_path):
                    shutil.rmtree(item_path)
                    removed_count += 1
            except OSError:
                pass
    else:
        os.makedirs(auth_fail_dir, exist_ok=True)

    uid, gid = get_user_group_ids("www-data", "www-data")
    try:
        os.chown(auth_fail_dir, uid, gid)
        os.chmod(auth_fail_dir, 0o777)
    except OSError:
        pass

    return removed_count


def fix_executables() -> int:
    """Cấp quyền thực thi (+x) cho các script hệ thống và wrappers."""
    exec_count = 0
    patterns = [
        "/opt/unetlab/scripts/*.py",
        "/opt/unetlab/scripts/*.sh",
        "/opt/unetlab/scripts/tools/*.py",
        "/opt/unetlab/scripts/tools/*.sh",
        "/opt/unetlab/scripts/pnet-doctor",
        "/opt/unetlab/wrappers/*"
    ]
    for pattern in patterns:
        for fpath in glob.glob(pattern):
            if os.path.isfile(fpath):
                try:
                    current_mode = os.stat(fpath).st_mode
                    os.chmod(fpath, current_mode | 0o755)
                    exec_count += 1
                except OSError:
                    pass
    return exec_count


def main() -> None:
    check_root()

    print(f"{C_CYAN}========================================================================{C_RESET}")
    print(f"      🔧 {C_BOLD}PNETLAB v8 - TỰ ĐỘNG CHUẨN HÓA PHÂN QUYỀN & DỌN RÁC HỆ THỐNG{C_RESET}")
    print(f"{C_CYAN}========================================================================{C_RESET}")

    # 1. Chuẩn hóa /opt/unetlab/data/
    print(f"[*] Đang chuẩn hóa thư mục dữ liệu /opt/unetlab/data/...")
    d_dirs, d_files = fix_tree_permissions(
        "/opt/unetlab/data",
        user="www-data",
        group="www-data",
        dir_mode=0o775,
        file_mode=0o664,
        exclude_paths=["/opt/unetlab/data/extauth", "/opt/unetlab/data/dbcreds.json"]
    )
    print(f"  {C_GREEN}[✔]{C_RESET} Đã chuẩn hóa {d_dirs} thư mục, {d_files} tệp trong /opt/unetlab/data/")

    # 2. Chuẩn hóa /opt/unetlab/html/ (Bao gồm Slim 4 API)
    print(f"[*] Đang chuẩn hóa thư mục Web /opt/unetlab/html/ (Slim 4 & Assets)...")
    h_dirs, h_files = fix_tree_permissions(
        "/opt/unetlab/html",
        user="www-data",
        group="www-data",
        dir_mode=0o775,
        file_mode=0o664
    )
    print(f"  {C_GREEN}[✔]{C_RESET} Đã chuẩn hóa {h_dirs} thư mục, {h_files} tệp trong /opt/unetlab/html/")

    # 3. Chuẩn hóa /opt/unetlab/plugins/ (Kiến trúc Plugin SPI của BE2)
    if os.path.exists("/opt/unetlab/plugins"):
        print(f"[*] Đang chuẩn hóa thư mục Plugin SPI /opt/unetlab/plugins/...")
        p_dirs, p_files = fix_tree_permissions(
            "/opt/unetlab/plugins",
            user="www-data",
            group="www-data",
            dir_mode=0o775,
            file_mode=0o664
        )
        print(f"  {C_GREEN}[✔]{C_RESET} Đã chuẩn hóa {p_dirs} thư mục, {p_files} tệp trong /opt/unetlab/plugins/")

    # 4. Bảo vệ tệp nhạy cảm
    print(f"[*] Đang kiểm tra và siết chặt các tệp cấu hình bảo mật...")
    sec_msgs = secure_protected_assets()
    for m in sec_msgs:
        print(f"  {C_GREEN}[✔]{C_RESET} {m}")

    # 5. Khởi tạo runtime dir
    print(f"[*] Đang kiểm tra thư mục runtime /run/pnetlab/...")
    run_msg = setup_runtime_dir()
    print(f"  {C_GREEN}[✔]{C_RESET} {run_msg}")

    # 6. Dọn sạch cache IP bị chặn
    print(f"[*] Đang dọn sạch cache khóa IP đăng nhập...")
    cleaned_auth = clean_auth_fail_cache()
    print(f"  {C_GREEN}[✔]{C_RESET} Đã dọn sạch {cleaned_auth} bản ghi khóa IP tại /dev/shm/pnet-authfail/")

    # 7. Cấp quyền thực thi
    print(f"[*] Đang cấp quyền thực thi (+x) cho các script quản trị và wrappers...")
    execs = fix_executables()
    print(f"  {C_GREEN}[✔]{C_RESET} Đã cấp quyền thực thi cho {execs} script hệ thống.")

    print(f"{C_CYAN}========================================================================{C_RESET}")
    print(f"  {C_GREEN}{C_BOLD}🎉 HOÀN TẤT CHUẨN HÓA! Môi trường PNetLab đã sẵn sàng và sạch lỗi 500.{C_RESET}")
    print(f"{C_CYAN}========================================================================{C_RESET}")


if __name__ == "__main__":
    main()
