#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
secure_db_backup.py - PNetLab v8 Secure Database Backup & Restore Tool
Phân hệ: BE1 Tools / Database Security Hardening
Quy chuẩn: ENGINEERING_RULES.md (PEP 8, Type Hints, Clean Architecture)

Tính năng:
1. Đọc credentials an toàn từ /opt/unetlab/data/dbcreds.json (mode 0600 root-only).
2. Tự phục hồi phân quyền (Self-healing permissions) nếu phát hiện file bị hở quyền.
3. Che giấu hoàn toàn password khỏi bảng tiến trình (ps aux) qua --defaults-extra-file.
4. Hỗ trợ gắn tag nhận diện bản sao lưu (hỗ trợ BE2 chạy Phinx Migrations).
5. Cung cấp cả giao diện CLI và Python API module cho broker daemon tái sử dụng.
"""

import argparse
import datetime
import json
import os
import stat
import subprocess
import sys
import tempfile
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_CREDS_PATH = "/opt/unetlab/data/dbcreds.json"
DEFAULT_BACKUP_DIR = "/opt/unetlab/database_backup"


def load_db_creds(creds_path: str = DEFAULT_CREDS_PATH) -> Dict[str, Any]:
    """
    Đọc thông tin xác thực CSDL từ file cấu hình an toàn.
    Tự động kiểm tra và siết lại quyền 0600 nếu bị lệch.
    """
    if not os.path.exists(creds_path):
        raise FileNotFoundError(f"Không tìm thấy file cấu hình CSDL: {creds_path}")

    # Kiểm tra phân quyền file (bắt buộc chỉ root được đọc/ghi: 0600)
    file_stat = os.stat(creds_path)
    file_mode = stat.S_IMODE(file_stat.st_mode)

    if file_mode != 0o600:
        # Cơ chế Self-healing: tự động sửa lại quyền 0600 an toàn
        try:
            os.chmod(creds_path, 0o600)
        except OSError as exc:
            raise PermissionError(
                f"File cấu hình {creds_path} có quyền không an toàn ({oct(file_mode)}) "
                f"và không thể tự sửa: {exc}"
            ) from exc

    try:
        with open(creds_path, "r", encoding="utf-8") as f:
            creds: Dict[str, Any] = json.load(f)
    except json.JSONDecodeError as exc:
        raise ValueError(f"File {creds_path} không đúng định dạng JSON: {exc}") from exc

    # Xác thực các trường bắt buộc
    for key in ("user", "password", "databases"):
        if key not in creds:
            raise KeyError(f"Thiếu trường bắt buộc '{key}' trong {creds_path}")

    if not isinstance(creds["databases"], list) or not creds["databases"]:
        raise ValueError("Trường 'databases' phải là danh sách ít nhất 1 tên CSDL")

    return creds


def _create_secure_cnf(creds: Dict[str, Any]) -> str:
    """Tạo file cấu hình tạm thời với quyền 0600 chứa thông tin đăng nhập MySQL."""
    tmp_file = tempfile.NamedTemporaryFile(
        mode="w",
        delete=False,
        prefix="pnet_db_",
        suffix=".cnf",
        encoding="utf-8"
    )
    os.chmod(tmp_file.name, 0o600)

    tmp_file.write("[client]\n")
    tmp_file.write(f"user={creds.get('user', 'root')}\n")
    tmp_file.write(f"password={creds.get('password', '')}\n")

    if creds.get("socket") and os.path.exists(creds["socket"]):
        tmp_file.write(f"socket={creds['socket']}\n")
    elif creds.get("host"):
        tmp_file.write(f"host={creds['host']}\n")
        tmp_file.write(f"port={creds.get('port', 3306)}\n")

    tmp_file.flush()
    tmp_file.close()
    return tmp_file.name


def backup_databases(
    creds_path: str = DEFAULT_CREDS_PATH,
    backup_dir: str = DEFAULT_BACKUP_DIR,
    tag: Optional[str] = None
) -> Dict[str, Any]:
    """
    Sao lưu các cơ sở dữ liệu được chỉ định bằng mysqldump an toàn.
    Hỗ trợ tag để phục vụ migration (ví dụ: pre-migration-cascade).
    """
    creds = load_db_creds(creds_path)

    # Đảm bảo thư mục backup tồn tại với quyền an toàn
    os.makedirs(backup_dir, exist_ok=True)
    try:
        os.chmod(backup_dir, 0o700)
    except OSError:
        pass

    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    tag_prefix = f"{tag}_" if tag else ""

    cnf_path = _create_secure_cnf(creds)
    dumped_files: List[str] = []
    errors: List[str] = []

    try:
        for db_name in creds["databases"]:
            out_filename = f"{tag_prefix}{db_name}_{timestamp}.sql"
            out_path = os.path.join(backup_dir, out_filename)

            cmd = [
                "mysqldump",
                f"--defaults-extra-file={cnf_path}",
                "--add-drop-database",
                "--add-drop-table",
                "--skip-comments",
                "--databases",
                db_name
            ]

            with open(out_path, "w", encoding="utf-8") as out_f:
                proc = subprocess.run(
                    cmd,
                    stdout=out_f,
                    stderr=subprocess.PIPE,
                    text=True,
                    stdin=subprocess.DEVNULL
                )

            if proc.returncode != 0:
                errors.append(f"Lỗi sao lưu CSDL {db_name}: {proc.stderr.strip()}")
                if os.path.exists(out_path):
                    os.remove(out_path)
            else:
                os.chmod(out_path, 0o600)
                dumped_files.append(out_path)

        return {
            "ok": len(errors) == 0,
            "timestamp": timestamp,
            "tag": tag,
            "backup_dir": backup_dir,
            "files": dumped_files,
            "errors": errors
        }
    finally:
        if os.path.exists(cnf_path):
            os.remove(cnf_path)


def restore_databases(
    creds_path: str = DEFAULT_CREDS_PATH,
    backup_dir: str = DEFAULT_BACKUP_DIR,
    tag: Optional[str] = None,
    specific_file: Optional[str] = None
) -> Dict[str, Any]:
    """
    Khôi phục cơ sở dữ liệu từ file backup SQL an toàn.
    """
    creds = load_db_creds(creds_path)
    cnf_path = _create_secure_cnf(creds)
    restored_files: List[str] = []
    errors: List[str] = []

    try:
        files_to_restore: List[str] = []
        if specific_file:
            if not os.path.exists(specific_file):
                raise FileNotFoundError(f"Không tìm thấy file: {specific_file}")
            files_to_restore.append(specific_file)
        else:
            # Tìm file backup gần nhất cho từng database
            for db_name in creds["databases"]:
                prefix = f"{tag}_{db_name}_" if tag else f"{db_name}_"
                candidates = [
                    f for f in os.listdir(backup_dir)
                    if f.startswith(prefix) and f.endswith(".sql")
                ]
                candidates.sort(reverse=True)
                if candidates:
                    files_to_restore.append(os.path.join(backup_dir, candidates[0]))
                else:
                    errors.append(f"Không tìm thấy bản backup phù hợp cho CSDL: {db_name}")

        for sql_path in files_to_restore:
            with open(sql_path, "r", encoding="utf-8") as in_f:
                proc = subprocess.run(
                    ["mysql", f"--defaults-extra-file={cnf_path}"],
                    stdin=in_f,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True
                )
            if proc.returncode != 0:
                errors.append(f"Lỗi restore từ {sql_path}: {proc.stderr.strip()}")
            else:
                restored_files.append(sql_path)

        return {
            "ok": len(errors) == 0 and len(restored_files) > 0,
            "restored_files": restored_files,
            "errors": errors
        }
    finally:
        if os.path.exists(cnf_path):
            os.remove(cnf_path)


def verify_connection(creds_path: str = DEFAULT_CREDS_PATH) -> Tuple[bool, str]:
    """Kiểm tra tính hợp lệ của file credentials và kết nối CSDL."""
    try:
        creds = load_db_creds(creds_path)
        cnf_path = _create_secure_cnf(creds)
        try:
            proc = subprocess.run(
                ["mysql", f"--defaults-extra-file={cnf_path}", "-e", "SELECT 1;"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                stdin=subprocess.DEVNULL
            )
            if proc.returncode == 0:
                return True, f"Kết nối CSDL thành công (User: {creds['user']}, DBs: {creds['databases']})"
            return False, f"Kết nối CSDL thất bại: {proc.stderr.strip()}"
        finally:
            if os.path.exists(cnf_path):
                os.remove(cnf_path)
    except Exception as exc:
        return False, f"Lỗi xác thực credentials: {exc}"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="PNetLab v8 Secure Database Backup/Restore Utility"
    )
    parser.add_argument(
        "--action",
        choices=["backup", "restore", "verify"],
        default="backup",
        help="Hành động thực hiện (mặc định: backup)"
    )
    parser.add_argument(
        "--creds",
        default=DEFAULT_CREDS_PATH,
        help="Đường dẫn file dbcreds.json"
    )
    parser.add_argument(
        "--dir",
        default=DEFAULT_BACKUP_DIR,
        help="Thư mục lưu trữ backup"
    )
    parser.add_argument(
        "--tag",
        default=None,
        help="Tag định danh bản backup (vd: pre-migration-cascade)"
    )
    parser.add_argument(
        "--file",
        default=None,
        help="Đường dẫn cụ thể file SQL cần restore"
    )

    args = parser.parse_args()

    if args.action == "verify":
        ok, msg = verify_connection(args.creds)
        print(f"[{'PASS' if ok else 'FAIL'}] {msg}")
        sys.exit(0 if ok else 1)

    elif args.action == "backup":
        print(f"[*] Bắt đầu sao lưu CSDL an toàn (Tag: {args.tag or 'none'})...")
        res = backup_databases(creds_path=args.creds, backup_dir=args.dir, tag=args.tag)
        print(json.dumps(res, indent=2, ensure_ascii=False))
        sys.exit(0 if res["ok"] else 1)

    elif args.action == "restore":
        print(f"[*] Bắt đầu khôi phục CSDL an toàn (Tag: {args.tag or 'none'})...")
        res = restore_databases(
            creds_path=args.creds,
            backup_dir=args.dir,
            tag=args.tag,
            specific_file=args.file
        )
        print(json.dumps(res, indent=2, ensure_ascii=False))
        sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()
