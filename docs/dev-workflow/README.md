# DECENTRALIZED DEV-VM WORKFLOW STANDARD
> **Chuẩn Quy trình Phát triển & Kiểm thử Dự án Hệ thống Phân tán (Local VM + Git + Remote-SSH)**  
> *Áp dụng chuẩn cho PNet v8, EVE-NG và các dự án ảo hóa / Linux kernel không phụ thuộc server tập trung.*

---

## 🚀 PHẦN I: HƯỚNG DẪN SETUP ĐẦU TIÊN (FIRST-TIME SETUP)

### 📌 Giai đoạn 1: Chuẩn bị Máy 1 (Golden Base VM)
> *Chỉ cần 1 thành viên trong nhóm thực hiện máy này làm chuẩn, sau đó xuất ra file `.ova` chia sẻ cho cả nhóm.*

1. **Cài đặt VMware Workstation (hoặc VirtualBox)** trên máy Host (Windows/macOS).
2. **Tạo máy ảo Ubuntu Server**:
   * Cấu hình đề xuất: 4 vCPU, 8GB RAM, 50GB ổ cứng (SSD).
3. **BẬT NESTED VIRTUALIZATION (Bắt buộc để chạy QEMU/KVM)**:
   * **VMware**: `Virtual Machine Settings` -> `Processors` -> Tích chọn:
     * `Virtualize Intel VT-x/EPT or AMD-V/RVI`
     * `Virtualize IOMMU (IO memory management unit)`
   * **VirtualBox**: `Settings` -> `System` -> `Processor` -> Tích chọn `Enable Nested VT-x/AMD-V`.
4. **Cấu hình Card Mạng (NAT Port Forwarding)**:
   * Port SSH: Host `2222` -> Guest `22`
   * Port Web UI: Host `8080` -> Guest `80`
5. **Cài đặt môi trường PNet & Clone Git**:
   Mở terminal máy ảo chạy:
   ```bash
   # Cài đặt gói công cụ cơ bản
   sudo apt update && sudo apt install -y git curl wget rsync net-tools python3-pip

   # Clone mã nguồn PNet v8 vào đúng thư mục chuẩn của hệ thống
   sudo mkdir -p /opt/unetlab
   cd /opt/unetlab
   sudo git clone git@github.com:Luuxinhxinh/pnet-v8.git .

   # Cấp quyền thực thi cho www-data
   sudo chown -R www-data:www-data /opt/unetlab/html
   sudo chmod -R 775 /opt/unetlab/html
   ```
6. **Xác lập mốc chuẩn trên GitHub**:
   Kiểm tra chắc chắn Máy 1 đã push nhánh `main` lên GitHub làm chuẩn:
   ```bash
   git checkout main
   git push origin main
   ```
7. **Xuất file OVA chia sẻ cho nhóm**:
   * Tắt máy ảo Máy 1 -> Chọn **File -> Export to OVF/OVA**.
   * Upload file `.ova` lên Google Drive / OneDrive của nhóm.

---

### 📌 Giai đoạn 2: Cài đặt cho Máy 2 (và các thành viên còn lại)
Khi thành viên khác nhận file `.ova` về máy:

1. **Import vào VMware / VirtualBox**:
   * Chọn `File -> Open` -> Chọn file `.ova`.
   * ⚠️ **LƯU Ý QUAN TRỌNG:** Khi phần mềm hỏi, nhớ chọn **"Generate new MAC addresses for all network adapters"** (hoặc tích reinitialize MAC) để tránh trùng địa chỉ MAC card mạng.
2. **Cấu hình SSH Key GitHub trên Máy 2**:
   * Mở terminal máy 2, sinh SSH key riêng của bạn đó:
     ```bash
     ssh-keygen -t ed25519 -C "your_email@example.com"
     cat ~/.ssh/id_ed25519.pub
     ```
   * Copy key trên và dán vào GitHub: `Settings` -> `SSH and GPG keys` -> `New SSH key`.
3. **Kiểm tra kết nối và kéo code mới nhất**:
   ```bash
   cd /opt/unetlab
   git checkout main
   git pull origin main
   ```

---

### 📌 Giai đoạn 3: Cấu hình VS Code Remote - SSH trên máy Host của mỗi người
Để lập trình thoải mái trên giao diện Windows/macOS mà code lưu và chạy trực tiếp trên máy ảo:

1. Mở VS Code trên máy Host -> Cài extension **Remote - SSH** (`ms-vscode-remote.remote-ssh`).
2. Nhấn `F1` (hoặc `Ctrl+Shift+P`) -> Gõ `Remote-SSH: Open SSH Configuration File...` -> Chọn file `~/.ssh/config`. Thêm nội dung:
   ```ssh
   Host pnet-dev-vm
       HostName 127.0.0.1
       Port 2222
       User root
       IdentityFile ~/.ssh/id_rsa
   ```
3. Bấm vào icon góc dưới bên trái VS Code -> Chọn **Connect to Host...** -> Chọn `pnet-dev-vm`.
4. Chọn **Open Folder** -> Mở `/opt/unetlab`.
5. Mở terminal ngay trong VS Code: terminal này đang chạy trực tiếp bên trong Linux của máy ảo!

---

## 🔄 PHẦN II: QUY TRÌNH HÀNG NGÀY CỦA TỪNG MÁY (DAILY WORKFLOW)

```text
       ĐẦU NGÀY                       TRONG NGÀY                       CUỐI NGÀY
┌────────────────────┐          ┌─────────────────────┐          ┌────────────────────┐
│ • Resume VM (3s)   │          │ • Tạo branch riêng  │          │ • git fetch &      │
│ • git checkout main│ ───────> │ • Code trên VS Code │ ───────> │   rebase origin    │
│ • git pull origin  │          │ • Test qua script   │          │ • Push branch PR   │
│ • sync-env.sh      │          │   clean-test.sh     │          │ • Suspend VM (3s)  │
└────────────────────┘          └─────────────────────┘          └────────────────────┘
```

### 1. Đầu ngày (Luôn làm việc này trước khi gõ phím)
1. Bật máy tính -> Bấm **Resume** máy ảo (mất đúng 3 giây, không cần reboot).
2. Mở VS Code Remote-SSH vào `/opt/unetlab`.
3. Kéo toàn bộ cập nhật mới nhất từ GitHub về:
   ```bash
   cd /opt/unetlab
   git checkout main
   git pull origin main
   ```
4. Chạy script đồng bộ môi trường (tự cài python package mới, db migration, restart service):
   ```bash
   sudo ./scripts/sync-env.sh main
   ```

---

### 2. Trong ngày (Quy trình viết code & kiểm thử)
1. **Tuyệt đối KHÔNG code thẳng trên `main`**. Tạo nhánh tính năng mới:
   ```bash
   # Cú pháp: feature/<tên-tính-năng>
   git checkout -b feature/sua-api-node
   ```
2. **Viết code:** Lưu file trên VS Code (ăn thẳng vào máy ảo).
3. **Quy trình Test nhanh (Feedback Loop):**
   * *Nếu sửa Web / HTML / CSS / PHP API:* Mở Chrome máy Host vào `http://localhost:8080`, bấm `Ctrl + F5` là thấy ngay.
   * *Nếu sửa Backend sâu / Python Broker:* Chạy script dọn rác mạng ảo và reload daemon (mất đúng 1 giây):
     ```bash
     sudo ./scripts/clean-test.sh
     ```
     Sau đó bật thử 1 node router nhẹ trong lab để xác nhận chạy thông suốt.

---

### 3. Cuối ngày (Quy trình Push & Merge chuẩn)
1. **Rebase với nhánh `main` mới nhất để chống xung đột:**
   ```bash
   git fetch origin
   git rebase origin/main
   ```
2. **Commit và đẩy nhánh của mình lên GitHub:**
   ```bash
   git status
   git add .
   git commit -m "feat(api): optimize node command generation"
   git push origin feature/sua-api-node
   ```
3. **Tạo Pull Request trên GitHub:**
   * Truy cập GitHub repo -> Tạo PR từ `feature/sua-api-node` vào `main`.
   * Bấm **Merge Pull Request** (hoặc nhờ đồng đội duyệt).
4. **Kết thúc ngày làm việc:** Bấm **Suspend / Save State** máy ảo để hôm sau bật lên dùng tiếp tức thì.

---

## 🛡️ PHẦN III: QUY TRÌNH REFACTOR AN TOÀN, CÔ LẬP LỖI & BACKUP TỨC THÌ

Khi thực hiện **Refactor kiến trúc lớn** (như nâng cấp Slim Framework, xóa bỏ `exec()` chuyển sang Broker, chuẩn hóa Database):

### 1. Chiến lược "Lưới an toàn" trước khi Refactor (Safety Snapshot)
1. **Chụp Snapshot máy ảo (Mất 2 giây):**
   * Trong VMware/VirtualBox, trước khi sửa một module cốt lõi: Chuột phải vào VM -> **Take Snapshot** -> Đặt tên: `Before-Refactor-<Module>`.
   * Nếu quá trình refactor làm sập cấu hình Linux hoặc hỏng sâu: Chuột phải -> **Revert to Snapshot** -> Môi trường trở lại nguyên vẹn 100% trong vòng **5 giây**.
2. **Cô lập theo nhánh Git (Branch Isolation):**
   * Không bao giờ refactor nhiều thứ cùng lúc. Tách nhỏ từng phần:
     * Nhánh 1: `refactor/slim4-psr15` (Chỉ đổi router)
     * Nhánh 2: `refactor/unl-wrapper-broker` (Chỉ đổi cách gọi lệnh đặc quyền)
   * Nhánh nào xong và chạy đạt thì merge nhánh đó trước.

---

### 2. Quy trình Test 3 Tầng Tự động khi Refactor
Thay vì bấm tay kiểm tra, sử dụng bộ công cụ tự động có sẵn:

* **Tầng 1: Linting & Syntax (0.5 giây):**
  Chạy kiểm tra cú pháp toàn bộ file PHP/Python:
  ```bash
  python3 ./scripts/smoke-test.py
  ```
* **Tầng 2: Smoke Test tích hợp Broker & Socket (2 giây):**
  Chạy dọn rác và kiểm tra tự động xem Broker có nhận lệnh, socket có thông:
  ```bash
  sudo ./scripts/clean-test.sh
  ```
* **Tầng 3: Rollback tức thời bằng Git khi sai sót:**
  Nếu code thử nghiệm bị gãy logic hoặc không đi đúng hướng:
  ```bash
  # Hủy toàn bộ thay đổi chưa commit, quay về mốc ban đầu
  git reset --hard HEAD
  git clean -fd
  ```

---

## 🔒 PHẦN IV: NGUYÊN TẮC VÀNG (RULES) CHO CẢ NHÓM

1. **Khóa nhánh `main`:** Chỉ merge code qua Pull Request khi code đã vượt qua `smoke-test.py` trên máy ảo cá nhân.
2. **Không commit file rác / file nặng:** Không commit image QEMU (`.qcow2`), IOL (`.bin`), file log, session vào Git (file `.gitignore` đã chặn sẵn).
3. **Độc lập tài nguyên:** Máy ai người nấy gánh CPU/RAM, hỏng máy ảo cá nhân chỉ cần rollback Snapshot trong 5 giây mà không làm gián đoạn công việc của cả nhóm.
