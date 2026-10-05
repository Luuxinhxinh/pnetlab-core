# QUY TRÌNH PHÁT TRIỂN DEV-VM TIÊU CHUẨN

> Chuẩn Quy trình Phát triển & Kiểm thử Hệ thống Phân tán (Local VM + Git + Remote-SSH).  
> Áp dụng cho PNet v8, EVE-NG và các dự án ảo hóa, Linux kernel không phụ thuộc server tập trung.

---

## MỤC LỤC

1. [Phần I: Thiết lập Ban đầu (First-Time Setup)](#phan-i-thiet-lap-ban-dau-first-time-setup)
   - [Giai đoạn 1: Chuẩn bị Máy 1 (Golden Base VM)](#giai-doan-1-chuan-bi-may-1-golden-base-vm)
   - [Giai đoạn 2: Cài đặt cho Thành viên khác (Máy 2 trở đi)](#giai-doan-2-cai-dat-cho-thanh-vien-khac-may-2-tro-di)
   - [Giai đoạn 3: Cấu hình VS Code Remote-SSH](#giai-doan-3-cau-hinh-vs-code-remote-ssh)
2. [Phần II: Quy trình Làm việc Hàng ngày (Daily Workflow)](#phan-ii-quy-trinh-lam-viec-hang-ngay-daily-workflow)
   - [1. Đầu ngày](#1-dau-ngay)
   - [2. Trong ngày](#2-trong-ngay)
   - [3. Cuối ngày](#3-cuoi-ngay)
3. [Phần III: Quy trình Refactor, Cô lập Lỗi & Khôi phục Tức thì](#phan-iii-quy-trinh-refactor-co-lap-loi--khoi-phuc-tuc-thi)
   - [1. Chiến lược Snapshot An toàn](#1-chien-luoc-snapshot-an-toan)
   - [2. Quy trình Test 3 Tầng Tự động](#2-quy-trinh-test-3-tang-tu-dong)
4. [Phần IV: Nguyên tắc Bắt buộc](#phan-iv-nguyen-tac-bat-buoc)

---

## PHẦN I: THIẾT LẬP BAN ĐẦU (FIRST-TIME SETUP)

### Giai đoạn 1: Chuẩn bị Máy 1 (Golden Base VM)
*Chỉ một thành viên trong nhóm thiết lập máy mẫu, sau đó xuất file `.ova` chia sẻ cho các thành viên còn lại.*

1. **Cài đặt phần mềm ảo hóa:**
   - Cài đặt VMware Workstation hoặc VirtualBox trên máy Host (Windows / macOS).

2. **Khởi tạo máy ảo Ubuntu Server:**
   - Cấu hình đề xuất: 4 vCPU, 8 GB RAM, 50 GB ổ cứng (SSD).

3. **Kích hoạt Nested Virtualization (Bắt buộc cho QEMU/KVM):**
   - **VMware:** `Virtual Machine Settings` -> `Processors` -> Tích chọn:
     - `Virtualize Intel VT-x/EPT or AMD-V/RVI`
     - `Virtualize IOMMU (IO memory management unit)`
   - **VirtualBox:** `Settings` -> `System` -> `Processor` -> Tích chọn:
     - `Enable Nested VT-x/AMD-V`

4. **Cấu hình Card Mạng (NAT Port Forwarding):**
   - SSH Port: Host `2222` -> Guest `22`
   - Web UI Port: Host `8080` -> Guest `80`

5. **Cài đặt môi trường hệ thống & Clone mã nguồn:**
   Chạy các lệnh sau trong terminal máy ảo:
   ```bash
   # Cài đặt công cụ nền tảng
   sudo apt update && sudo apt install -y git curl wget rsync net-tools python3-pip

   # Chuẩn bị thư mục hệ thống
   sudo mkdir -p /opt/unetlab
   cd /opt/unetlab

   # Clone mã nguồn dự án
   sudo git clone git@github.com:Luuxinhxinh/pnetlab-core.git .

   # Phân quyền cho web server
   sudo chown -R www-data:www-data /opt/unetlab/html
   sudo chmod -R 775 /opt/unetlab/html
   ```

6. **Xác nhận trạng thái nhánh chuẩn trên GitHub:**
   ```bash
   git checkout main
   git push origin main
   ```

7. **Xuất file OVA chia sẻ nội bộ:**
   - Tắt máy ảo.
   - Chọn `File -> Export to OVF/OVA`.
   - Tải file `.ova` lên bộ nhớ dùng chung của nhóm (Google Drive / OneDrive / NAS).

---

### Giai đoạn 2: Cài đặt cho Thành viên khác (Máy 2 trở đi)

1. **Import file OVA vào VMware / VirtualBox:**
   - Chọn `File -> Open` -> Chọn file `.ova`.
   - **Lưu ý:** Khi phần mềm hiển thị tùy chọn import card mạng, bắt buộc chọn **Generate new MAC addresses for all network adapters** (hoặc tích chọn Reinitialize MAC) để tránh xung đột địa chỉ mạng nội bộ.

2. **Cấu hình SSH Key với GitHub trên máy mới:**
   ```bash
   # Tạo SSH key cá nhân
   ssh-keygen -t ed25519 -C "your_email@example.com"
   cat ~/.ssh/id_ed25519.pub
   ```
   - Sao chép khóa công khai (public key) vừa tạo.
   - Thêm vào GitHub: `Settings` -> `SSH and GPG keys` -> `New SSH key`.

3. **Cập nhật mã nguồn mới nhất:**
   ```bash
   cd /opt/unetlab
   git checkout main
   git pull origin main
   ```

---

### Giai đoạn 3: Cấu hình VS Code Remote-SSH
Mô hình phát triển sử dụng VS Code trên máy Host nhưng lưu trữ, biên dịch và chạy code trực tiếp trong máy ảo:

1. Mở VS Code trên máy Host -> Cài đặt extension **Remote - SSH** (`ms-vscode-remote.remote-ssh`).
2. Nhấn `F1` (hoặc `Ctrl+Shift+P`) -> Chọn `Remote-SSH: Open SSH Configuration File...` -> Chọn file cấu hình `~/.ssh/config`.
3. Thêm cấu hình kết nối:
   ```ssh
   Host pnet-dev-vm
       HostName 127.0.0.1
       Port 2222
       User root
       IdentityFile ~/.ssh/id_rsa
   ```
4. Nhấn biểu tượng Remote Connection ở góc trái dưới VS Code -> Chọn **Connect to Host...** -> Chọn `pnet-dev-vm`.
5. Chọn **Open Folder** -> Mở đường dẫn `/opt/unetlab`.
6. Mở Terminal tích hợp trong VS Code để thao tác trực tiếp trên Linux.

---

## PHẦN II: QUY TRÌNH LÀM VIỆC HÀNG NGÀY (DAILY WORKFLOW)

```text
       ĐẦU NGÀY                       TRONG NGÀY                       CUỐI NGÀY
+--------------------+          +---------------------+          +--------------------+
| 1. Resume VM       |          | 1. Tạo branch riêng |          | 1. Fetch & Rebase  |
| 2. git pull origin | -------> | 2. Code trên VSCode | -------> | 2. Push branch     |
| 3. sync-env.sh     |          | 3. Test clean/smoke |          | 3. Tạo PullRequest |
+--------------------+          +---------------------+          +--------------------+
```

### 1. Đầu ngày
Thực hiện các bước sau trước khi bắt đầu viết code:

1. Mở phần mềm ảo hóa -> Nhấn **Resume** máy ảo (thời gian khởi động khoảng 3 giây).
2. Kết nối VS Code Remote-SSH vào `/opt/unetlab`.
3. Kéo toàn bộ mã nguồn cập nhật từ remote:
   ```bash
   cd /opt/unetlab
   git checkout main
   git pull origin main
   ```
4. Chạy script đồng bộ môi trường (cập nhật thư viện Python, migration cấu trúc DB, nạp lại service):
   ```bash
   sudo ./docs/dev-workflow/scripts/sync-env.sh main
   ```

---

### 2. Trong ngày
Quy trình phát triển và kiểm thử tính năng:

1. **Tạo nhánh tính năng riêng biệt (Không commit trực tiếp trên `main`):**
   ```bash
   # Định dạng chuẩn: feature/<ten-tinh-nang> hoặc fix/<ten-loi>
   git checkout -b feature/sua-api-node
   ```
2. **Chỉnh sửa mã nguồn:** Thực hiện lưu code qua VS Code.

3. **Vòng lặp Kiểm thử (Feedback Loop):**
   - **Giao diện Web / API PHP:** Truy cập `http://localhost:8080`, nhấn `Ctrl + F5` để kiểm tra thay đổi ngay lập tức.
   - **Backend / Daemon / Broker:** Chạy script dọn tài nguyên mạng ảo và nạp lại daemon:
     ```bash
     sudo ./docs/dev-workflow/scripts/clean-test.sh
     ```
   - Khởi động thử một node router nhẹ để xác nhận chu trình tạo node hoạt động ổn định.

---

### 3. Cuối ngày
Quy trình bàn giao và tích hợp mã nguồn:

1. **Rebase với nhánh `main` mới nhất để ngăn ngừa xung đột:**
   ```bash
   git fetch origin
   git rebase origin/main
   ```
   *Nếu xuất hiện conflict: giải quyết các file xung đột, `git add`, sau đó chạy `git rebase --continue`.*

2. **Commit và đẩy nhánh tính năng lên GitHub:**
   ```bash
   git status
   git add .
   git commit -m "feat(api): optimize node command generation"
   git push -u origin feature/sua-api-node
   ```

3. **Tạo Pull Request trên GitHub:**
   - Truy cập giao diện GitHub của repository.
   - Tạo Pull Request từ nhánh `feature/sua-api-node` vào `main`.
   - Gắn nhãn hoặc yêu cầu đồng đội / Tech Lead đánh giá (Review).

4. **Kết thúc phiên làm việc:**
   - Chọn **Suspend / Save State** máy ảo để duy trì trạng thái cho phiên làm việc tiếp theo.

---

## PHẦN III: QUY TRÌNH REFACTOR, CÔ LẬP LỖI & KHÔI PHỤC TỨC THÌ

Áp dụng khi tiến hành tái cấu trúc kiến trúc lõi (chuyển đổi router, thay đổi cơ chế Broker đặc quyền, chuẩn hóa Database):

### 1. Chiến lược Snapshot An toàn
1. **Tạo Snapshot máy ảo:**
   - Trước khi can thiệp vào các module tầng sâu: Chuột phải vào máy ảo -> **Take Snapshot** -> Đặt tên theo cú pháp `Before-Refactor-<ModuleName>`.
   - Nếu xảy ra lỗi nghiêm trọng ảnh hưởng cấu hình hệ điều hành: Chuột phải -> **Revert to Snapshot** (hệ thống trở lại trạng thái ban đầu trong vòng 5 giây).

2. **Cô lập theo nhánh Git:**
   - Tách nhỏ từng phần refactor thành các nhánh độc lập:
     - Nhánh 1: `refactor/router-psr15` (Chỉ thay đổi router)
     - Nhánh 2: `refactor/unl-broker-ipc` (Chỉ thay đổi cơ chế giao tiếp đặc quyền)
   - Mỗi nhánh chỉ được tích hợp khi đã vượt qua toàn bộ tiêu chuẩn kiểm thử.

---

### 2. Quy trình Test 3 Tầng Tự động

- **Tầng 1 - Linting & Kiểm tra Cú pháp:**
  Kiểm tra cú pháp toàn bộ tệp tin PHP và Python:
  ```bash
  python3 ./docs/dev-workflow/scripts/smoke-test.py
  ```

- **Tầng 2 - Smoke Test Socket & Tích hợp:**
  Kiểm tra kết nối Unix Domain Socket, quyền thực thi và phản hồi JSON của Broker:
  ```bash
  sudo ./docs/dev-workflow/scripts/clean-test.sh
  ```

- **Tầng 3 - Khôi phục Trạng thái Git khi có Sai sót:**
  Hủy bỏ toàn bộ thay đổi chưa commit để quay về trạng thái ổn định gần nhất:
  ```bash
  git reset --hard HEAD
  git clean -fd
  ```

---

## PHẦN IV: NGUYÊN TẮC BẮT BUỘC

1. **Khóa nhánh `main`:**
   Toàn bộ mã nguồn chỉ được đưa vào nhánh `main` thông qua Pull Request sau khi vượt qua bài kiểm tra `smoke-test.py`.

2. **Quản lý dữ liệu và tệp lớn:**
   Tuyệt đối không commit các file nhị phân lớn, ổ đĩa ảo QEMU (`.qcow2`), image IOL (`.bin`), file log hoặc session tạm thời vào Git. Các tệp này được định nghĩa loại trừ trong `.gitignore`.

3. **Tính độc lập về tài nguyên:**
   Mỗi thành viên chịu trách nhiệm về tài nguyên CPU/RAM trên máy ảo cá nhân. Mọi sự cố trên môi trường thử nghiệm đều có thể khôi phục qua Snapshot mà không gây gián đoạn tiến độ chung của nhóm.
