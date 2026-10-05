#!/bin/bash
# ==============================================================================
# Script: setup-dev-vm.sh
# Mục đích: 1-Click Bootstrap môi trường Dev PNet/EVE trên máy ảo Ubuntu trắng
# ==============================================================================

set -e

if [ "$EUID" -ne 0 ]; then
  echo "❌ Vui lòng chạy script với quyền root: sudo ./setup-dev-vm.sh"
  exit 1
fi

echo "=========================================================="
echo " 1. Kiểm tra Nested Virtualization (KVM Acceleration)..."
echo "=========================================================="
CPU_VIRT=$(egrep -c '(vmx|svm)' /proc/cpuinfo || true)
if [ "$CPU_VIRT" -eq 0 ]; then
    echo "⚠️ CẢNH BÁO: Chưa bật Nested Virtualization trên máy ảo (VT-x/AMD-V)!"
    echo "   Vui lòng vào cài đặt VMware/VirtualBox để bật tính năng này."
else
    echo "✅ KVM CPU Virtualization đã được kích hoạt ($CPU_VIRT vCPUs)."
fi

echo "=========================================================="
echo " 2. Cài đặt các gói công cụ cốt lõi..."
echo "=========================================================="
apt-get update
apt-get install -y \
    git curl wget rsync net-tools htop \
    python3 python3-pip python3-venv \
    qemu-kvm libvirt-daemon-system libvirt-clients bridge-utils \
    apache2 libapache2-mod-php php php-cli php-mysql php-sqlite3 php-curl php-xml php-mbstring \
    docker.io

echo "=========================================================="
echo " 3. Cấu hình phân quyền Docker & KVM cho www-data..."
echo "=========================================================="
usermod -aG kvm www-data || true
usermod -aG docker www-data || true

echo "=========================================================="
echo " 4. Tạo thư mục làm việc chuẩn /opt/unetlab..."
echo "=========================================================="
mkdir -p /opt/unetlab
mkdir -p /run/pnetlab
chmod 777 /run/pnetlab

echo "=========================================================="
echo " 5. Cài đặt Tailscale (Hỗ trợ Test chéo từ xa)..."
echo "=========================================================="
if ! command -v tailscale &> /dev/null; then
    curl -fsSL https://tailscale.com/install.sh | sh
    echo "Tailscale đã cài đặt. Chạy 'sudo tailscale up' để kết nối mạng nhóm."
fi

echo "=========================================================="
echo " ✅ HOÀN TẤT THIẾT LẬP MÁY ẢO DEV!"
echo " 👉 Tiếp theo: Clone repo git vào /opt/unetlab và mở VS Code Remote-SSH."
echo "=========================================================="
