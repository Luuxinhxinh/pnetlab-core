#!/bin/bash
# ==============================================================================
# Script: sync-env.sh
# Mục đích: Đồng bộ code từ Git, tự động cập nhật môi trường và restart service
# Cách dùng: sudo ./scripts/sync-env.sh [nhánh-git]
# ==============================================================================

set -e

BRANCH=${1:-main}

echo "=========================================================="
echo " [1/5] Kéo mã nguồn mới nhất từ Git (nhánh: $BRANCH)..."
echo "=========================================================="
git fetch origin
git pull origin "$BRANCH"

echo "=========================================================="
echo " [2/5] Cập nhật thư viện Python cho Privilege Broker..."
echo "=========================================================="
if [ -f "requirements.txt" ]; then
    pip3 install -r requirements.txt --quiet
fi

echo "=========================================================="
echo " [3/5] Cập nhật CSDL (Migrations nếu có)..."
echo "=========================================================="
if [ -f "vendor/bin/phinx" ]; then
    php vendor/bin/phinx migrate -e development
fi

echo "=========================================================="
echo " [4/5] Phân quyền chuẩn thư mục hệ thống cho www-data..."
echo "=========================================================="
if [ -d "/opt/unetlab/html" ]; then
    chown -R www-data:www-data /opt/unetlab/html
    chmod -R 775 /opt/unetlab/html
fi

echo "=========================================================="
echo " [5/5] Khởi động lại các daemon dịch vụ..."
echo "=========================================================="
if systemctl is-active --quiet apache2; then
    systemctl restart apache2
    echo " -> Apache2 restarted."
fi

if systemctl is-active --quiet pnetlab-brokerd; then
    systemctl restart pnetlab-brokerd
    echo " -> pnetlab-brokerd restarted."
fi

echo "=========================================================="
echo " ✅ HOÀN TẤT! Máy ảo đã cập nhật và sẵn sàng kiểm thử."
echo "=========================================================="
