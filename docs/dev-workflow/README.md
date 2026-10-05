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
   - [3. Cuối ngày & Tạo Pull Request](#3-cuoi-ngay--tao-pull-request)
   - [4. Bảng tra cứu & Xử lý sự cố nhanh (Troubleshooting)](#4-bang-tra-cuu--xu-ly-su-co-nhanh-troubleshooting)
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

4. **Cấu hình Mạng, IP Tĩnh & Card Mạng (NAT Port Forwarding):**
   Để quy tắc chuyển cổng không bị hỏng khi IP máy ảo thay đổi theo DHCP, khuyến nghị thiết lập IP tĩnh trên máy ảo hoặc gán DHCP cố định:
   
   - **Cấu hình IP tĩnh trong Ubuntu (Netplan):**
     Kiểm tra tên card mạng (`ip link`), chỉnh sửa file `/etc/netplan/01-netcfg.yaml` (ví dụ IP: `192.168.x.50` thuộc dải NAT của phần mềm ảo hóa):
     ```yaml
     network:
       version: 2
       renderer: networkd
       ethernets:
         ens33: # Đổi thành tên card mạng thật của bạn
           dhcp4: no
           addresses: [192.168.x.50/24]
           routes:
             - to: default
               via: 192.168.x.2 # Gateway NAT mặc định
           nameservers:
             addresses: [8.8.8.8, 1.1.1.1]
     ```
     Áp dụng cấu hình: `sudo netplan apply`.

   - **Cấu hình Port Forwarding:**
     - **VirtualBox:** Mở `Network` -> `Advanced` -> `Port Forwarding`. Điền Host IP là `127.0.0.1` để chỉ máy bạn truy cập được:
       - SSH: Host IP `127.0.0.1`, Host Port `2222` -> Guest Port `22`
       - Web UI: Host IP `127.0.0.1`, Host Port `8080` -> Guest Port `80`
     - **VMware Workstation:** Mở `Edit` -> `Virtual Network Editor` (chú ý kiểm tra dải Subnet IP của VMnet8 trên máy bạn) -> Chọn `NAT Settings` -> Thêm Port Forwarding trỏ về đúng IP tĩnh của máy ảo:
       - Cổng SSH: Host `2222` -> Guest IP `192.168.x.50`, Port `22`
       - Cổng Web: Host `8080` -> Guest IP `192.168.x.50`, Port `80`
       - *Lưu ý an toàn:* VMware không có ô Host IP, hãy dùng Windows Firewall chặn cổng 2222/8080 từ mạng ngoài nếu đang kết nối Wi-Fi công cộng.

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
   - Nếu máy mẫu đã cài sẵn PNETLab: chuyển vào thư mục và cấu hình Git.
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
   - **Kiểm tra dải mạng NAT:** Mở `Virtual Network Editor` (trên VMware) hoặc `Network` (trên VirtualBox) để xem dải mạng NAT trên máy thật của mình và cập nhật lại IP tĩnh/Port Forwarding tương ứng nếu dải mạng khác máy mẫu.

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
| 1. Resume VM       |          | 1. Commit nhỏ & sớm |          | 1. Lưu code dở(wip)|
| 2. Kiểm tra status | -------> | 2. Push sớm giữ code| -------> | 2. Rebase origin   |
| 3. Fetch origin    |          | 3. Rebase giữa ngày |          | 3. Push --force-   |
| 4. Chọn nhánh làm  |          | 4. Test clean/smoke |          |    with-lease      |
| 5. sync-env (nếu cầ|          |                     |          | 4. PR & dọn branch |
+--------------------+          +---------------------+          +--------------------+
```

### 1. Đầu ngày
1. Mở phần mềm ảo hóa -> Nhấn **Resume** máy ảo (mất khoảng 3 giây).
2. Kết nối VS Code Remote-SSH vào `/opt/unetlab`.
3. Mở Terminal VS Code, kiểm tra xem có file nào đang bị sửa dở hay không:
   ```bash
   git status
   ```
   *Nếu thấy chữ đỏ (có file bị sửa):* Gõ `git add .` rồi `git commit -m "wip: luu tam dau ngay"` trước khi làm tiếp.
4. Đồng bộ dữ liệu mới nhất từ GitHub về máy (không cần chuyển qua lại giữa các nhánh):
   ```bash
   git fetch origin
   ```
5. Chọn nhánh làm việc:
   - **Trường hợp A: Tiếp tục làm tính năng của hôm qua:**
     ```bash
     git switch feature/ten-nhanh-hom-qua
     git rebase origin/main
     ```
   - **Trường hợp B: Bắt đầu làm tính năng hoàn toàn mới:**
     ```bash
     git switch main
     git pull --ff-only origin main
     git switch -c feature/ten-tinh-nang-moi
     ```
6. *(Tùy chọn)* Kiểm tra nếu có thay đổi Database hoặc thư viện:
   ```bash
   git diff --name-only HEAD origin/main | grep -E '(\.sql|requirements\.txt|composer\.json)'
   ```
   *Nếu terminal in ra tên file:* Hãy Snapshot máy ảo (`Before-Sync`), sau đó chạy:
   ```bash
   sudo ./docs/dev-workflow/scripts/sync-env.sh main
   ```
   *(Nếu không in ra gì thì bỏ qua).*

---

### 2. Trong ngày
1. **Lưu code theo từng cụm thay đổi nhỏ:**
   Dùng Source Control trên thanh công cụ bên trái của VS Code (nhấn dấu `+` cạnh file để Stage), hoặc gõ lệnh:
   ```bash
   git add <duong-dan-file>
   git commit -m "feat(api): mo ta ngan gon viec vua lam"
   ```

2. **Đẩy code lên GitHub để chống mất dữ liệu:**
   - Lần push đầu tiên của một nhánh mới:
     ```bash
     git push -u origin HEAD
     ```
   - Những lần push tiếp theo trong ngày:
     ```bash
     git push
     ```

3. **Rebase giữa ngày nếu `main` có nhiều cập nhật:**
   Giúp phát hiện và giải quyết xung đột sớm theo từng phần nhỏ:
   ```bash
   git fetch origin
   git rebase origin/main
   ```
   *Lưu ý:* Vì rebase viết lại lịch sử commit, sau khi rebase lần push tiếp theo bắt buộc dùng:
   ```bash
   git push --force-with-lease origin HEAD
   ```

4. **Kiểm tra tính đúng đắn trước khi bàn giao:**
   - **Backend / Daemon:** Chạy dọn rác tài nguyên mạng và restart service:
     ```bash
     sudo ./docs/dev-workflow/scripts/clean-test.sh
     ```
   - **Chạy test kiểm tra cú pháp:**
     ```bash
     python3 ./docs/dev-workflow/scripts/smoke-test.py
     ```

---

### 3. Cuối ngày & Tạo Pull Request
1. **Lưu toàn bộ những gì còn dở dang:**
   ```bash
   git add .
   git commit -m "wip: luu code cuoi ngay"
   ```

2. **Cập nhật code mới nhất từ nhánh chính (`main`):**
   ```bash
   git fetch origin
   git rebase origin/main
   ```
   *(Nếu xảy ra xung đột / conflict, xem ngay mục Bảng xử lý sự cố phía dưới).*

3. **Đẩy code lên nhánh từ xa:**
   ```bash
   git push --force-with-lease origin HEAD
   ```

4. **Tạo Pull Request (PR) & Dọn dẹp sau khi Merge (Nếu tính năng đã hoàn tất):**
   - Lên GitHub repo, nhấn **Compare & pull request** -> Tạo PR vào `main`.
   - Chờ CI chạy xong tick xanh ✅ và hoàn tất **Squash and Merge**.
   - Sau khi merge xong trên GitHub, quay lại VS Code dọn nhánh local:
     ```bash
     git switch main
     git pull --ff-only origin main
     git branch -D feature/ten-tinh-nang-vua-xong
     git remote prune origin
     ```

5. Chọn **Suspend / Save State** máy ảo để nghỉ.

---

### 4. Bảng tra cứu & Xử lý sự cố nhanh (Troubleshooting)

| Tình huống / Thông báo lỗi | Nguyên nhân | Cách khắc phục ngay lập tức |
| :--- | :--- | :--- |
| `error: Your local changes to the following files would be overwritten by checkout...` | Đang đổi nhánh trong khi có file bị sửa chưa commit. | Chạy `git add .` rồi `git commit -m "wip: save"` sau đó mới gõ lại lệnh đổi nhánh. |
| Terminal hiện `(feature/...\|REBASE 1/2)` hoặc `CONFLICT (content): Merge conflict in...` | Code của bạn sửa trùng dòng với code người khác vừa merge vào `main`. | **1.** Mở các file bị đánh dấu đỏ trên VS Code, chọn nút bấm hiển thị sẵn: `Accept Current Change` (giữ code của mình) hoặc `Accept Incoming Change` (lấy code trên `main`).<br>**2.** Lưu file lại, gõ: `git add <file-do>`.<br>**3.** Tiếp tục rebase: `git rebase --continue`. *(Tuyệt đối không gõ `git commit`).* |
| Muốn hủy Rebase vì bị rối / làm sai | Không tự tin xử lý tiếp xung đột khi rebase. | Hủy toàn bộ thao tác, đưa nhánh về lại trạng thái an toàn ban đầu bằng lệnh:<br>`git rebase --abort` |
| `error: Cannot delete branch '...' checked out at...` | Bạn đang đứng ở chính nhánh bạn muốn xóa. | Chuyển về `main` trước: `git switch main`, sau đó mới gõ lại: `git branch -D <ten-nhanh>`. |

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
  Tự động quét và kiểm tra cú pháp toàn bộ file PHP trong `html/` (bằng `php -l`) và toàn bộ file Python backend/daemon trong `scripts/` (bằng `py_compile`), chạy cả trên local và CI GitHub Actions:
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
   Khi đẩy nhánh sau rebase (kể cả rebase giữa ngày hay cuối ngày), bắt buộc dùng `--force-with-lease origin HEAD`, không dùng `--force`.
