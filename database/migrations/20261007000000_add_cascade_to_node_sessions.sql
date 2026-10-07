-- ==============================================================================
-- Migration: 20261007000000_add_cascade_to_node_sessions.sql
-- Phân hệ: BE2 (Core Architecture & Database Integrity)
-- Mục đích: Đảm bảo tính toàn vẹn dữ liệu, tự động xóa các node session phụ thuộc
--           khi lab session kết thúc (ON DELETE CASCADE), loại bỏ session mồ côi.
-- ==============================================================================

USE pnetlab_db;

-- 1. Dọn dẹp dữ liệu mồ côi cũ (nếu có) trước khi tạo khóa ngoại
DELETE FROM node_sessions 
WHERE node_session_lab IS NOT NULL 
  AND node_session_lab NOT IN (SELECT lab_session_id FROM lab_sessions);

-- 2. Xóa foreign key cũ nếu đã tồn tại để tránh xung đột
SET @constraint_exists = (
    SELECT COUNT(*) 
    FROM information_schema.table_constraints 
    WHERE table_schema = 'pnetlab_db' 
      AND table_name = 'node_sessions' 
      AND constraint_name = 'fk_node_sessions_lab'
);

SET @drop_fk_query = IF(@constraint_exists > 0, 
    'ALTER TABLE node_sessions DROP FOREIGN KEY fk_node_sessions_lab;', 
    'SELECT 1;'
);
PREPARE stmt FROM @drop_fk_query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. Tạo Foreign Key Constraint với hành vi ON DELETE CASCADE
ALTER TABLE node_sessions
  ADD CONSTRAINT fk_node_sessions_lab
  FOREIGN KEY (node_session_lab)
  REFERENCES lab_sessions(lab_session_id)
  ON DELETE CASCADE;
