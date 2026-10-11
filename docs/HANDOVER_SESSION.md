# NHẬT KÝ BÀN GIAO PHIÊN LÀM VIỆC (SESSION HANDOVER & BUSINESS STATE)

> **Thời điểm cập nhật:** 2026-10-08 17:01 (UTC)  
> **Nhánh Git:** `feature/vinhUpdate` (Commit cục bộ: `wip: luu code cuoi ngay`)  
> **Phân hệ phụ trách:** BE1 (Core Backend)  
> **Mục tiêu chiến lược:** Đóng băng hợp đồng kiểm thử an toàn (Safety Net Freeze) trước khi gỡ bỏ `unl_wrapper`.

---

## 1. VỊ TRÍ NGHIỆP VỤ TRONG KẾ HOẠCH TỔNG THỂ (MASTER PLAN)

Theo tài liệu [REFACTOR_MASTER_PLAN.md](file:///opt/unetlab/docs/plan/REFACTOR_MASTER_PLAN.md) và [MASTER_TASK_ASSIGNMENT_PLAN.csv](file:///opt/unetlab/docs/plan/MASTER_TASK_ASSIGNMENT_PLAN.csv):
- **Giai đoạn hiện tại:** Sprint 1 / Tuần 1 - **TẦNG 0: BẢO VỆ & HỢP ĐỒNG (Hard Prerequisite)**.
- **Nguyên tắc bất biến:** *"Safety Net TRƯỚC Rebroker"* — Tuyệt đối không sửa mã nguồn C của `unl_wrapper` hoặc chuyển logic sang Python trước khi có bộ lưới kiểm thử tự động (Safety Net Test) đạt 100% tỷ lệ vượt qua.

### Bảng trạng thái Tasks phụ trách:

| Task ID | Phân hệ | Mức ưu tiên | Trạng thái | Mô tả chi tiết kỹ thuật |
| :--- | :--- | :--- | :--- | :--- |
| **TASK-001** | Core Backend (BE1) | P0 (Bắt buộc) | **HOÀN THÀNH (100%)** | Xây dựng `BrokerSocketClient` kết nối Unix Domain Socket `/run/pnetlab/broker.sock`, đóng băng schema chuẩn `{'ok': bool, 'rc': int, 'out': list, 'err': str}`. |
| **TASK-002** | Core Backend (BE1) | P0 (Bắt buộc) | **HOÀN THÀNH (100%)** | Kiểm thử toàn diện 20 kịch bản bao phủ: Platform, System UUID, CPU Policy, Plugin List, Legacy Wrapper actions (`platform`, `ksmon`, `ksmoff`, `cpulimiton`, `cpulimitoff`, `fixpermissions`), Input validation, Path Traversal, Concurrency & Latency SLA. |
| **TASK-009** | Core Backend (BE1) | P0 (Bắt buộc) | **CHƯA BẮT ĐẦU** *(Kế hoạch ngày mai)* | Rebroker Đợt 1: Chuyển 8 switch cases từ `unl_wrapper` sang hàm Python thuần trong `scripts/pnetlab-brokerd.py` và `scripts/core/system_ops.py`. |
| **TASK-0010** | Core Backend (BE1) | P0 (Bắt buộc) | **CHƯA BẮT ĐẦU** | Viết Safety Net Test cho REST API (7 test cases cho session/cookie/token). |

---

## 2. KẾT QUẢ ĐÃ ĐẠT ĐƯỢC TRONG PHIÊN LÀM VIỆC

1. **Bộ Test Tự Động Safety Net Hoàn Thiện**:
   - Tệp kiểm thử: [test_broker_socket.py](file:///opt/unetlab/tests/safety_net/test_broker_socket.py)
   - Kết quả: **20/20 Test Cases PASS (Tỷ lệ 100%)** trong thời gian thực thi siêu tốc: **~0.19 giây**.
   - Chi tiết 5 nhóm kịch bản:
     - **Nhóm 1 (Core Liveness & Discovery):** SC-01 đến SC-06 (Socket file, ping-pong, platform, uuid, cpu policy, plugin discovery).
     - **Nhóm 2 (Legacy Emulation):** SC-07 đến SC-10 (wrapper action, ksm toggle, cpulimit toggle, fixpermissions).
     - **Nhóm 3 (Negative & Input Validation):** SC-11 đến SC-16 (unknown verb rc=254, invalid action, invalid args, path traversal block `../`).
     - **Nhóm 4 (Protocol Robustness):** SC-17, SC-18 (malformed JSON, empty lines).
     - **Nhóm 5 (Concurrency & Latency):** SC-19 (20 luồng worker đồng thời không deadlock), SC-20 (Ping SLA < 50ms, thực tế < 2ms).

2. **Gia cố kỹ thuật giải quyết trong phiên (Key Fix)**:
   - **Vấn đề phát hiện:** Khi 20 luồng đồng thời gọi `connect()` vào Unix Domain Socket `/run/pnetlab/broker.sock`, tiến trình `pnetlab-brokerd.py` sử dụng `ThreadingUnixStreamServer` với hàng đợi lắng nghe mặc định (`request_queue_size = 5`), dẫn đến các worker phía sau bị `BlockingIOError: [Errno 11] Resource temporarily unavailable`.
   - **Giải pháp:** Đã bổ sung cơ chế Retry Loop thông minh có backoff (5ms) và timeout trong `BrokerSocketClient.call_raw()`. Kết quả: cả 20 worker hoàn thành tức thì mà không gặp lỗi nghẽn.

3. **Tài liệu Báo cáo Nghiệp vụ DOCX**:
   - Tệp mã nguồn sinh báo cáo: [create_report_docx.py](file:///opt/unetlab/docs/create_report_docx.py)
   - Tệp báo cáo chính thức: [docs/BAO_CAO_BO_TEST_SOCKET_BROKER_SAFETY_NET.docx](file:///opt/unetlab/docs/BAO_CAO_BO_TEST_SOCKET_BROKER_SAFETY_NET.docx) (đã đồng bộ bản copy tại thư mục gốc [BAO_CAO_BO_TEST_SOCKET_BROKER_SAFETY_NET.docx](file:///opt/unetlab/BAO_CAO_BO_TEST_SOCKET_BROKER_SAFETY_NET.docx)).

---

## 3. CHECKLIST CÔNG VIỆC TIẾP TỤC NGÀY HÔM SAU

Vào ca làm việc tiếp theo, lập trình viên thực hiện theo thứ tự:

- [ ] **Bước 1: Chạy kiểm tra môi trường ban đầu (30 giây)**:
  ```bash
  python3 /opt/unetlab/tests/safety_net/test_broker_socket.py
  ```
  *Kỳ vọng: Toàn bộ 20 bài test phải ra kết quả `OK`.*

- [ ] **Bước 2: Bắt tay vào TASK-009 (Rebroker Đợt 1)**:
  - Mở tệp [scripts/pnetlab-brokerd.py](file:///opt/unetlab/scripts/pnetlab-brokerd.py) và [scripts/core/system_ops.py](file:///opt/unetlab/scripts/core/system_ops.py).
  - Tách các logic đang gọi shell sang Python native:
    1. Sửa quyền thư mục `fixpermissions` (`os.chmod`, `os.chown`).
    2. Đọc thông tin phần cứng `platform` (`/proc/cpuinfo`, `/sys/devices/virtual/dmi/id/product_name`).
    3. Điều khiển KSM `ksmon`/`ksmoff` (ghi trực tiếp vào `/sys/kernel/mm/ksm/run`).
    4. Điều khiển CPU Limit `cpulimiton`/`cpulimitoff`.

- [ ] **Bước 3: Chạy lại Safety Net để kiểm chứng tính toàn vẹn (Zero Regression)**:
  ```bash
  python3 /opt/unetlab/tests/safety_net/test_broker_socket.py
  ```

---

## 4. CÁC ĐƯỜNG DẪN QUAN TRỌNG CẦN NHỚ

- Mã nguồn bộ test: `/opt/unetlab/tests/safety_net/test_broker_socket.py`
- Daemon socket broker: `/opt/unetlab/scripts/pnetlab-brokerd.py`
- Socket endpoint: `/run/pnetlab/broker.sock`
- Báo cáo Word nghiệp vụ: `/opt/unetlab/docs/BAO_CAO_BO_TEST_SOCKET_BROKER_SAFETY_NET.docx`
- Kế hoạch tổng thể 8 tuần: `/opt/unetlab/docs/plan/REFACTOR_MASTER_PLAN.md`
- Phân công nhiệm vụ chi tiết: `/opt/unetlab/docs/plan/MASTER_TASK_ASSIGNMENT_PLAN.csv`
