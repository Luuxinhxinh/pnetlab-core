#!/bin/bash
# ==============================================================================
# Script: pnet-commit.sh
# Mục đích: Tự động lọc sạch file rác runtime, CHỈ chọn đúng file trong phạm vi
#           thư mục của từng thành viên (BE1, BE2, FE1, FE2) và tạo commit sạch.
# Cách dùng: ./scripts/tools/pnet-commit.sh <ROLE> "<Nội dung commit>" [--dry-run]
# Ví dụ:     ./scripts/tools/pnet-commit.sh BE2 "feat(db): add foreign key cascade migrations"
# ==============================================================================

set -e

ROLE=${1:-""}
MSG=${2:-""}
FLAG=${3:-""}

DRY_RUN=0
if [ "$FLAG" = "--dry-run" ] || [ "$MSG" = "--dry-run" ]; then
    DRY_RUN=1
    if [ "$MSG" = "--dry-run" ]; then
        MSG="Dry-run check"
    fi
fi

if [ -z "$ROLE" ] || [ -z "$MSG" ]; then
    echo "❌ Lỗi: Thiếu tham số!"
    echo "👉 Cách dùng: $0 <BE1|BE2|FE1|FE2> \"<Nội dung commit>\" [--dry-run]"
    echo "   Ví dụ:     $0 BE2 \"feat(db): add foreign key cascade migrations\""
    echo "   Kiểm tra:  $0 BE2 --dry-run"
    exit 1
fi

ROLE=$(echo "$ROLE" | tr '[:lower:]' '[:upper:]')

# Ranh giới thư mục được phép commit của từng Role
case "$ROLE" in
    BE1)
        ALLOWED_PATTERNS=("tests/safety_net/" "scripts/tools/" "scripts/pnet-doctor")
        ;;
    BE2)
        ALLOWED_PATTERNS=("database/" "html/api/" "docs/api/" "scripts/pnetlab-brokerd.py" "scripts/mcp/")
        ;;
    FE1)
        ALLOWED_PATTERNS=("html/themes/default/js/canvas" "html/themes/default/js/pnetlab-topology")
        ;;
    FE2)
        ALLOWED_PATTERNS=("html/login/" "html/themes/default/css/tokens.css" "html/themes/default/js/pnetlab-command-palette.js" "html/themes/default/js/pnetlab-hotkeys-modal.js" "html/themes/default/js/pnetlab-toast-manager.js")
        ;;
    *)
        echo "❌ Vai trò không hợp lệ: $ROLE. Chỉ chấp nhận: BE1, BE2, FE1, FE2."
        exit 1
        ;;
esac

echo "=========================================================="
echo " 🔍 Đang quét thay đổi trong phân hệ của $ROLE..."
if [ "$DRY_RUN" -eq 1 ]; then
    echo " ℹ️ CHẾ ĐỘ DRY-RUN: Chỉ kiểm tra danh sách file, chưa commit thật"
fi
echo "=========================================================="

# Hủy stage rác cũ
git reset -q HEAD 2>/dev/null || true

STAGED_COUNT=0

# ── Lấy danh sách file an toàn với ký tự null -z, dấu cách, file đổi tên và thư mục mới ──
while IFS= read -r -d '' file; do
    # ── Bỏ qua tuyệt đối file rác runtime nằm ở mọi tầng thư mục ──
    case "$file" in
        data/*|*/data/*|*.log|*.lock|*/.gitkeep|tmp/*|*/tmp/*)
            continue
            ;;
    esac

    # ── Kiểm tra file có thuộc phạm vi của Role không ──
    IS_ALLOWED=0
    for pattern in "${ALLOWED_PATTERNS[@]}"; do
        if [[ "$file" == "$pattern"* ]]; then
            IS_ALLOWED=1
            break
        fi
    done

    if [ "$IS_ALLOWED" -eq 1 ]; then
        if [ "$DRY_RUN" -eq 0 ]; then
            git add -- "$file"
        fi
        echo "  [+] Đã chọn file hợp lệ: $file"
        STAGED_COUNT=$((STAGED_COUNT + 1))
    else
        echo "  [-] Bỏ qua (ngoài phạm vi $ROLE): $file"
    fi
done < <(
    { git diff --name-only -z; \
      git diff --cached --name-only -z; \
      git ls-files --others --exclude-standard -z; } | sort -zu
)

if [ "$STAGED_COUNT" -eq 0 ]; then
    echo "⚠️ Không tìm thấy thay đổi nào thuộc phạm vi của $ROLE để commit!"
    exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo "=========================================================="
    echo " ℹ️ DRY-RUN XONG: Có $STAGED_COUNT tệp tin hợp lệ sẵn sàng để commit."
    echo "=========================================================="
    exit 0
fi

echo "=========================================================="
echo " 🚀 Đang tạo commit sạch ($STAGED_COUNT tệp tin)..."
echo "=========================================================="
git commit -m "$MSG"
echo "✅ ĐÃ COMMIT SẠCH SẼ!"
echo "👉 Bạn có thể đẩy lên Git an toàn: git push origin HEAD"
