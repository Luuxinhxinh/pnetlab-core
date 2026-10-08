# HƯỚNG DẪN THAO TÁC GIT THỦ CÔNG (MANUAL GIT WORKFLOW)

> **Tài liệu hướng dẫn chuẩn dành cho lập trình viên trên môi trường PNetLab Dev-VM.**  
> Áp dụng cho toàn bộ các thành viên tham gia phát triển dự án `pnetlab-core`.

---

## MỤC LỤC
1. [Lưu ý Quan trọng trên Môi trường Dev-VM](#1-lưu-ý-quan-trọng-trên-môi-trường-dev-vm)
2. [Quy trình 6 Bước Đưa Code Lên Git Thủ Công](#2-quy-trình-6-bước-đưa-code-lên-git-thủ-công)
   - [Bước 1: Kiểm tra trạng thái thay đổi](#bước-1-kiểm-tra-trạng-thái-thay-đổi-git-status)
   - [Bước 2: Chọn lọc file đưa vào vùng chờ](#bước-2-chọn-lọc-file-đưa-vào-vùng-chờ-git-add)
   - [Bước 3: Tạo commit theo quy chuẩn](#bước-3-tạo-commit-theo-quy-chuẩn-git-commit)
   - [Bước 4: Đồng bộ code mới nhất từ nhánh chính](#bước-4-đồng-bộ-code-mới-nhất-từ-nhánh-chính-git-rebase)
   - [Bước 5: Đẩy code an toàn lên GitHub](#bước-5-đẩy-code-an-toàn-lên-github-git-push)
   - [Bước 6: Tạo Pull Request (PR) trên GitHub](#bước-6-tạo-pull-request-pr-trên-github)
3. [Cách Làm Nhanh: Dùng Script Tự Động Theo Role](#3-cách-làm-nhanh-dùng-script-tự-động-theo-role)
4. [Bảng Tra Cứu & Cứu Hộ Lệnh Khi Thao Tác Nhầm](#4-bảng-tra-cứu--cứu-hộ-lệnh-khi-thao-tác-nhầm)

---

## 1. Lưu ý Quan trọng trên Môi trường Dev-VM

- **Tuyệt đối không dùng `git add .` bừa bãi:** Thư mục `/opt/unetlab` chứa các file logs (`data/Logs/`), cơ sở dữ liệu tạm thời (`*.db`) và các gói máy ảo nặng hàng chục GB. Nếu gõ `git add .` vô tội vạ, bạn có thể vô tình commit file rác hoặc làm nghẽn Git.
- **Không dùng cờ ép đè `-f` (Force):** Tránh các lệnh như `git checkout -f` hay `git reset --hard` trừ khi bạn hiểu rõ và đã sao lưu dữ liệu.
- **Phân quyền hệ thống:** Mọi thao tác Git chạy dưới tài khoản `root` có thể tạo ra file thuộc quyền `root:root`. Dự án đã cài đặt hook tự động, tuy nhiên bạn luôn có thể chạy lệnh sau nếu nghi ngờ mất quyền:
  ```bash
  python3 -c "import sys; sys.path.append('/opt/unetlab/scripts'); from core.system_ops import op_fixpermissions; op_fixpermissions()"
  ```

---

## 2. Quy trình 6 Bước Đưa Code Lên Git Thủ Công

### Bước 1: Kiểm tra trạng thái thay đổi (`git status`)

Trước khi thực hiện bất kỳ thao tác nào, kiểm tra danh sách file đã thay đổi:

```bash
cd /opt/unetlab
git status
```

* **Chữ màu đỏ (Untracked / Modified):** File vừa được sửa hoặc thêm mới nhưng chưa đưa vào vùng chờ (Staging Area).
* **Chữ màu xanh (Changes to be committed):** File đã nằm trong vùng chờ, sẵn sàng được tạo commit.

> **Mẹo:** Để xem chi tiết từng dòng code vừa sửa:
> ```bash
> git diff
> ```

---

### Bước 2: Chọn lọc file đưa vào vùng chờ (`git add`)

Chỉ chọn chính xác những file thuộc tính năng bạn vừa lập trình:

```bash
# Thêm từng file cụ thể:
git add html/api.php html/login/login.js

# Hoặc thêm một thư mục cụ thể bạn phụ trách:
git add html/api/Controllers/
```

Kiểm tra lại bằng `git status`, bạn sẽ thấy các file bạn vừa chọn đã chuyển sang **màu xanh**.

---

### Bước 3: Tạo commit theo quy chuẩn (`git commit`)

Đặt thông điệp commit rõ ràng, tuân thủ chuẩn **Conventional Commits**:

```bash
git commit -m "fix(auth): sua loi resilience khi ghi log api"
```

*Tiền tố commit thông dụng:*
* `feat(...)`: Thêm tính năng mới (Feature).
* `fix(...)`: Sửa lỗi (Bug fix).
* `chore(...)`: Cập nhật cấu hình, workflow, dependency.
* `refactor(...)`: Tái cấu trúc code (không đổi tính năng bên ngoài).
* `test(...)`: Bổ sung hoặc chỉnh sửa test suite.

---

### Bước 4: Đồng bộ code mới nhất từ nhánh chính (`git rebase`)

Trước khi đẩy lên GitHub, bạn cần lấy code mới nhất mà đồng đội vừa merge vào `main` để tránh xung đột:

```bash
git fetch origin
git rebase origin/main
```

* **Trường hợp 1:** Báo `Current branch ... is up to date` -> Thành công, chuyển tiếp sang Bước 5.
* **Trường hợp 2 (Xảy ra xung đột / Conflict):**
  1. Mở các file bị báo đỏ trên VS Code.
  2. Chọn `Accept Current Change` (giữ code của bạn) hoặc `Accept Incoming Change` (lấy code từ `main`).
  3. Lưu file lại và gõ:
     ```bash
     git add <ten-file-vua-sua>
     git rebase --continue
     ```
  *(Tuyệt đối không gõ `git commit` trong lúc đang rebase).*

---

### Bước 5: Đẩy code an toàn lên GitHub (`git push`)

#### Trường hợp A: Nhánh mới tạo (lần đầu đẩy lên GitHub)
```bash
git push -u origin <ten-nhanh-cua-ban>
```
*Ví dụ:* `git push -u origin feature/vinhUpdate`  
*(Cờ `-u` giúp liên kết nhánh cục bộ với nhánh từ xa, từ các lần sau chỉ cần gõ `git push`)*.

#### Trường hợp B: Nhánh đã đẩy lên trước đó
```bash
git push
```
*(Nếu ở Bước 4 bạn vừa rebase code thành công, hãy dùng lệnh an toàn:)*
```bash
git push --force-with-lease origin HEAD
```

---

### Bước 6: Tạo Pull Request (PR) trên GitHub

1. Mở trình duyệt và truy cập trang GitHub của dự án:  
   👉 **[https://github.com/Luuxinhxinh/pnetlab-core](https://github.com/Luuxinhxinh/pnetlab-core)**
2. Nhấn vào nút **Compare & pull request** màu vàng hiển thị trên giao diện.
3. Điền tiêu đề và mô tả ngắn gọn những gì bạn đã làm.
4. Nhấn **Create pull request** để gửi yêu cầu sáp nhập vào `main`.

---

## 3. Cách Làm Nhanh: Dùng Script Tự Động Theo Role

Dự án cung cấp sẵn công cụ `./scripts/tools/pnet-commit.sh` giúp tự động lọc bỏ 100% file rác và chỉ chọn đúng file thuộc vai trò của bạn:

```bash
# Cú pháp:
./scripts/tools/pnet-commit.sh <ROLE> "<Nội dung commit>"

# Ví dụ cho từng vai trò:
./scripts/tools/pnet-commit.sh BE1 "test: bo sung unit test cho broker"
./scripts/tools/pnet-commit.sh BE2 "feat(api): them controller moi"
./scripts/tools/pnet-commit.sh FE1 "feat(canvas): cap nhat topology layout"
./scripts/tools/pnet-commit.sh FE2 "fix(ui): can chinh responsive modal"
```

Sau khi script chạy xong, bạn chỉ cần gõ:
```bash
git push
```

---

## 4. Bảng Tra Cứu & Cứu Hộ Lệnh Khi Thao Tác Nhầm

| Tình huống / Mục đích | Lệnh cần gõ |
| :--- | :--- |
| **Bỏ một file vừa `git add` nhầm ra khỏi vùng chờ** | `git restore --staged <duong-dan-file>` |
| **Hủy bỏ toàn bộ thay đổi chưa lưu trên 1 file** | `git restore <duong-dan-file>` |
| **Cất tạm các thay đổi dở dang để chuyển nhánh** | `git stash` |
| **Lấy lại các thay đổi vừa cất tạm** | `git stash pop` |
| **Hủy bỏ hoàn toàn tiến trình rebase khi bị rối** | `git rebase --abort` |
| **Xem 5 commit gần nhất** | `git log --oneline -n 5` |
| **Kiểm tra danh sách các nhánh hiện có** | `git branch` |
| **Chuyển sang làm việc ở nhánh khác** | `git switch <ten-nhanh>` |
| **Tạo và chuyển sang nhánh mới từ nhánh hiện tại** | `git switch -c <ten-nhanh-moi>` |
