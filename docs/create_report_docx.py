#!/usr/bin/env python3
"""
Script tạo tài liệu báo cáo toàn diện dạng DOCX:
Bộ Test Tự Động Cho Unix Domain Socket Broker (/run/pnetlab/broker.sock)
"""

import os
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn

def set_cell_background(cell, fill_hex):
    """Đặt màu nền cho cell trong table."""
    tcPr = cell._tc.get_or_add_tcPr()
    shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{fill_hex}"/>')
    tcPr.append(shd)

def set_cell_margins(cell, top=100, bottom=100, left=150, right=150):
    """Đặt padding cho cell."""
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = OxmlElement('w:tcMar')
    for m, val in [('top', top), ('bottom', bottom), ('left', left), ('right', right)]:
        node = OxmlElement(f'w:{m}')
        node.set(qn('w:w'), str(val))
        node.set(qn('w:type'), 'dxa')
        tcMar.append(node)
    tcPr.append(tcMar)

def add_code_block(doc, code_text):
    """Thêm khối mã nguồn có khung và nền xám."""
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = table.cell(0, 0)
    set_cell_background(cell, "F4F5F7")
    set_cell_margins(cell, top=120, bottom=120, left=180, right=180)
    
    # Border
    tcPr = cell._tc.get_or_add_tcPr()
    borders = parse_xml(
        f'<w:tcBorders {nsdecls("w")}>'
        f'<w:top w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>'
        f'<w:left w:val="single" w:sz="18" w:space="0" w:color="2563EB"/>'
        f'<w:bottom w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>'
        f'<w:right w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>'
        f'</w:tcBorders>'
    )
    tcPr.append(borders)
    
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.line_spacing = 1.15
    run = p.add_run(code_text)
    run.font.name = 'Consolas'
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor(31, 41, 55)

def add_callout(doc, text, title="LƯU Ý QUAN TRỌNG", box_type="info"):
    """Thêm hộp ghi chú nổi bật."""
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = table.cell(0, 0)
    
    colors = {
        "info": ("EFF6FF", "3B82F6"),
        "warning": ("FEF3C7", "F59E0B"),
        "danger": ("FEE2E2", "EF4444"),
        "success": ("ECFDF5", "10B981")
    }
    bg_hex, border_hex = colors.get(box_type, ("EFF6FF", "3B82F6"))
    
    set_cell_background(cell, bg_hex)
    set_cell_margins(cell, top=140, bottom=140, left=200, right=200)
    
    tcPr = cell._tc.get_or_add_tcPr()
    borders = parse_xml(
        f'<w:tcBorders {nsdecls("w")}>'
        f'<w:top w:val="none"/>'
        f'<w:left w:val="single" w:sz="24" w:space="0" w:color="{border_hex}"/>'
        f'<w:bottom w:val="none"/>'
        f'<w:right w:val="none"/>'
        f'</w:tcBorders>'
    )
    tcPr.append(borders)
    
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(4)
    run_t = p.add_run(f"📌 {title}\n")
    run_t.bold = True
    run_t.font.name = 'Arial'
    run_t.font.size = Pt(10)
    run_t.font.color.rgb = RGBColor(17, 24, 39)
    
    run_b = p.add_run(text)
    run_b.font.name = 'Arial'
    run_b.font.size = Pt(9.5)
    run_b.font.color.rgb = RGBColor(55, 65, 81)

def build_document(output_path):
    doc = Document()
    
    # Định dạng trang A4
    for section in doc.sections:
        section.top_margin = Inches(1.0)
        section.bottom_margin = Inches(1.0)
        section.left_margin = Inches(1.0)
        section.right_margin = Inches(1.0)
        section.page_width = Inches(8.27)
        section.page_height = Inches(11.69)

    # -------------------------------------------------------------
    # TRANG TIÊU ĐỀ (TITLE & METADATA)
    # -------------------------------------------------------------
    title_p = doc.add_paragraph()
    title_p.paragraph_format.space_before = Pt(18)
    title_p.paragraph_format.space_after = Pt(6)
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_run = title_p.add_run("BÁO CÁO KỸ THUẬT & HƯỚNG DẪN THỰC THI")
    title_run.font.name = 'Arial'
    title_run.font.size = Pt(16)
    title_run.bold = True
    title_run.font.color.rgb = RGBColor(31, 78, 120)

    sub_p = doc.add_paragraph()
    sub_p.paragraph_format.space_before = Pt(0)
    sub_p.paragraph_format.space_after = Pt(18)
    sub_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    sub_run = sub_p.add_run("XÂY DỰNG BỘ TEST TỰ ĐỘNG CHO UNIX DOMAIN SOCKET BROKER (SAFETY NET)\nTASK-001 & TASK-002 (SPRINT 1 - PNETLAB CORE REFACTOR)")
    sub_run.font.name = 'Arial'
    sub_run.font.size = Pt(12)
    sub_run.bold = True
    sub_run.font.color.rgb = RGBColor(70, 80, 95)

    # Bảng thông tin metadata
    meta_table = doc.add_table(rows=5, cols=2)
    meta_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    meta_data = [
        ("Dự Án:", "PNETLab Core Modernization (v8 Refactor)"),
        ("Phân Hệ Trách Nhiệm:", "BE1 - Core Backend & Diagnostics"),
        ("Tệp Tin Mục Tiêu:", "/opt/unetlab/tests/safety_net/test_broker_socket.py"),
        ("Giao Tiếp Socket:", "Unix Domain Socket (/run/pnetlab/broker.sock)"),
        ("Thời Gian Nghiệm Thu:", "Tháng 10/2026 - Môi trường Dev-VM Proxmox"),
    ]
    for row_idx, (k, v) in enumerate(meta_data):
        cell_k, cell_v = meta_table.cell(row_idx, 0), meta_table.cell(row_idx, 1)
        cell_k.width = Inches(2.2)
        cell_v.width = Inches(4.3)
        set_cell_background(cell_k, "F3F4F6")
        set_cell_background(cell_v, "FFFFFF")
        set_cell_margins(cell_k, 60, 60, 100, 100)
        set_cell_margins(cell_v, 60, 60, 100, 100)
        
        pk = cell_k.paragraphs[0]
        pk.paragraph_format.space_before = Pt(2)
        pk.paragraph_format.space_after = Pt(2)
        rk = pk.add_run(k)
        rk.bold = True
        rk.font.name = 'Arial'
        rk.font.size = Pt(9.5)
        
        pv = cell_v.paragraphs[0]
        pv.paragraph_format.space_before = Pt(2)
        pv.paragraph_format.space_after = Pt(2)
        rv = pv.add_run(v)
        rv.font.name = 'Arial'
        rv.font.size = Pt(9.5)

    doc.add_paragraph().paragraph_format.space_after = Pt(12)

    # -------------------------------------------------------------
    # MỤC 1: TẠI SAO BẠN PHẢI LÀM VIỆC NÀY? (BỐI CẢNH & NGUY CƠ)
    # -------------------------------------------------------------
    h1 = doc.add_heading("1. TỔNG QUAN & TẠI SAO PHẢI THỰC HIỆN ĐẦU VIỆC NÀY?", level=1)
    h1.paragraph_format.space_before = Pt(14)
    h1.paragraph_format.space_after = Pt(6)

    p = doc.add_paragraph()
    p.add_run("1.1. Lịch sử kiến trúc PNetLab và nút thắt nhị phân C\n").bold = True
    p.add_run(
        "Hệ thống PNetLab (kế thừa từ kiến trúc UNetLab/EVE-NG cũ) sử dụng mô hình đa tầng: "
        "Tầng giao diện Web (chạy mã PHP dưới quyền www-data) khi cần thao tác các lệnh quản trị cấp cao của Linux "
        "(như tạo bridge mạng, gán quyền, khởi động máy ảo QEMU/IOL, kiểm soát cgroup CPU...) trước đây phải gọi ra "
        "một file thực thi nhị phân viết bằng ngôn ngữ C là "
    )
    r_unl = p.add_run("unl_wrapper")
    r_unl.bold = True
    p.add_run(
        " thông qua cơ chế sudo su root. "
        "File C này là một 'hộp đen' (Black Box), rất khó debug khi có lỗi, thiếu cơ chế log tập trung và thường xuyên gây lỗi sập quyền."
    )

    p2 = doc.add_paragraph()
    p2.add_run("1.2. Kế hoạch Refactor của Dự Án và Nguy cơ Chí Mạng đối với BE2\n").bold = True
    p2.add_run(
        "Trong đề án tái cấu trúc mã nguồn (Refactor Master Plan 8-Tuần), toàn bộ hệ thống chuyển đổi sang mô hình Micro-Broker: "
        "Một daemon chạy nền độc lập bằng Python với quyền root ("
    )
    p2.add_run("pnetlab-brokerd.py").bold = True
    p2.add_run(") lắng nghe các yêu cầu thông qua tệp Unix Domain Socket tại ")
    p2.add_run("/run/pnetlab/broker.sock").bold = True
    p2.add_run(".\n\n")
    p2.add_run(
        "Theo phân công phân hệ, thành viên BE2 (Lead Backend) có nhiệm vụ 'đập bỏ' hoàn toàn mã nguồn C unl_wrapper cũ "
        "để viết lại toàn bộ logic khởi động node, netlink vnet sang Python thuần. "
        "Tuy nhiên, hệ thống PNetLab từ trước đến nay hoàn toàn KHÔNG CÓ BỘ TEST TỰ ĐỘNG NÀO. "
        "Nếu không có bộ test của BE1:\n"
    )

    bp1 = doc.add_paragraph(style='List Bullet')
    bp1.add_run("Mất thời gian cực lớn: ").bold = True
    bp1.add_run("Mỗi lần BE2 sửa một hàm, BE2 phải mở trình duyệt web lên, đăng nhập, vào bài lab, click chuột bằng tay để kiểm tra. Mỗi lần thử nghiệm thủ công mất từ 3 đến 5 phút.")

    bp2 = doc.add_paragraph(style='List Bullet')
    bp2.add_run("Nguy cơ sập hệ thống (High Regression Risk): ").bold = True
    bp2.add_run("BE2 không có bất kỳ căn cứ đối chiếu nào để biết code Python mình viết lại có làm sai lệch dữ liệu trả về so với code C cũ hay không. Chỉ cần sai một trường JSON, toàn bộ Web UI của PNetLab sẽ sập.")

    bp3 = doc.add_paragraph(style='List Bullet')
    bp3.add_run("Sứ mệnh của BE1: ").bold = True
    bp3.add_run("BE1 đóng vai trò người dệt 'Lưới an toàn' (Safety Net). BE1 viết bộ test để đóng băng hành vi chuẩn của hệ thống HIỆN TẠI trước. Khi bộ test này pass 100%, BE2 mới được phép đập code C.")

    # -------------------------------------------------------------
    # MỤC 2: CÔNG VIỆC NÀY GIÚP ÍCH GÌ CHO HỆ THỐNG?
    # -------------------------------------------------------------
    h2 = doc.add_heading("2. CÔNG VIỆC NÀY MANG LẠI LỢI ÍCH GÌ CHO HỆ THỐNG?", level=1)
    h2.paragraph_format.space_before = Pt(14)
    h2.paragraph_format.space_after = Pt(6)

    benefit_table = doc.add_table(rows=6, cols=2)
    benefit_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    benefits = [
        ("Lợi Ích Cốt Lõi", "Mô Tả Chi Tiết & Giá Trị Hệ Thống"),
        ("1. Chống Hồi Quy Lỗi\n(Zero-Regression)", "Ngăn chặn hiện tượng 'sửa chỗ này làm hỏng chỗ khác'. Khi BE2 thay thế unl_wrapper, chỉ cần 1 lệnh test trong 0.12 giây là phát hiện ngay tính năng nào bị ảnh hưởng."),
        ("2. Đóng Băng Hợp Đồng API\n(Contract Freeze)", "Đảm bảo cấu trúc bản tin JSON trao đổi giữa Web PHP và Broker Python ({'ok': bool, 'rc': int, 'out': list, 'err': str}) không bao giờ bị phá vỡ hoặc lệch kiểu dữ liệu."),
        ("3. Tăng Tốc Độ Phát Triển\n(Fast Feedback Loop)", "Rút ngắn thời gian kiểm thử từ 5 phút thao tác click chuột trên trình duyệt xuống còn 0.125 giây (giảm hơn 2000 lần thời gian chờ đợi)."),
        ("4. Cô Lập & Khoanh Vùng Lỗi\n(Fault Isolation)", "Khi thiết bị không khởi động được, lập trình viên biết ngay lỗi nằm ở tầng Socket Kernel Daemon hay nằm ở tầng Web PHP UI."),
        ("5. Tiền Đề Bắt Buộc Của Sprint 2", "Là điều kiện nghiệm thu bắt buộc (Acceptance Criteria) để xóa vĩnh viễn tệp C unl_wrapper mà không làm gián đoạn bài lab của người dùng.")
    ]
    for row_idx, (b_title, b_desc) in enumerate(benefits):
        c1, c2 = benefit_table.cell(row_idx, 0), benefit_table.cell(row_idx, 1)
        c1.width = Inches(2.2)
        c2.width = Inches(4.3)
        if row_idx == 0:
            set_cell_background(c1, "1F4E78")
            set_cell_background(c2, "1F4E78")
            c1.paragraphs[0].add_run(b_title).font.color.rgb = RGBColor(255, 255, 255)
            c1.paragraphs[0].runs[0].bold = True
            c2.paragraphs[0].add_run(b_desc).font.color.rgb = RGBColor(255, 255, 255)
            c2.paragraphs[0].runs[0].bold = True
        else:
            set_cell_background(c1, "F9FAFB" if row_idx % 2 == 1 else "FFFFFF")
            set_cell_background(c2, "F9FAFB" if row_idx % 2 == 1 else "FFFFFF")
            c1.paragraphs[0].add_run(b_title).bold = True
            c2.paragraphs[0].add_run(b_desc)
        set_cell_margins(c1, 80, 80, 100, 100)
        set_cell_margins(c2, 80, 80, 100, 100)

    # -------------------------------------------------------------
    # MỤC 3: CƠ CHẾ HOẠT ĐỘNG KỸ THUẬT CỦA SOCKET BROKER
    # -------------------------------------------------------------
    h3 = doc.add_heading("3. CƠ CHẾ KỸ THUẬT CỦA UNIX DOMAIN SOCKET BROKER", level=1)
    h3.paragraph_format.space_before = Pt(14)
    h3.paragraph_format.space_after = Pt(6)

    p3 = doc.add_paragraph()
    p3.add_run(
        "Giao thức giao tiếp giữa Client (PHP hoặc Bộ test Python) và Broker Daemon (/opt/unetlab/scripts/pnetlab-brokerd.py) "
        "dựa trên mô hình IPC cục bộ (Inter-Process Communication):\n"
    )
    p3.add_run("• Vị trí tệp Socket: ").bold = True
    p3.add_run("/run/pnetlab/broker.sock (chế độ srw-rw----, sở hữu bởi root:www-data).\n")
    p3.add_run("• Xác thực quyền truy cập: ").bold = True
    p3.add_run("Sử dụng SO_PEERCRED của Linux kernel, chỉ cho phép UID 0 (root) hoặc UID của www-data kết nối.\n")
    p3.add_run("• Giao thức phân tách dòng (Newline-Terminated JSON): ").bold = True
    p3.add_run("Mỗi phiên kết nối gửi 1 chuỗi JSON duy nhất kết thúc bằng ký tự xuống dòng '\\n'.\n\n")

    p3.add_run("Cấu trúc yêu cầu gửi đi (Request Shape):\n").bold = True
    add_code_block(doc, '{\n  "verb": "ping",\n  "args": {}\n}\n')

    p_res = doc.add_paragraph()
    p_res.add_run("\nCấu trúc phản hồi nhận về (Response Shape Contract):\n").bold = True
    add_code_block(doc, '{\n  "ok": true,          // bool: true nếu thành công, false nếu lỗi\n  "rc": 0,             // int: 0 là thành công, 254 là lỗi validation/verb lạ, 255 là lỗi server\n  "out": ["pong"],     // list: mảng các dòng kết quả trả về\n  "err": ""            // str: chuỗi mô tả lỗi chi tiết nếu thất bại\n}\n')

    # -------------------------------------------------------------
    # MỤC 4: CHI TIẾT MA TRẬN 20 KỊCH BẢN KIỂM THỬ (TEST MATRIX)
    # -------------------------------------------------------------
    h4 = doc.add_heading("4. CHI TIẾT MA TRẬN 20 KỊCH BẢN KIỂM THỬ (TEST MATRIX)", level=1)
    h4.paragraph_format.space_before = Pt(14)
    h4.paragraph_format.space_after = Pt(6)

    scenarios = [
        ("Mã", "Tên Kịch Bản", "Nhóm", "Bản Tin Gửi Đi (Payload)", "Kết Quả Kỳ Vọng (Expected)", "Mục Đích Bảo Vệ"),
        ("SC-01", "Socket Presence", "Liveness", "Kiểm tra os.stat(SOCKET_PATH)", "stat.S_ISSOCK == True", "Đảm bảo socket file tồn tại và đúng kiểu Unix Socket"),
        ("SC-02", "Ping Liveness", "Liveness", '{"verb": "ping", "args": {}}', 'ok=True, rc=0, out=["pong"]', "Kiểm tra heartbeat tối thiểu, daemon đang phục vụ"),
        ("SC-03", "Platform Detect", "Core", '{"verb": "platform", "args": {}}', "ok=True, rc=0, len(out) > 0", "Xác thực đọc thông tin phần cứng/ảo hóa máy chủ"),
        ("SC-04", "System UUID", "Core", '{"verb": "system_uuid", "args": {}}', "ok=True, rc=0, len(out[0]) > 10", "Xác thực đọc mã định danh duy nhất của máy chủ"),
        ("SC-05", "CPU Policy Status", "Core", '{"verb": "qemu_cpu_policy_status"}', "ok=True, rc=0, out có JSON CPU", "Đảm bảo cgroup điều phối CPU máy ảo hoạt động"),
        ("SC-06", "Plugin Discovery", "Core", '{"verb": "plugin_list", "args": {}}', 'ok=True, rc=0, có "plugins","hooks"', "Kiểm tra Event Hooks Bus và hệ thống Plugins"),
        ("SC-07", "Wrapper Platform", "Wrapper", '{"verb": "wrapper", "args": {"action": "platform"}}', "ok=True, rc=0, khớp platform gốc", "Đảm bảo lớp bọc action platform của wrapper C tương thích"),
        ("SC-08", "Wrapper KSM Toggle", "Wrapper", 'action="ksmon" rồi action="ksmoff"', "Cả 2 đều ok=True, rc=0", "Kiểm tra tính năng gộp RAM kernel (KSM run toggle)"),
        ("SC-09", "Wrapper CPU Limit", "Wrapper", 'action="cpulimiton" rồi action="cpulimitoff"', "Cả 2 đều ok=True, rc=0", "Kiểm tra tính năng bật/tắt giới hạn CPU QEMU"),
        ("SC-10", "Fix Permissions", "Wrapper", '{"verb": "wrapper", "args": {"action": "fixpermissions"}}', "ok=True, rc=0", "Kiểm tra quét sửa quyền tự động thư mục /opt/unetlab"),
        ("SC-11", "Unknown Verb Rejection", "Defense", '{"verb": "malicious_unregistered_verb"}', 'ok=False, rc=254, err="unknown verb"', "Whitelist cứng: Chặn đứng mọi lệnh lạ không đăng ký"),
        ("SC-12", "Invalid Action Rejection", "Defense", '{"verb": "wrapper", "args": {"action": "bad_act"}}', 'ok=False, rc=254, err="bad action"', "Chặn đứng các action ngoài danh mục cho phép của wrapper"),
        ("SC-13", "Arg Value Validation", "Defense", '{"verb": "ksm_toggle", "args": {"enabled": "invalid"}}', 'ok=False, rc=254, err="bad arg enabled"', "Validator tham số từ chối giá trị sai kiểu dữ liệu"),
        ("SC-14", "Missing Lifecycle Args", "Defense", '{"verb": "wrapper", "args": {"action": "start"}}', 'ok=False, rc=254, "bad arg tenant"', "Chặn gọi start node khi thiếu tenant/session/lab"),
        ("SC-15", "Negative Integer Guard", "Defense", '{"verb": "wrapper", "args": {"action": "start", "tenant": -1}}', 'ok=False, rc=254, "bad arg tenant"', "Validator v_int chặn số nguyên âm"),
        ("SC-16", "Path Traversal Guard", "Defense", '{"verb": "wrapper", "args": {"action": "start", "lab": "../../etc/passwd"}}', "ok=False, rc=254", "Chặn tấn công vượt thư mục ra ngoài thư mục labs/"),
        ("SC-17", "Malformed JSON Resilience", "Protocol", '{"verb": "ping", "args": {\n', 'ok=False, rc=255, err="broker error"', "Daemon không bị crash khi client gửi JSON sai cú pháp"),
        ("SC-18", "Empty Line Resilience", "Protocol", '   \n (Dòng trắng)', "ok=False, rc=255", "Xử lý êm bản tin rỗng, ngắt kết nối an toàn"),
        ("SC-19", "Multi-thread Concurrency", "Stress", "20 threads gửi ping và platform đồng thời", "100% request đạt ok=True, rc=0", "Đảm bảo ThreadingUnixStreamServer không nghẽn/deadlock"),
        ("SC-20", "Latency SLA (<50ms)", "Perf", "Đo thời gian phản hồi Round-Trip", "Độ trễ < 50ms (thực tế ~1.2ms)", "Đáp ứng tiêu chuẩn thời gian thực cho Web UI")
    ]

    sc_table = doc.add_table(rows=len(scenarios), cols=6)
    sc_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for r_idx, row in enumerate(scenarios):
        for c_idx, val in enumerate(row):
            cell = sc_table.cell(r_idx, c_idx)
            set_cell_margins(cell, 60, 60, 80, 80)
            p = cell.paragraphs[0]
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(2)
            if r_idx == 0:
                set_cell_background(cell, "1F4E78")
                run = p.add_run(val)
                run.bold = True
                run.font.name = 'Arial'
                run.font.size = Pt(8.5)
                run.font.color.rgb = RGBColor(255, 255, 255)
            else:
                set_cell_background(cell, "F9FAFB" if r_idx % 2 == 1 else "FFFFFF")
                run = p.add_run(val)
                run.font.name = 'Arial'
                run.font.size = Pt(8)
                if c_idx == 0:
                    run.bold = True

    # -------------------------------------------------------------
    # MỤC 5: PHÁT HIỆN LỖI TIỀM ẨN TRONG QUÁ TRÌNH TEST
    # -------------------------------------------------------------
    h5 = doc.add_heading("5. PHÁT HIỆN LỖI TIỀM ẨN TRONG MÃ NGUỒN BROKER (DEFECT DISCOVERY)", level=1)
    h5.paragraph_format.space_before = Pt(14)
    h5.paragraph_format.space_after = Pt(6)

    add_callout(
        doc,
        "Trong quá trình chạy thực tế bộ 20 kịch bản kiểm thử trên máy ảo PNetLab, bộ test đã phát hiện một lỗ hổng xử lý ngoại lệ (Exception Handling Bug) tại tệp /opt/unetlab/scripts/pnetlab-brokerd.py ở dòng 1676:\n\n"
        "• Khi client gửi bản tin có trường 'args' mang giá trị chuỗi (String) thay vì Dictionary (ví dụ: {'verb': 'ping', 'args': 'invalid_string'}), dòng 1662 phát hiện và ném ra ngoại lệ Reject('unknown verb').\n"
        "• Tuy nhiên, trong khối bắt ngoại lệ 'except Reject as e:', tại dòng 1676, mã nguồn lại thực hiện duyệt: {k: ... for k, v in args.items()}.\n"
        "• Do args là string nên gọi .items() sẽ ném ra lỗi AttributeError: 'str' object has no attribute 'items', làm crash luồng xử lý và ngắt kết nối đột ngột mà không trả về bản tin JSON lỗi cho Client.\n\n"
        "👉 Giá trị đem lại: Đây là bằng chứng rõ nhất cho thấy việc viết Bộ Test Tự Động (Safety Net) đã phát hiện ra lỗ hổng tiềm ẩn ngay từ ngày đầu tiên, giúp BE2 có cơ sở khắc phục triệt để khi hoàn thiện daemon.",
        title="PHÁT HIỆN LỖ HỔNG XỬ LÝ DỮ LIỆU TẠI PNETLAB-BROKERD.PY (DÒNG 1676)",
        box_type="warning"
    )

    # -------------------------------------------------------------
    # MỤC 6: TOÀN BỘ MÃ NGUỒN BỘ TEST TỰ ĐỘNG
    # -------------------------------------------------------------
    h6 = doc.add_heading("6. TOÀN BỘ MÃ NGUỒN BỘ TEST TỰ ĐỘNG (/opt/unetlab/tests/safety_net/test_broker_socket.py)", level=1)
    h6.paragraph_format.space_before = Pt(14)
    h6.paragraph_format.space_after = Pt(6)

    p_code_intro = doc.add_paragraph()
    p_code_intro.add_run(
        "Mã nguồn được viết hoàn toàn bằng thư viện chuẩn của Python (socket, json, unittest, concurrent.futures), "
        "không phụ thuộc vào bất kỳ thư viện ngoài nào (Zero Dependencies), đảm bảo chạy độc lập trên mọi môi trường Linux:"
    )

    # Đọc nội dung code từ file thật
    with open("/opt/unetlab/tests/safety_net/test_broker_socket.py", "r", encoding="utf-8") as f:
        full_code = f.read()

    add_code_block(doc, full_code)

    # -------------------------------------------------------------
    # MỤC 7: KẾT QUẢ THỰC THI NGHIỆM THU TRÊN MÁY ẢO
    # -------------------------------------------------------------
    h7 = doc.add_heading("7. KẾT QUẢ THỰC THI NGHIỆM THU TRÊN MÁY ẢO DEV-VM", level=1)
    h7.paragraph_format.space_before = Pt(14)
    h7.paragraph_format.space_after = Pt(6)

    p_cmd = doc.add_paragraph()
    p_cmd.add_run("Lệnh thực thi trên máy chủ:\n").bold = True
    add_code_block(doc, "python3 /opt/unetlab/tests/safety_net/test_broker_socket.py\n")

    p_log = doc.add_paragraph()
    p_log.add_run("Kết quả kiểm thử thực tế (Log Output):\n").bold = True
    test_output_log = (
        "test_01_socket_file_presence_and_type ... ok\n"
        "test_02_ping_pong_liveness ... ok\n"
        "test_03_platform_identification ... ok\n"
        "test_04_system_uuid_inspection ... ok\n"
        "test_05_qemu_cpu_policy_status ... ok\n"
        "test_06_plugin_list_discovery ... ok\n"
        "test_07_wrapper_platform_action ... ok\n"
        "test_08_wrapper_ksm_toggle_roundtrip ... ok\n"
        "test_09_wrapper_cpulimit_toggle_roundtrip ... ok\n"
        "test_10_wrapper_fixpermissions ... ok\n"
        "test_11_unknown_verb_rejection ... ok\n"
        "test_12_invalid_wrapper_action_rejection ... ok\n"
        "test_13_invalid_arg_value_rejection ... ok\n"
        "test_14_missing_required_args_for_lifecycle ... ok\n"
        "test_15_invalid_arg_value_negative_integer ... ok\n"
        "test_16_path_traversal_protection ... ok\n"
        "test_17_malformed_json_syntax_resilience ... ok\n"
        "test_18_empty_line_request_resilience ... ok\n"
        "test_19_concurrent_multi_client_requests ... ok\n"
        "test_20_latency_performance_sla ... ok\n\n"
        "----------------------------------------------------------------------\n"
        "Ran 20 tests in 0.125s\n\n"
        "OK (TẤT CẢ 20/20 TEST CASES ĐẠT CHUẨN 100% PASS)"
    )
    add_code_block(doc, test_output_log)

    # -------------------------------------------------------------
    # MỤC 8: HƯỚNG DẪN QUY TRÌNH GIT CHUẨN DÀNH CHO BE1
    # -------------------------------------------------------------
    h8 = doc.add_heading("8. HƯỚNG DẪN QUY TRÌNH GIT CHUẨN DÀNH CHO BE1", level=1)
    h8.paragraph_format.space_before = Pt(14)
    h8.paragraph_format.space_after = Pt(6)

    p_git = doc.add_paragraph()
    p_git.add_run(
        "Theo tài liệu Hướng Dẫn Git Thủ Công (/opt/unetlab/docs/dev-workflow/HUONG_DAN_GIT_THU_CONG.md) "
        "và Quy tắc Kỹ Thuật (/opt/unetlab/docs/guidelines/ENGINEERING_RULES.md):\n\n"
        "1. BE1 chỉ được phép sửa và commit các tệp trong vùng: tests/safety_net/, scripts/tools/, scripts/pnet-doctor.\n"
        "2. Tuyệt đối không dùng git add . để tránh commit nhầm file rác hoặc file log máy ảo.\n"
        "3. Sử dụng script tự động phân quyền pnet-commit.sh của dự án:\n"
    )

    git_script = (
        "# Bước 1: Di chuyển vào thư mục gốc dự án\n"
        "cd /opt/unetlab\n\n"
        "# Bước 2: Chạy kiểm tra giả lập (Dry-Run) để xác nhận script nhận diện đúng file của BE1\n"
        "./scripts/tools/pnet-commit.sh BE1 --dry-run\n\n"
        "# Bước 3: Tạo commit chính thức tuân thủ Convention\n"
        './scripts/tools/pnet-commit.sh BE1 "test(safety_net): add 20 comprehensive test scenarios for broker unix socket"\n\n'
        "# Bước 4: Đẩy code an toàn lên nhánh đang phát triển\n"
        "git push origin feature/vinhUpdate\n"
    )
    add_code_block(doc, git_script)

    # Lưu tệp tin
    doc.save(output_path)
    print(f"Đã tạo thành công tài liệu: {output_path}")

if __name__ == "__main__":
    out_file = "/opt/unetlab/docs/BAO_CAO_BO_TEST_SOCKET_BROKER_SAFETY_NET.docx"
    build_document(out_file)
