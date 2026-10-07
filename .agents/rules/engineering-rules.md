# QUY CHUẨN KIẾN TRÚC MÃ NGUỒN, FORMAT CODE & KỶ LUẬT PHÁT TRIỂN PNETLAB V8
## (PNETLAB V8 ENGINEERING RULES & CLEAN ARCHITECTURE STANDARD)

> **Mục đích**: Chấm dứt triệt để tư duy "chỉ code để chạy được", ngăn chặn việc dồn hàng nghìn dòng logic vào 1 file (như `api.php` 3.668 dòng hay `pnetlab-brokerd.py` 7.738 dòng), phân định rõ ranh giới trách nhiệm giữa 4 thành viên và đảm bảo hệ thống có khả năng mở rộng (Scale), bảo trì (Maintain) và tự sửa lỗi (Repair).

---

## 🏛️ PHẦN I: NGUYÊN TẮC THIẾT KẾ KIẾN TRÚC (SOLID & CLEAN CODE)

Mọi dòng code mới hoặc tính năng refactor bắt buộc phải tuân thủ 5 nguyên lý SOLID và Clean Architecture:

### 1. Single Responsibility Principle (SRP - Đơn trách nhiệm)
- **Cấm tiệt**: Viết hàm callback ẩn danh dài hàng trăm dòng trực tiếp trong router (như `api.php` cũ).
- **Quy chuẩn mới**:
  - **Router** chỉ làm nhiệm vụ: Khai báo đường dẫn HTTP, gắn Middleware và gọi Controller.
  - **Controller** chỉ làm nhiệm vụ: Nhận Request, validate dữ liệu đầu vào qua Schema, gọi Service xử lý và trả về Response.
  - **Service/Domain Logic** làm nhiệm vụ: Tính toán nghiệp vụ, kiểm tra trạng thái node, gọi Broker hoặc Database.
  - **Giới hạn kích thước file**: Không một file mới nào được vượt quá **400 dòng lệnh**. Nếu vượt quá, bắt buộc phải tách Service hoặc Helper.

### 2. Open/Closed Principle (OCP - Đóng để sửa, Mở để cắm thêm)
- **Cấm tiệt**: Khi thêm 1 loại thiết bị mới (vd: Arista vEOS, Mikrotik) hoặc tính năng mới (AI, CTF, Lab Store) lại đi sửa trực tiếp vào mã nguồn lõi `api.php`, `device.php` hay bảng SQL gốc.
- **Quy chuẩn mới**:
  - Mọi tính năng mở rộng bắt buộc phải được đóng gói thành **Plugin** đặt tại `/opt/unetlab/plugins/<plugin_id>/`.
  - Can thiệp vào hệ thống thông qua **Event Hooks Bus** (`hook_register('node.pre_start')`) hoặc **Extension Slots** trên UI.

### 3. Dependency Inversion Principle (DIP - Đảo ngược phụ thuộc)
- **Cấm tiệt**: Khởi tạo trực tiếp đối tượng kết nối bên trong Controller (ví dụ gọi `checkDatabase()`, `new PDO()`, hay gọi trực tiếp shell `exec('sudo ...')`).
- **Quy chuẩn mới**:
  - Áp dụng **Dependency Injection (DI)** thông qua Container của Slim 4.
  - Tầng Web (PHP) không bao giờ can thiệp trực tiếp vào hệ điều hành; mọi thao tác đặc quyền bắt buộc phải bọc qua client interface `broker_call()` gửi lệnh qua Unix Socket `/run/pnetlab/broker.sock`.

---

## 👥 PHẦN II: PHẠM VI HOẠT ĐỘNG & RANH GIỚI TRÁCH NHIỆM (BOUNDARY ENFORCEMENT)

Để triệt tiêu 100% tình trạng **Merge Conflict** và đè code của nhau, 4 thành viên hoạt động trên các vùng thư mục cô lập:

| Thành viên | Vai trò | Vùng thư mục được phép can thiệp (Write Boundary) | Nhiệm vụ trọng tâm & Vùng cấm sửa |
| :--- | :--- | :--- | :--- |
| **BE1** | Core Tests & Diagnostics (Nhẹ nhàng, Rủi ro thấp) | `/opt/unetlab/tests/safety_net/`<br>`/opt/unetlab/scripts/tools/`<br>`/opt/unetlab/scripts/pnet-doctor` | **Nhiệm vụ:** Viết integration tests cho socket broker, bảo mật script backup DB, script sửa quyền, script chẩn đoán `pnet-doctor`.<br>⛔ **Cấm sửa:** `pnetlab-brokerd.py` và toàn bộ thư mục `html/`. |
| **BE2** | Core Architecture, Linux Netlink, API & AI MCP (Lead Backend) | `/opt/unetlab/scripts/pnetlab-brokerd.py`<br>`/opt/unetlab/html/api/` (Slim 4)<br>`/opt/unetlab/database/migrations/`<br>`/opt/unetlab/scripts/mcp/` | **Nhiệm vụ:** Rebroker code C sang Python, dọn rác mạng Netlink, xóa sổ `unl_wrapper`, nâng cấp Slim 4, Phinx Migrations, AI MCP Server 8090, đóng gói `.pnetlabz`.<br>⛔ **Cấm sửa:** `tests/safety_net/` của BE1 và mã nguồn Canvas/UI của Frontend. |
| **FE1** | Canvas 2D Engine & Topology Optimization | `/opt/unetlab/html/themes/default/js/canvas-flow*.js`<br>`/opt/unetlab/html/themes/default/js/pnetlab-topology-*.js` | **Nhiệm vụ:** Tối ưu hóa Canvas 60 FPS (QuadTree), đường cong Bezier nối dây mạng, thuật toán tự dàn sơ đồ (Auto-Layout), xem trước topo (Preview).<br>⛔ **Cấm sửa:** Backend scripts, PHP APIs, và các file UI/Modal của FE2. |
| **FE2** | UI/UX, Design Tokens & User Experience | `/opt/unetlab/html/login/`<br>`/opt/unetlab/html/themes/default/css/tokens.css`<br>`/opt/unetlab/html/themes/default/js/pnetlab-command-palette.js`<br>`/opt/unetlab/html/themes/default/js/pnetlab-hotkeys-modal.js`<br>`/opt/unetlab/html/themes/default/js/pnetlab-toast-manager.js` | **Nhiệm vụ:** Chuẩn hóa giao diện Login & Design Tokens, thanh tìm kiếm phím tắt `Ctrl + K`, modal phím tắt trợ giúp `?`, trung tâm thông báo Toast Manager.<br>⛔ **Cấm sửa:** Logic toán học vẽ trên Canvas của FE1 và Backend scripts. |

> ⚠️ **Quy tắc phối hợp giữa BE và FE**:
> - Hai bên độc lập tuyệt đối. FE làm việc trực tiếp trên giao diện và gọi Backend qua HTTP/WebSocket chuẩn.
> - BE2 hoàn thành tính năng nào thì test xanh rồi push, FE pull về dùng trực tiếp trên cổng 443 của máy ảo.

---

## 🎨 PHẦN III: TIÊU CHUẨN FORMAT & CODING STYLE BẮT BUỘC

Mọi pull request đều được kiểm tra tự động qua linter. Code không đúng định dạng sẽ bị CI từ chối:

### 1. Ngôn ngữ PHP (Backend API & Controllers)
- **Chuẩn phong cách**: **PSR-12** và **PSR-4 Autoloading**.
- **Khai báo kiểu dữ liệu nghiêm ngặt**: Tất cả các file PHP mới phải có cờ `declare(strict_types=1);` ở đầu file.
- **Type Hinting**: Mọi tham số hàm và giá trị trả về bắt buộc phải có Type Hinting rõ ràng (không dùng kiểu mù mờ):
  ```php
  <?php
  declare(strict_types=1);

  namespace PNetLab\Controllers;

  use Psr\Http\Message\ResponseInterface as Response;
  use Psr\Http\Message\ServerRequestInterface as Request;

  final class NodeController
  {
      public function start(Request $request, Response $response, array $args): Response
      {
          // Logic xử lý
      }
  }
  ```
- **Kiểm soát chất lượng tĩnh**: Code mới bắt buộc phải vượt qua **PHPStan Level 8**. Các lỗi tàn dư của mã nguồn cũ được cách ly trong `phpstan-baseline.neon`.

### 2. Ngôn ngữ Python (Daemon, Broker, Netlink, AI MCP)
- **Chuẩn phong cách**: **PEP 8**, kiểm tra tự động bằng `flake8`.
- **Type Annotations**: Bắt buộc gắn Type Hints (hỗ trợ `mypy`):
  ```python
  def verb_node_start(args: dict[str, any]) -> tuple[int, list[str], str]:
      node_id: int = int(args.get("node", 0))
      ...
      return 0, ["Node started"], ""
  ```
- **Xử lý ngoại lệ**: Tuyệt đối không dùng `except Exception: pass`. Mọi ngoại lệ đều phải ghi log có cấu trúc kèm Trace ID hoặc trả về mã lỗi `Reject()`.

### 3. Ngôn ngữ TypeScript / React (Frontend Canvas & Portal)
- **Chuẩn phong cách**: **ESLint** + **Prettier** chuẩn Airbnb/TypeScript-recommended.
- **TypeScript Strict**: Không sử dụng `any` trừ trường hợp bất khả kháng (phải có comment giải thích).
- **CSS / Styling**: Sử dụng Vanilla CSS hoặc CSS Modules có gắn biến tokens (`var(--pnet-primary)`, `var(--pnet-bg)`). Tuyệt đối không hardcode mã màu hex phân mảnh giữa các component.

---

## 🔄 PHẦN IV: QUY TRÌNH LÀM VIỆC HÀNG NGÀY & KỶ LUẬT GIT (TỪ DEV-VM STANDARD)

Kế thừa trực tiếp từ quy chuẩn phát triển máy ảo chuẩn `dev-vm-workflow-standard`:

### 1. Quy trình 3 bước mỗi ngày
1. **Đầu ngày (Sync & Kiểm tra)**:
   - Cập nhật mã nguồn mới nhất: `git switch main && git pull --ff-only origin main`.
   - Tạo nhánh tính năng định danh: `git switch -c feature/be-<ten-task>` hoặc `feature/fe-<ten-task>`.
   - Chạy bộ test tổng kiểm tra trước khi code: `python3 /opt/unetlab/tests/run_all_safety_net.py`.
2. **Trong ngày (TDD Red-Green-Refactor)**:
   - Viết test trước cho chức năng mới (Red).
   - Viết code vừa đủ để test pass (Green).
   - Tối ưu code và chạy linter kiểm tra cú pháp (Refactor).
3. **Cuối ngày (Rebase & Tạo PR)**:
   - Đưa nhánh về đồng bộ với `main`: `git fetch origin && git rebase origin/main`.
   - Đẩy nhánh an toàn: `git push --force-with-lease origin HEAD`.
   - Tạo Pull Request kèm theo checklist minh chứng kết quả test.

### 2. Kỷ luật Bảo vệ Nhánh `main` & Dữ liệu
- **Khóa nhánh `main`**: Cấm push trực tiếp lên `main`.
- **Dual-Approval PR**: Mọi PR phải có ít nhất **2 lượt review**:
  - 1 người cùng mảng duyệt chuyên môn sâu (BE1 ↔ BE2 hoặc FE1 ↔ FE2).
  - 1 người khác mảng duyệt tính tương thích hợp đồng API/UI.
- **Tuyệt đối không commit file nhạy cảm & file nặng**:
  - Cấm commit: `.qcow2`, `.bin`, `*.log`, session tạm, database credentials.
  - Tuân thủ nghiêm ngặt `.gitignore`.

---

## 🛡️ PHẦN V: QUY TRÌNH ROLLBACK & KIỂM TRA TRƯỚC KHI HỦY MÃ NGUỒN

Khi gặp sự cố kỹ thuật hoặc test bị gãy, tuyệt đối không chạy ngay `git reset --hard` hay `git clean -fd`:
1. **Kiểm tra file rác dạng Dry-run**: `git clean -nd`.
2. **Lưu trữ an toàn vào Stash**: `git stash -u -m "backup-truoc-khi-rollback"`.
3. **Chạy lại Bộ Test Tổng Safety Net**: `python3 /opt/unetlab/tests/run_all_safety_net.py`. Nếu 18/18 tests xanh thì môi trường mới được xác nhận an toàn để tiếp tục.
