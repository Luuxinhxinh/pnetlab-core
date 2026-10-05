#!/bin/bash
# ==============================================================================
# Script: clean-test.sh
# Mục đích: Dọn dẹp tài nguyên mạng ảo và tiến trình rác trong 1 giây để test backend
# Cách dùng: sudo ./scripts/clean-test.sh
# ==============================================================================

set -e

echo "=== [1/4] Dừng các tiến trình giả lập đang chạy dở ==="
pkill -9 -f "qemu-system" || true
pkill -9 -f "wrapper" || true
pkill -9 -f "dynamips" || true

echo "=== [2/4] Dọn dẹp các bridge mạng ảo và card TAP rác ==="
for br in $(ip link show type bridge 2>/dev/null | awk -F': ' '{print $2}'); do
    if [[ "$br" =~ ^(pnet|vunl|br) ]]; then
        ip link set "$br" down 2>/dev/null || true
        ip link delete "$br" 2>/dev/null || true
    fi
done

for tap in $(ip link show type tun 2>/dev/null | awk -F': ' '{print $2}'); do
    ip link delete "$tap" 2>/dev/null || true
done

echo "=== [3/4] Dọn thư mục tạm lab runtime ==="
if [ -d "/opt/unetlab/tmp" ]; then
    rm -rf /opt/unetlab/tmp/*
fi

echo "=== [4/4] Khởi động lại daemon pnetlab-brokerd ==="
if systemctl is-active --quiet pnetlab-brokerd; then
    systemctl restart pnetlab-brokerd
    echo " -> pnetlab-brokerd đã được nạp lại code mới."
fi

# Chạy tự động Smoke Test nếu có cờ --smoke hoặc có script
if [ "$1" == "--smoke" ] || [ -f "$(dirname "$0")/smoke-test.py" ]; then
    echo ""
    python3 "$(dirname "$0")/smoke-test.py"
fi

echo "✅ Môi trường ảo hóa đã sạch 100%! Bạn có thể test logic mới ngay."
