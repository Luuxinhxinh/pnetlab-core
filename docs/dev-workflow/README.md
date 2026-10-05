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
   - **VirtualBox:** Thiết lập Port Forwarding với Host IP là `127.0.0.1` để chỉ máy Host truy cập được:
     - SSH: Host IP `127.0.0.1`, Host Port `2222` -> Guest Port `22`
     - Web UI: Host IP `127.0.0.1`, Host Port `8080` -> Guest Port `80`
   - **VMware Workstation:** Mở `Virtual Network Editor` -> Chọn `NAT Settings` -> Thêm Port Forwarding:
     - Cổng SSH: Host `2222` -> Guest IP `192.168.x.x`, Port `22`
     - Cổng Web: Host `8080` -> Guest IP `192.168.x.x`, Port `80`
     - *Lưu ý an toàn:* VMware không có ô Host IP, hãy dùng Windows Firewall chặn cổng 2222/8080 từ mạng ngoài nếu đang dùng Wi-Fi công cộng.

5. **Cài đặt nền tảng PNETLab & Môi trường chạy:**
   Máy mẫu cần cài đặt đầy đủ web server, PHP, Python và KVM:
   ```bash
   sudo apt update
   sudo apt install -y \
       git curl wget rsync net-tools htop \
       python3 python3-pip python3-venv \
       qemu-kvm libvirt-daemon-system libvirt-clients bridge-utils \
       apache2 libapache2-mod-php php php-cli php-mysql php-sqlite3 php-curl php-xml php-mbstring \
       docker.io
   ```

6. **Tạo tài khoản phát triển (`pnetdev`):**
   Tránh dùng tài khoản `root` cho phiên làm việc hằng ngày:
   ```bash
   sudo adduser pnetdev
   sudo usermod -aG sudo,kvm,docker pnetdev
   sudo -u pnetdev mkdir -p /home/pnetdev/.ssh
   sudo -u pnetdev chmod 700 /home/pnetdev/.ssh
   ```

7. **Chuẩn bị thư mục `/opt/unetlab` & Mã nguồn:**
   - Nếu máy mẫu đã cài sẵn PNETLab: chuyển vào thư mục và khởi tạo Git remote.
   - Nếu thiết lập máy mới từ repo GitHub:
   ```bash
   sudo mkdir -p /opt/unetlab
   sudo chown -R pnetdev:www-data /opt/unetlab
   sudo chmod -R 775 /opt/unetlab
   cd /opt/unetlab
   git clone git@github.com:Luuxinhxinh/pnetlab-core.git .
   ```

8. **Xuất file OVA chia sẻ nội bộ:**
   - Tắt máy ảo.
   - Chọn `File -> Export to OVF/OVA`.
   - Tải file `.ova` lên bộ lưu trữ dùng chung của nhóm (Google Drive / OneDrive / NAS).

---

### Giai đoạn 2: Cài đặt cho Thành viên khác (Máy 2 trở đi)

1. **Import file OVA vào VMware / VirtualBox:**
   - Chọn `File -> Open` -> Chọn file `.ova`.
   - **Bắt buộc:** Tích chọn **Generate new MAC addresses for all network adapters** (hoặc Reinitialize MAC) khi phần mềm hỏi để tránh xung đột IP/MAC trong mạng.

2. **Cấu hình danh tính Git cá nhân trên máy ảo:**
   ```bash
   git config --global user.name "Họ và Tên Của Bạn"
   git config --global user.email "your_email@example.com"
   ```

3. **Tạo SSH Key kết nối GitHub:**
   ```bash
   ssh-keygen -t ed25519 -C "your_email@example.com"
   cat ~/.ssh/id_ed25519.pub
   ```
   - Sao chép khóa công khai và thêm vào GitHub: `Settings` -> `SSH and GPG keys` -> `New SSH key`.

4. **Kiểm tra và cập nhật mã nguồn mới nhất:**
   ```bash
   cd /opt/unetlab
   git checkout main
   git pull --ff-only origin main
   ```

---

### Giai đoạn 3: Cấu hình Tài khoản Dev & VS Code Remote-SSH

1. **Tạo và chép SSH Key từ máy Host sang máy ảo:**
   - Trên Terminal máy Host (PowerShell trên Windows hoặc Terminal trên macOS):
     ```bash
     ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_pnetvm -C "host-to-pnetvm"
     ssh-copy-id -i ~/.ssh/id_ed25519_pnetvm.pub -p 2222 pnetdev@127.0.0.1
     ```

2. **Cấu hình file `~/.ssh/config` trên máy Host:**
   Thêm cấu hình kết nối:
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
   - Bấm icon Remote góc dưới bên trái -> Chọn **Connect to Host...** -> Chọn `pnet-dev-vm`.
   - Chọn **Open Folder** -> Mở đường dẫn `/opt/unetlab`.

---

## PHẦN II: QUY TRÌNH LÀM VIỆC HÀNG NGÀY (DAILY WORKFLOW)

```text
       ĐẦU NGÀY                       TRONG NGÀY                       CUỐI NGÀY
+--------------------+          +---------------------+          +--------------------+
| 1. Resume VM       |          | 1. Commit nhỏ & sớm |          | 1. Fetch & Rebase  |
| 2. pull --ff-only  | -------> | 2. Push sớm giữ code| -------> | 2. Push --force-   |
| 3. sync-env (cần)  |          | 3. Rebase giữa ngày |          |    with-lease      |
| 4. Tiếp tục branch |          | 4. Test clean/smoke |          | 3. PR & dọn branch |
+--------------------+          +---------------------+          +--------------------+
```

### 1. Đầu ngày
Thực hiện tuần tự các bước sau trước khi gõ code:

1. Mở phần mềm ảo hóa -> Nhấn **Resume** máy ảo (mất khoảng 3 giây).
2. Kết nối VS Code Remote-SSH vào `/opt/unetlab`.
3. **Cập nhật nhánh `main` mới nhất:**
   ```bash
   git switch main
   OLD=$(git rev-parse HEAD)
   git pull --ff-only origin main
   ```

4. **Kiểm tra và chạy `sync-env.sh` (chỉ khi có migration hoặc thư viện mới):**
   ```bash
   git diff --name-only "$OLD" HEAD | grep -E '(schema|\.sql|composer|requirements)' \
       || echo "Không có thay đổi DB/package, bỏ qua sync-env."
   ```
   - **Nếu có thay đổi DB/migration xuất hiện:** **Bắt buộc chụp nhanh 1 snapshot máy ảo** (đặt tên: `Before-DB-Migration`), sau đó mới chạy:
     ```bash
     sudo ./docs/dev-workflow/scripts/sync-env.sh main
     ```

5. **Chuyển sang nhánh làm việc:**
   - **Nếu tiếp tục công việc của ngày hôm trước:**
     ```bash
     git switch feature/nhanh-cua-hom-qua
     git fetch origin
     git rebase origin/main
     ```
     *(Nếu hôm qua có commit tạm "wip": tiếp tục code, sau đó dùng `git commit --amend` để gộp lại).*
   - **Nếu bắt đầu một tính năng mới:**
     ```bash
     git switch -c feature/ten-tinh-nang-moi
     ```

---

### 2. Trong ngày
1. **Commit nhỏ, kiểm tra kỹ lưỡng:**
   - Không lạm dụng `git add .` để tránh commit nhầm file cấu hình bí mật, mật khẩu hay token API.
   - Luôn kiểm tra danh sách file bằng `git status` và nội dung bằng `git diff`.
   - Dùng `git add <file>` cụ thể hoặc `git add -p` để kiểm tra từng đoạn code trước khi commit:
     ```bash
     git add path/to/file.php
     git commit -m "feat(api): validate node input payload"
     ```

2. **Push sớm lên GitHub để bảo vệ dữ liệu:**
   - Không dồn commit đến cuối ngày. Đĩa ảo có thể gặp sự cố hỏng file bất ngờ; GitHub là nơi lưu an toàn nhất:
     ```bash
     git push -u origin feature/ten-tinh-nang
     ```

3. **Rebase giữa ngày nếu `main` có nhiều cập nhật:**
   - Giúp phát hiện và giải quyết xung đột sớm theo từng phần nhỏ thay vì dồn cục vào cuối ngày:
     ```bash
     git fetch origin
     git rebase origin/main
     ```

4. **Kiểm thử nhanh:**
   - **Backend / Daemon:** Chạy dọn rác tài nguyên mạng và restart service:
     ```bash
     sudo ./docs/dev-workflow/scripts/clean-test.sh
     ```
   - **Cú pháp toàn hệ thống:**
     ```bash
     python3 ./docs/dev-workflow/scripts/smoke-test.py
     ```

---

### 3. Cuối ngày
1. **Hoàn tất rebase với `main` mới nhất:**
   ```bash
   git fetch origin
   git rebase origin/main
   ```
   *Nếu có conflict: sửa các vị trí đánh dấu xung đột, `git add <file>`, rồi chạy `git rebase --continue`.*

2. **Đẩy nhánh lên GitHub bằng `--force-with-lease`:**
   Sau khi rebase, lịch sử commit của nhánh bị viết lại nên lệnh push thường sẽ bị từ chối:
   ```bash
   git push --force-with-lease origin feature/ten-tinh-nang
   ```
   *Tuyệt đối không dùng cờ `--force` trần vì có thể ghi đè mất commit của người khác.*

3. **Tạo Pull Request trên GitHub & Đợi CI Kiểm thử:**
   - Tạo PR từ nhánh tính năng vào `main`.
   - **Đợi mục Checks chạy test `smoke-test` ra dấu tick xanh ✅.** Nhánh `main` đã bật Branch Protection / Ruleset; nếu test đỏ hoặc chưa có approval (khi làm nhóm), nút Merge sẽ bị khóa tự động.
   - Thực hiện merge (khuyến nghị **Squash and Merge**).

4. **Dọn dẹp nhánh sau khi đã Merge:**
   - Sau khi PR đã merge thành công trên GitHub, chuyển về `main` và cập nhật:
     ```bash
     git switch main
     git pull --ff-only origin main
     ```
   - **Lưu ý về xóa nhánh:** Vì dùng Squash Merge nên Git ở local sẽ thấy nhánh tính năng "chưa merge". Hãy dùng cờ **`-D`** (chữ D hoa) để xóa cưỡng chế nhánh local đã hoàn thành:
     ```bash
     git branch -D feature/ten-tinh-nang
     git remote prune origin
     ```

5. **Kết thúc ngày:** Chọn **Suspend / Save State** máy ảo.

---

## PHẦN III: QUY TRÌNH REFACTOR, KIỂM THỬ & AN TOÀN DỮ LIỆU

### 1. Quản lý Snapshot Thông minh & Bảo dưỡng Ổ đĩa Ảo
- **Snapshot không phải là Backup:** GitHub mới là nơi lưu trữ mã nguồn an toàn nhất. Snapshot chỉ dùng để cứu hộ cấu hình OS và môi trường ảo hóa.
- **Dọn dẹp chuỗi Snapshot cũ:**
  - Chuỗi snapshot dài làm file đĩa ảo phân mảnh nặng, chiếm nhiều dung lượng ổ đĩa thật và làm máy ảo chạy chậm dần.
  - Khi một mốc tính năng đã chạy ổn định trên `main`, hãy xóa (Delete/Consolidate) các snapshot cũ, chỉ giữ lại 1–2 snapshot mốc gần nhất.

---

### 2. Quy trình Test 3 Tầng Tự động

- **Tầng 1 - Linting Toàn diện (PHP & Python):**
  Tự động kiểm tra 212 file PHP và 26 daemon Python backend (chạy cả trên local và CI GitHub Actions):
  ```bash
  python3 ./docs/dev-workflow/scripts/smoke-test.py
  ```

- **Tầng 2 - Smoke Test Socket Broker & Bridge Mạng ảo:**
  Kiểm tra kết nối Unix Socket của daemon Broker và card mạng ảo:
  ```bash
  sudo ./docs/dev-workflow/scripts/clean-test.sh
  ```

- **Tầng 3 - Tích hợp thực tế:**
  Khởi động thử 1 node lab trên Web UI để kiểm tra vòng đời QEMU/Docker.

---

### 3. Rollback An toàn: Tránh Mất Mát Code
Không chạy ngay `git reset --hard` và `git clean -fd` khi chưa kiểm tra vì sẽ xóa vĩnh viễn code chưa commit:

1. **Chạy thử trước khi dọn file rác (Dry-run):**
   ```bash
   git clean -nd
   ```
2. **Cất tạm vào Stash an toàn:**
   ```bash
   git stash -u -m "backup-truoc-khi-huy"
   ```
   *Nếu cần lấy lại, chỉ cần chạy `git stash pop`.*

---

## PHẦN IV: NGUYÊN TẮC BẮT BUỘC

1. **Khóa nhánh `main`:**
   Nhánh `main` được bảo vệ bằng GitHub Ruleset. Tuyệt đối không commit hoặc push trực tiếp lên `main`. Mọi thay đổi bắt buộc phải đi qua Pull Request và vượt qua bài kiểm tra `smoke-test` tự động.

2. **Chặn file nặng và dữ liệu nhạy cảm (Tuân thủ `.gitignore`):**
   - **Tuyệt đối không commit:** Ổ đĩa ảo QEMU (`.qcow2`), image IOL/Dynamips (`.bin`), file log (`*.log`), session tạm thời, database runtime (`*.db`). Các file image này nặng hàng chục GB, phải lưu trữ và chia sẻ qua Drive/NAS riêng.
   - **Bảo mật:** Không commit mật khẩu, khóa bí mật, API token, file `.env` hoặc cấu hình cá nhân.

3. **Cập nhật bằng Fast-Forward:**
   Chỉ cập nhật nhánh chính bằng `git pull --ff-only origin main` để giữ lịch sử commit luôn thẳng và sạch.

4. **Bảo vệ lịch sử nhánh bằng `--force-with-lease`:**
   Khi đẩy nhánh sau rebase, bắt buộc dùng `--force-with-lease`, không dùng `--force`.
