-- ==============================================================================
-- Migration: 20261015000000_add_foreign_keys_cascade.sql
-- Phân hệ: BE2 (Core Architecture & Database Integrity - Sprint 2 / TASK-0019)
-- Mục đích: Đảm bảo tính toàn vẹn dữ liệu cho chuỗi session & interface:
--           labs -> lab_sessions -> node_sessions -> if_sessions
--           với cờ ON DELETE CASCADE, triệt tiêu rác bộ nhớ và orphan records.
-- ==============================================================================

USE pnetlab_db;

-- 1. Dọn dẹp dữ liệu mồ côi cũ trước khi thiết lập ràng buộc
DELETE FROM if_sessions 
WHERE if_session_node IS NOT NULL 
  AND if_session_node NOT IN (SELECT node_session_id FROM node_sessions);

DELETE FROM node_sessions 
WHERE node_session_lab IS NOT NULL 
  AND node_session_lab NOT IN (SELECT lab_session_id FROM lab_sessions);

-- 2. Đảm bảo khóa ngoại node_sessions -> lab_sessions
SET @constraint_node_lab = (
    SELECT COUNT(*) 
    FROM information_schema.table_constraints 
    WHERE table_schema = 'pnetlab_db' 
      AND table_name = 'node_sessions' 
      AND constraint_name = 'fk_node_sessions_lab'
);

SET @drop_node_lab_query = IF(@constraint_node_lab > 0, 
    'ALTER TABLE node_sessions DROP FOREIGN KEY fk_node_sessions_lab;', 
    'SELECT 1;'
);
PREPARE stmt_node_lab FROM @drop_node_lab_query;
EXECUTE stmt_node_lab;
DEALLOCATE PREPARE stmt_node_lab;

ALTER TABLE node_sessions
  ADD CONSTRAINT fk_node_sessions_lab
  FOREIGN KEY (node_session_lab)
  REFERENCES lab_sessions(lab_session_id)
  ON DELETE CASCADE;

-- 3. Tạo ràng buộc khóa ngoại if_sessions -> node_sessions
SET @constraint_if_node = (
    SELECT COUNT(*) 
    FROM information_schema.table_constraints 
    WHERE table_schema = 'pnetlab_db' 
      AND table_name = 'if_sessions' 
      AND constraint_name = 'fk_if_sessions_node'
);

SET @drop_if_node_query = IF(@constraint_if_node > 0, 
    'ALTER TABLE if_sessions DROP FOREIGN KEY fk_if_sessions_node;', 
    'SELECT 1;'
);
PREPARE stmt_if_node FROM @drop_if_node_query;
EXECUTE stmt_if_node;
DEALLOCATE PREPARE stmt_if_node;

ALTER TABLE if_sessions
  ADD CONSTRAINT fk_if_sessions_node
  FOREIGN KEY (if_session_node)
  REFERENCES node_sessions(node_session_id)
  ON DELETE CASCADE;
