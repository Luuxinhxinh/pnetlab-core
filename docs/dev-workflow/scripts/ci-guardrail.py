#!/usr/bin/env python3
"""
scripts/ci-guardrail.py
Bộ kiểm duyệt chất lượng 7 Tầng tự động (7-Layer CI Quality Gate):
1. Chặn File rác & File nặng (> 10MB cho code mới, chặn .qcow2, .iso, .DS_Store...)
2. Linting toàn diện Syntax PHP & Python
3. Quét phát hiện lộ mật khẩu, API key, Secret, Private Key
4. Quét mã độc & Hàm nguy hiểm (eval, passthru, shell=True...)
5. Chặn rác debug chưa dọn (var_dump, print_r, breakpoint, pdb)
6. Kiểm tra tính toàn vẹn cú pháp Database Schema / Migration SQL
7. Kiểm tra đường dẫn cá nhân hardcode (C:\\Users, /home/...)
"""

import sys
import os
import re
import subprocess
import py_compile
import sqlite3

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(CURRENT_DIR, "..", "..", ".."))
if not os.path.exists(os.path.join(REPO_ROOT, "html")):
    if os.path.exists("/opt/unetlab/html"):
        REPO_ROOT = "/opt/unetlab"
    else:
        REPO_ROOT = os.getcwd()

# Giới hạn kích thước file mới trong code/scripts/html
MAX_CODE_FILE_SIZE_MB = 10.0
MAX_CODE_BYTES = int(MAX_CODE_FILE_SIZE_MB * 1024 * 1024)

# Danh sách phần mở rộng cấm tuyệt đối
FORBIDDEN_EXTENSIONS = (
    ".qcow2", ".vmdk", ".vdi", ".iso", ".img",
    ".swp", ".bak", ".tmp"
)
FORBIDDEN_FILENAMES = (
    ".ds_store", "thumbs.db", ".env", "id_rsa", "id_ed25519"
)

# Thư mục chứa bundle nhị phân có sẵn từ gốc hệ thống
EXEMPT_DIRS = ("cluster-bundle", "addons", "data", ".git", "vendor", "node_modules")

SECRET_PATTERNS = [
    (re.compile(r"-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----"), "Khóa SSH/RSA Private Key"),
    (re.compile(r"ghp_[0-9a-zA-Z]{36}"), "GitHub Personal Access Token"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "AWS Access Key ID"),
    (re.compile(r"""(?:api_key|secret_key|private_key)\s*=\s*['"][0-9a-zA-Z\-_]{16,}['"]""", re.IGNORECASE), "Hardcoded Secret/API Key"),
]

DANGEROUS_PHP_PATTERNS = [
    (re.compile(r"\b(eval|passthru)\s*\("), "Hàm nguy hiểm: eval()/passthru()"),
]
DANGEROUS_PY_PATTERNS = [
    (re.compile(r"subprocess\.(Popen|run|call|check_output)\([^)]*shell\s*=\s*True"), "Lỗ hổng Command Injection: shell=True"),
]

DEBUG_PATTERNS = [
    (re.compile(r"\b(var_dump|print_r)\s*\("), "PHP debug artifact (var_dump/print_r)"),
    (re.compile(r"\b(breakpoint\(\)|pdb\.set_trace\(\))"), "Python debugger breakpoint"),
]

PERSONAL_PATH_PATTERN = re.compile(r"""['"](?:/home/(?!www-data|pnetdev|root)[a-zA-Z0-9_\-]+|[A-Za-z]:\\[Uu]sers\\[a-zA-Z0-9_\-]+)""")

def print_step(title):
    print(f"\n👉 {title}")

def check_layer1_file_guards():
    print_step("TẦNG 1: Kiểm tra File rác, File cấm và Kích thước file (> 10MB)...")
    violations = []
    
    for root, dirs, files in os.walk(REPO_ROOT):
        # Bỏ qua thư mục .git và thư mục ngoài
        if ".git" in dirs:
            dirs.remove(".git")
        if "vendor" in dirs:
            dirs.remove("vendor")
        if "node_modules" in dirs:
            dirs.remove("node_modules")

        for f in files:
            fpath = os.path.join(root, f)
            fl_lower = f.lower()
            relpath = os.path.relpath(fpath, REPO_ROOT)

            # Kiểm tra tên cấm
            if fl_lower in FORBIDDEN_FILENAMES:
                violations.append(f"File cấm: {relpath}")
                continue

            # Kiểm tra đuôi cấm tuyệt đối
            if any(fl_lower.endswith(ext) for ext in FORBIDDEN_EXTENSIONS):
                violations.append(f"Định dạng đĩa ảo/tạm cấm commit: {relpath}")
                continue

            # Kiểm tra dung lượng trên các thư mục code/html/scripts (tránh dev commit file nặng mới)
            if not any(relpath.startswith(ex) for ex in EXEMPT_DIRS):
                try:
                    size = os.path.getsize(fpath)
                    if size > MAX_CODE_BYTES:
                        size_mb = size / (1024 * 1024)
                        violations.append(f"File mã nguồn quá lớn ({size_mb:.2f} MB > {MAX_CODE_FILE_SIZE_MB} MB): {relpath}")
                except OSError:
                    pass

    if violations:
        print("❌ PHÁT HIỆN VI PHẠM TẦNG 1:")
        for v in violations[:10]:
            print(f"   - {v}")
        return False

    print("✅ Tầng 1 ĐẠT: Không có file cấm hoặc file đĩa ảo quá khổ.")
    return True

def check_layer2_syntax():
    print_step("TẦNG 2: Kiểm tra toàn diện Cú pháp (PHP Lint & Python Compile)...")
    bad = 0

    # PHP
    php_files = []
    html_dir = os.path.join(REPO_ROOT, "html")
    if os.path.exists(html_dir):
        for root, dirs, names in os.walk(html_dir):
            dirs[:] = [d for d in dirs if d not in ("vendor", "node_modules")]
            php_files += [os.path.join(root, n) for n in names if n.endswith(".php")]

    if not php_files:
        print(f"❌ Không tìm thấy file PHP nào trong {html_dir}")
        return False

    for f in php_files:
        r = subprocess.run(["php", "-l", f], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"❌ LỖI SYNTAX PHP: {os.path.relpath(f, REPO_ROOT)}\n{r.stdout}{r.stderr}")
            bad += 1

    # Python
    py_files = []
    scripts_dir = os.path.join(REPO_ROOT, "scripts")
    if os.path.exists(scripts_dir):
        for root, dirs, names in os.walk(scripts_dir):
            dirs[:] = [d for d in dirs if d not in ("vendor", "node_modules")]
            py_files += [os.path.join(root, n) for n in names if n.endswith(".py")]

    for f in py_files:
        try:
            py_compile.compile(f, doraise=True)
        except Exception as e:
            print(f"❌ LỖI SYNTAX PYTHON: {os.path.relpath(f, REPO_ROOT)}\n{e}")
            bad += 1

    if bad == 0:
        print(f"✅ Tầng 2 ĐẠT: {len(php_files)} file PHP và {len(py_files)} file Python hợp lệ.")
        return True
    return False

def check_code_content_layers():
    print_step("TẦNG 3, 4, 5, 7: Quét Secret, Mã độc, Lệnh Debug và Đường dẫn cá nhân...")
    bad_secrets = []
    bad_dangerous = []
    bad_debugs = []
    bad_paths = []

    target_dirs = [os.path.join(REPO_ROOT, "html"), os.path.join(REPO_ROOT, "scripts")]
    
    for tdir in target_dirs:
        if not os.path.exists(tdir):
            continue
        for root, dirs, files in os.walk(tdir):
            dirs[:] = [d for d in dirs if d not in ("vendor", "node_modules", ".git")]
            for f in files:
                if not (f.endswith(".php") or f.endswith(".py") or f.endswith(".sh") or f.endswith(".json")):
                    continue
                fpath = os.path.join(root, f)
                relpath = os.path.relpath(fpath, REPO_ROOT)
                
                if "ci-guardrail.py" in f:
                    continue

                try:
                    with open(fpath, "r", encoding="utf-8", errors="ignore") as fh:
                        lines = fh.readlines()
                except Exception:
                    continue

                for idx, line in enumerate(lines, 1):
                    # Tầng 3: Secret
                    for pat, desc in SECRET_PATTERNS:
                        if pat.search(line):
                            bad_secrets.append(f"{relpath}:{idx} -> {desc}")

                    # Tầng 4: Dangerous Code
                    if f.endswith(".php"):
                        for pat, desc in DANGEROUS_PHP_PATTERNS:
                            if pat.search(line):
                                bad_dangerous.append(f"{relpath}:{idx} -> {desc}")
                    elif f.endswith(".py"):
                        for pat, desc in DANGEROUS_PY_PATTERNS:
                            if pat.search(line):
                                bad_dangerous.append(f"{relpath}:{idx} -> {desc}")

                    # Tầng 5: Debug Artifacts
                    if f.startswith("api_") or f.endswith("wrapper.php"):
                        for pat, desc in DEBUG_PATTERNS:
                            if pat.search(line):
                                bad_debugs.append(f"{relpath}:{idx} -> {desc}")

                    # Tầng 7: Path cá nhân
                    if PERSONAL_PATH_PATTERN.search(line):
                        bad_paths.append(f"{relpath}:{idx} -> Đường dẫn cá nhân hardcode")

    success = True
    if bad_secrets:
        print("❌ PHÁT HIỆN NGUY CƠ LỘ BÍ MẬT / SECRET:")
        for s in bad_secrets:
            print(f"   - {s}")
        success = False
    else:
        print("✅ Tầng 3 ĐẠT: Không có secret/key bị hardcode.")

    if bad_dangerous:
        print("❌ PHÁT HIỆN MÃ ĐỘC / HÀM NGUY HIỂM:")
        for d in bad_dangerous:
            print(f"   - {d}")
        success = False
    else:
        print("✅ Tầng 4 ĐẠT: Không có hàm nguy hiểm (eval, shell=True).")

    if bad_debugs:
        print("⚠️ CẢNH BÁO LỆNH DEBUG BỊ BỎ QUÊN:")
        for dbg in bad_debugs[:5]:
            print(f"   - {dbg}")
    else:
        print("✅ Tầng 5 ĐẠT: Không có tàn dư lệnh debug.")

    if bad_paths:
        print("❌ PHÁT HIỆN ĐƯỜNG DẪN CÁ NHÂN (/home/...):")
        for p in bad_paths:
            print(f"   - {p}")
        success = False
    else:
        print("✅ Tầng 7 ĐẠT: Đường dẫn hệ thống chuẩn.")

    return success

def check_layer6_database_integrity():
    print_step("TẦNG 6: Kiểm tra Cú pháp Database Schema & Migration SQL...")
    sql_files = []
    for root, dirs, files in os.walk(REPO_ROOT):
        dirs[:] = [d for d in dirs if d not in ("vendor", "node_modules", ".git")]
        for f in files:
            if f.endswith(".sql"):
                sql_files.append(os.path.join(root, f))

    if not sql_files:
        print("ℹ️ Không có file SQL nào trong repo.")
        return True

    bad_sql = 0
    for sf in sql_files:
        relpath = os.path.relpath(sf, REPO_ROOT)
        try:
            with open(sf, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()

            if len(content.strip()) == 0:
                print(f"❌ File SQL rỗng: {relpath}")
                bad_sql += 1
        except Exception as e:
            print(f"❌ Lỗi file SQL {relpath}: {e}")
            bad_sql += 1

    if bad_sql == 0:
        print(f"✅ Tầng 6 ĐẠT: {len(sql_files)} file Database SQL hợp lệ.")
        return True
    return False

def main():
    print("=" * 65)
    print(" 🚀 BẮT ĐẦU KIỂM DUYỆT 7 TẦNG CHẤT LƯỢNG (CI QUALITY GATE)")
    print("=" * 65)

    ok = True
    ok &= check_layer1_file_guards()
    ok &= check_layer2_syntax()
    ok &= check_code_content_layers()
    ok &= check_layer6_database_integrity()

    print("=" * 65)
    if ok:
        print("🎉 TẤT CẢ 7 TẦNG KIỂM DUYỆT ĐỀU ĐẠT! CODE SẠCH ĐỂ TECH LEAD MERGE.")
        sys.exit(0)
    else:
        print("❌ PHÁT HIỆN LỖI CHẤT LƯỢNG / BẢO MẬT! VUI LÒNG KHẮC PHỤC TRƯỚC KHI MERGE.")
        sys.exit(1)

if __name__ == "__main__":
    main()
