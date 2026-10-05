# QUY TRÌNH PHÁT TRIỂN DEV-VM TIÊU CHUẨN

> Chuẩn Quy trình Phát triển & Kiểm thử Hệ thống Phân tán (Local VM + Git + Remote-SSH).  
> Áp dụng cho PNet v8, EVE-NG và các dự án ảo hóa, Linux kernel không phụ thuộc server tập trung.

---

## MỤC LỤC

1. [Phần I: Thiết lập Ban đầu (First-Time Setup)](#phan-i-thiet-lap-ban-dau-first-time-setup)
   - [Giai đoạn 1: Chuẩn bị Máy 1 (Golden Base VM)](#giai-doan-1-chuan-bi-may-1-golden-base-vm)
   - [Giai đoạn 2: Cài đặt cho Thành viên khác (Máy 2 trở đi)](#giai-doan-2-cai-dat-cho-thanh-vien-khac-may-2-tro-di)
   - [Giai đoạn 3: Cấu hình Tài khoản Dev & VS Code Remote-SSH](#giai-doan-3-cau-hinh-tai-khoan-dev--vs-code-remote-ssh)
2. [Phần II: Quy trình Làm việc Hàng ngày (Daily Workflow)](#phan-ii-quy-trinh-lam-viec-hang-ngay-daily-workflow)
   - [1. Đầu ngày](#1-dau-ngay)
   - [2. Trong ngày](#2-trong-ngay)
   - [3. Cuối ngày](#3-cuoi-ngay)
3. [Phần III: Quy trình Refactor, Kiểm thử & An toàn Dữ liệu](#phan-iii-quy-trinh-refactor-kiem-thu--an-toan-du-lieu)
   - [1. Quản lý Snapshot Thông minh & Bảo dưỡng Ổ đĩa Ảo](#1-quan-ly-snapshot-thong-minh--bao-duong-o-dia-ao)
   - [2. Quy trình Test 3 Tầng Tự động](#2-quy-trinh-test-3-tang-tu-dong)
   - [3. Rollback An toàn: Tránh Mất Mát Code](#3-rollback-an-toan-tranh-mat-mat-code)
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
   - Chỉ liên kết cổng vào địa chỉ cục bộ `127.0.0.1` của máy Host để tránh mở dịch vụ ra toàn bộ mạng LAN:
     - SSH Port: Host IP `127.0.0.1`, Host Port `2222` -> Guest Port `22`
     - Web UI Port: Host IP `127.0.0.1`, Host Port `8080` -> Guest Port `80`

5. **Tạo tài khoản người dùng chuẩn (`pnetdev`) & Bảo mật SSH:**
   Tránh dùng tài khoản `root` trực tiếp cho phiên code hằng ngày:
   ```bash
   # Tạo user phát triển có quyền sudo
   sudo adduser pnetdev
   sudo usermod -aG sudo,kvm,docker pnetdev

   # Cấu hình khóa SSH cho user pnetdev
   sudo -u pnetdev mkdir -p /home/pnetdev/.ssh
   sudo -u pnetdev chmod 700 /home/pnetdev/.ssh
   ```

6. **Cài đặt môi trường hệ thống & Clone mã nguồn:**
   ```bash
   # Cài đặt công cụ nền tảng
   sudo apt update && sudo apt install -y git curl wget rsync net-tools python3-pip

   # Chuẩn bị thư mục hệ thống
   sudo mkdir -p /opt/unetlab
   sudo chown -R pnetdev:www-data /opt/unetlab
   sudo chmod -R 775 /opt/unetlab

   # Clone mã nguồn dự án bằng tài khoản dev
   cd /opt/unetlab
   git clone git@github.com:Luuxinhxinh/pnetlab-core.git .
   ```

7. **Xuất file OVA chia sẻ nội bộ:**
   - Tắt máy ảo.
   - Chọn `File -> Export to OVF/OVA`.
   - Tải file `.ova` lên bộ nhớ dùng chung của nhóm (Google Drive / OneDrive / NAS).

---

### Giai đoạn 2: Cài đặt cho Thành viên khác (Máy 2 trở đi)

1. **Import file OVA vào VMware / VirtualBox:**
   - Chọn `File -> Open` -> Chọn file `.ova`.
   - **Bắt buộc:** Tích chọn **Generate new MAC addresses for all network adapters** (hoặc Reinitialize MAC) khi phần mềm hỏi để tránh trùng địa chỉ mạng với thành viên khác.

2. **Cấu hình SSH Key của Máy 2 với GitHub:**
   ```bash
   # Tạo SSH key riêng trên máy ảo
   ssh-keygen -t ed25519 -C "your_email@example.com"
   cat ~/.ssh/id_ed25519.pub
   ```
   - Sao chép khóa công khai và dán vào GitHub: `Settings` -> `SSH and GPG keys` -> `New SSH key`.

3. **Cập nhật mã nguồn mới nhất:**
   ```bash
   cd /opt/unetlab
   git checkout main
   git pull --ff-only origin main
   ```

---

### Giai đoạn 3: Cấu hình Tài khoản Dev & VS Code Remote-SSH

Thay vì kết nối trực tiếp bằng `root`, thiết lập kết nối qua SSH Key với user `pnetdev`:

1. **Tạo và chép SSH Key từ máy Host sang máy ảo:**
   - Trên Terminal máy Host (PowerShell trên Windows hoặc Terminal trên macOS):
     ```bash
     # Tạo key trên máy Host nếu chưa có
     ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_pnetvm -C "host-to-pnetvm"

     # Sao chép public key vào máy ảo thông qua cổng 2222
     ssh-copy-id -i ~/.ssh/id_ed25519_pnetvm.pub -p 2222 pnetdev@127.0.0.1
     ```

2. **Cấu hình file `~/.ssh/config` trên máy Host:**
   Mở file `~/.ssh/config` trên máy Host và thêm cấu hình:
   ```ssh
   Host pnet-dev-vm
       HostName 127.0.0.1
       Port 2222
       User pnetdev
       IdentityFile ~/.ssh/id_ed25519_pnetvm
       StrictHostKeyChecking accept-new
   ```

3. **Mở dự án trên VS Code:**
   - Mở VS Code -> Cài extension **Remote - SSH**.
   - Nhấn icon Remote ở góc dưới bên trái -> Chọn **Connect to Host...** -> Chọn `pnet-dev-vm`.
   - Chọn **Open Folder** -> Mở đường dẫn `/opt/unetlab`.

---

## PHẦN II: QUY TRÌNH LÀM VIỆC HÀNG NGÀY (DAILY WORKFLOW)

```text
       ĐẦU NGÀY                       TRONG NGÀY                       CUỐI NGÀY
+--------------------+          +---------------------+          +--------------------+
| 1. Resume VM       |          | 1. Commit nhỏ & sớm |          | 1. Fetch & Rebase  |
| 2. Quản lý dở dang | -------> | 2. Push sớm giữ code| -------> | 2. Push --force-   |
| 3. pull --ff-only  |          | 3. Rebase giữa ngày |          |    with-lease      |
| 4. sync-env (nếu cầ|          | 4. Test clean/smoke |          | 3. PR & dọn branch |
+--------------------+          +---------------------+          +--------------------+
```

### 1. Đầu ngày
1. Mở phần mềm ảo hóa -> Nhấn **Resume** máy ảo (thời gian khởi động khoảng 3 giây).
2. Kết nối VS Code Remote-SSH vào `/opt/unetlab`.
3. **Xử lý công việc dở dang của hôm trước (nếu có):**
   - Kiểm tra trạng thái: `git status`.
   - Nếu còn code dở chưa muốn commit:
     ```bash
     git stash -u -m "wip-yesterday"
     ```
   - Nếu muốn tiếp tục ngay trên nhánh của ngày hôm trước:
     ```bash
     git checkout feature/branch-cua-hom-qua
     git fetch origin
     git rebase origin/main
     ```
4. **Cập nhật nhánh `main` bằng Fast-Forward:**
   ```bash
   git checkout main
   git pull --ff-only origin main
   ```
   *Lệnh `--ff-only` đảm bảo chỉ cập nhật khi lịch sử hoàn toàn thẳng hàng, tuyệt đối không tạo merge commit rác trên `main`.*

5. **Chỉ chạy `sync-env.sh` khi có thay đổi liên quan:**
   Kiểm tra xem bản pull vừa rồi có chứa migration cơ sở dữ liệu hay package mới không:
   ```bash
   git diff HEAD@{1} HEAD --stat | grep -E '(schema|sql|composer|requirements)'
   ```
   - **Nếu không có kết quả:** Bỏ qua `sync-env.sh`.
   - **Nếu có thay đổi DB/Migration:** **Bắt buộc chụp nhanh 1 snapshot máy ảo** (đặt tên: `Before-DB-Migration`), sau đó mới chạy:
     ```bash
     sudo ./docs/dev-workflow/scripts/sync-env.sh main
     ```

---

### 2. Trong ngày
1. **Tạo nhánh tính năng riêng biệt:**
   ```bash
   # Định dạng chuẩn: feature/<ten-tinh-nang> hoặc fix/<ten-loi>
   git checkout -b feature/sua-api-node
   ```
   *(Nếu trước đó có stash code hôm qua: chạy `git stash pop` để lấy lại code).*

2. **Commit nhỏ, kiểm tra kỹ lưỡng (Tránh commit nhầm file rác/mật khẩu):**
   - Tuyệt đối hạn chế dùng `git add .` bừa bãi.
   - Kiểm tra danh sách file: `git status`.
   - Xem chi tiết từng thay đổi: `git diff`.
   - Thêm từng file cụ thể hoặc dùng `git add -p` để duyệt từng đoạn mã:
     ```bash
     git add path/to/file.php
     git commit -m "feat(api): validate node input payload"
     ```

3. **Push sớm lên GitHub để tránh mất dữ liệu:**
   - Không dồn commit đến cuối ngày. Code chỉ lưu trong máy ảo tiềm ẩn rủi ro hỏng file đĩa ảo (`.vmdk` / `.vdi`).
   - Đẩy nhánh lên remote ngay sau các commit logic quan trọng:
     ```bash
     git push -u origin feature/sua-api-node
     ```

4. **Rebase giữa ngày nếu `main` thay đổi nhiều:**
   - Tránh dồn toàn bộ rebase vào cuối ngày để giảm thiểu nguy cơ conflict lớn:
     ```bash
     git fetch origin
     git rebase origin/main
     ```

5. **Vòng lặp kiểm thử nhanh:**
   - Sửa Backend / Broker: Chạy script dọn tài nguyên mạng ảo và nạp lại daemon:
     ```bash
     sudo ./docs/dev-workflow/scripts/clean-test.sh
     ```

---

### 3. Cuối ngày
1. **Hoàn tất rebase với nhánh `main` mới nhất:**
   ```bash
   git fetch origin
   git rebase origin/main
   ```
   *Nếu có conflict: giải quyết các file xung đột, `git add <file>`, sau đó chạy `git rebase --continue`.*

2. **Đẩy nhánh lên GitHub bằng `--force-with-lease`:**
   Vì rebase viết lại lịch sử commit của nhánh, việc push thông thường sẽ bị từ chối nếu nhánh đã từng được push trước đó.
   - **Bắt buộc dùng `--force-with-lease`** (tự động từ chối nếu có commit mới của người khác đẩy lên nhánh này):
     ```bash
     git push --force-with-lease origin feature/sua-api-node
     ```
   - **Tuyệt đối không dùng cờ `--force` trần.**

3. **Tạo Pull Request trên GitHub:**
   - Tạo PR từ nhánh tính năng vào `main`.
   - Chờ duyệt và thực hiện merge (khuyến nghị Squash and Merge hoặc Rebase Merge).

4. **Dọn dẹp nhánh sau khi đã Merge:**
   Sau khi PR đã được merge trên GitHub, xóa nhánh để giữ danh sách nhánh luôn gọn gàng:
   ```bash
   git checkout main
   git pull --ff-only origin main
   git branch -d feature/sua-api-node
   git remote prune origin
   ```

5. **Kết thúc ngày:** Chọn **Suspend / Save State** máy ảo.

---

## PHẦN III: QUY TRÌNH REFACTOR, KIỂM THỬ & AN TOÀN DỮ LIỆU

### 1. Quản lý Snapshot Thông minh & Bảo dưỡng Ổ đĩa Ảo
- **Snapshot không phải là Backup:** GitHub mới là nơi lưu trữ mã nguồn an toàn nhất. Snapshot chỉ là điểm cứu hộ tức thời cho cấu hình hệ điều hành và môi trường ảo hóa.
- **Dọn dẹp chuỗi Snapshot cũ định kỳ:**
  - Chuỗi snapshot kéo dài sẽ khiến file đĩa ảo bị phân mảnh, tốn dung lượng ổ đĩa thật và làm máy ảo chạy chậm dần.
  - Khi một mốc refactor hoặc migration đã chạy ổn định trên `main`, hãy xóa (Delete/Consolidate) các snapshot phụ cũ, chỉ giữ lại tối đa 1–2 snapshot mốc gần nhất.

---

### 2. Quy trình Test 3 Tầng Tự động

- **Tầng 1 - Linting & Syntax (PHP & Python):**
  ```bash
  python3 ./docs/dev-workflow/scripts/smoke-test.py
  ```

- **Tầng 2 - Smoke Test Socket Broker & Bridge Mạng ảo:**
  ```bash
  sudo ./docs/dev-workflow/scripts/clean-test.sh
  ```

- **Tầng 3 - Tích hợp thực tế:**
  Khởi động thử 1 node lab cơ bản trên Web UI để kiểm tra vòng đời container/QEMU.

---

### 3. Rollback An toàn: Tránh Mất Mát Code
Tránh dùng ngay `git reset --hard` và `git clean -fd` vì hai lệnh này sẽ **xóa vĩnh viễn** toàn bộ code chưa commit và không thể phục hồi.

1. **Xem trước danh sách file rác sắp bị xóa:**
   ```bash
   # Cờ -n chỉ chạy thử (dry-run), cho biết file nào sẽ bị xóa mà chưa xóa thật
   git clean -nd
   ```

2. **Cách hủy an toàn nhất (Cất vào Stash thay vì xóa thẳng tay):**
   ```bash
   # Cất toàn bộ thay đổi và file untracked vào ngăn chứa dự phòng
   git stash -u -m "backup-truoc-khi-huy"
   ```
   *Nếu phát hiện hủy nhầm, bạn vẫn có thể lấy lại code bằng `git stash pop`.*

3. **Chỉ dùng `git reset --hard` khi chắc chắn 100% không cần lại các thay đổi đó.**

---

## PHẦN IV: NGUYÊN TẮC BẮT BUỘC

1. **Khóa nhánh `main`:**
   Tuyệt đối không commit hay push trực tiếp lên nhánh `main`. Mọi thay đổi đều phải thông qua nhánh riêng và Pull Request.

2. **Cập nhật bằng Fast-Forward:**
   Chỉ cập nhật `main` bằng `git pull --ff-only` để giữ lịch sử commit luôn sạch và thẳng hàng.

3. **Commit an toàn & Đẩy sớm:**
   Luôn kiểm tra kỹ `git diff` và `git status` trước khi commit. Đẩy code lên GitHub ngay trong ngày để đề phòng sự cố hỏng đĩa ảo cục bộ.

4. **Bảo vệ bằng `--force-with-lease`:**
   Chỉ ghi đè lịch sử nhánh riêng sau khi rebase bằng `--force-with-lease`, không dùng `--force`.
