
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
DROP TABLE IF EXISTS `control`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `control` (
  `control_name` varchar(150) NOT NULL,
  `control_value` text,
  PRIMARY KEY (`control_name`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `schema_version`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `schema_version` (
  `version` int NOT NULL,
  `applied_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `description` text,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;
INSERT INTO `schema_version` (`version`, `description`) VALUES
  (1, 'users.user_max_cpu'),
  (2, 'users.user_max_ram'),
  (3, 'users.access_days'),
  (4, 'users.ext_auth'),
  (5, 'node_sessions.node_cpu'),
  (6, 'node_sessions.node_ram'),
  (7, 'node_sessions.node_session_port_2nd'),
  (8, 'node_sessions.node_session_host'),
  (9, 'cluster_hosts'),
  (10, 'cluster_placements'),
  (11, 'activity_log'),
  (12, 'password_resets');
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `activity_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `activity_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `created_at` int unsigned NOT NULL,
  `pod` int DEFAULT NULL,
  `username` varchar(150) NOT NULL,
  `ip` varchar(45) DEFAULT NULL,
  `category` varchar(16) NOT NULL,
  `action` varchar(32) NOT NULL,
  `lab_path` varchar(1024) DEFAULT NULL,
  `lab_name` varchar(255) DEFAULT NULL,
  `node_name` varchar(255) DEFAULT NULL,
  `node_template` varchar(64) DEFAULT NULL,
  `detail` text DEFAULT NULL,
  `session_id` char(64) DEFAULT NULL,
  `duration_seconds` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `activity_category_time` (`category`,`created_at`),
  KEY `activity_session` (`session_id`,`action`,`created_at`),
  KEY `activity_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `password_resets`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `password_resets` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `token_hash` char(64) NOT NULL,
  `pod` int NOT NULL,
  `created_at` int unsigned NOT NULL,
  `expires_at` int unsigned NOT NULL,
  `used_at` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `password_resets_token` (`token_hash`),
  KEY `password_resets_pod` (`pod`,`used_at`),
  KEY `password_resets_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `html5`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `html5` (
  `username` text,
  `pod` int DEFAULT NULL,
  `token` text
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `if_sessions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `if_sessions` (
  `if_session_id` bigint NOT NULL AUTO_INCREMENT,
  `if_session_lab` int DEFAULT NULL,
  `if_session_node` int DEFAULT NULL,
  `if_session_ifid` int DEFAULT NULL,
  `if_session_VlanId` int DEFAULT NULL,
  `if_session_type` varchar(150) DEFAULT NULL,
  `if_session_quality` text,
  `if_session_suspend` int DEFAULT NULL,
  PRIMARY KEY (`if_session_id`),
  KEY `if_session_ifid` (`if_session_ifid`),
  KEY `if_session_type` (`if_session_type`),
  KEY `if_session_VlanId` (`if_session_VlanId`),
  KEY `if_session_suspend` (`if_session_suspend`),
  KEY `if_session_lab` (`if_session_lab`) USING BTREE,
  KEY `if_session_node` (`if_session_node`) USING BTREE,
  CONSTRAINT `if_sessions_ibfk_1` FOREIGN KEY (`if_session_node`) REFERENCES `node_sessions` (`node_session_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `lab_sessions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `lab_sessions` (
  `lab_session_id` int NOT NULL AUTO_INCREMENT,
  `lab_session_lid` varchar(150) DEFAULT NULL,
  `lab_session_pod` int DEFAULT NULL,
  `lab_session_joined` text,
  `lab_session_path` text,
  `lab_session_running` int DEFAULT NULL,
  PRIMARY KEY (`lab_session_id`) USING BTREE,
  KEY `lab_session_lid` (`lab_session_lid`) USING BTREE,
  KEY `lab_session_pod` (`lab_session_pod`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `node_sessions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `node_sessions` (
  `node_session_id` int NOT NULL,
  `node_session_nid` int DEFAULT NULL,
  `node_session_lab` int DEFAULT NULL,
  `node_session_port` int DEFAULT NULL,
  `node_session_type` varchar(150) DEFAULT NULL,
  `node_session_workspace` text,
  `node_session_ram` float DEFAULT NULL,
  `node_session_cpu` float DEFAULT NULL,
  `node_session_hdd` float DEFAULT NULL,
  `node_session_running` int DEFAULT NULL,
  `node_session_pod` int DEFAULT NULL,
  `node_session_iol` int DEFAULT NULL,
  `node_cpu` float DEFAULT '0',
  `node_ram` int DEFAULT '0',
  `node_session_port_2nd` int DEFAULT NULL,
  `node_session_host` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`node_session_id`) USING BTREE,
  UNIQUE KEY `node_session_nid_2` (`node_session_nid`,`node_session_lab`),
  KEY `node_session_lab` (`node_session_lab`),
  KEY `node_session_port` (`node_session_port`),
  KEY `node_session_nid` (`node_session_nid`),
  KEY `node_session_type` (`node_session_type`),
  KEY `node_session_running` (`node_session_running`),
  KEY `node_session_pod` (`node_session_pod`),
  KEY `node_session_iol` (`node_session_iol`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `cluster_hosts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `cluster_hosts` (
  `host_id` tinyint NOT NULL,
  `host_name` varchar(64) NOT NULL,
  `host_ip` varchar(45) NOT NULL,
  `host_status` tinyint NOT NULL DEFAULT '0',
  `host_last_seen` int DEFAULT NULL,
  `host_version` varchar(48) DEFAULT NULL,
  `host_joined` int DEFAULT NULL,
  PRIMARY KEY (`host_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `cluster_placements`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `cluster_placements` (
  `placement_lab`  CHAR(36)  NOT NULL,
  `placement_nid`  INT       NOT NULL,
  `placement_host` TINYINT   NOT NULL DEFAULT 0,
  PRIMARY KEY (`placement_lab`, `placement_nid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `process`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `process` (
  `process_id` varchar(200) NOT NULL,
  `process_dtotal` int DEFAULT NULL,
  `process_dnow` int DEFAULT NULL,
  `process_utotal` int DEFAULT NULL,
  `process_unow` int DEFAULT NULL,
  `process_finish` int DEFAULT NULL,
  PRIMARY KEY (`process_id`),
  KEY `process_dtotal` (`process_dtotal`),
  KEY `process_dnow` (`process_dnow`),
  KEY `process_utotal` (`process_utotal`),
  KEY `process_unow` (`process_unow`),
  KEY `process_finish` (`process_finish`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `process_device`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `process_device` (
  `process_device_id` varchar(150) NOT NULL,
  `process_device_dtotal` int DEFAULT NULL,
  `process_device_dnow` int DEFAULT NULL,
  `process_device_utotal` int DEFAULT NULL,
  `process_device_unow` int DEFAULT NULL,
  `process_device_log` text,
  UNIQUE KEY `process_device_id` (`process_device_id`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user_permission`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_permission` (
  `user_per_id` int NOT NULL AUTO_INCREMENT,
  `user_per_role` int DEFAULT NULL,
  `user_per_name` varchar(150) DEFAULT NULL,
  PRIMARY KEY (`user_per_id`),
  KEY `user_per_role` (`user_per_role`),
  KEY `user_per_name` (`user_per_name`)
) ENGINE=InnoDB AUTO_INCREMENT=251 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user_roles`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_roles` (
  `user_role_id` int NOT NULL AUTO_INCREMENT,
  `user_role_name` varchar(150) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `user_role_workspace` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `user_role_note` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `user_role_ram` float DEFAULT NULL,
  `user_role_cpu` float DEFAULT NULL,
  `user_role_hdd` float DEFAULT NULL,
  PRIMARY KEY (`user_role_id`),
  KEY `user_role_name` (`user_role_name`),
  KEY `user_role_ram` (`user_role_ram`),
  KEY `user_role_cpu` (`user_role_cpu`),
  KEY `user_role_hdd` (`user_role_hdd`)
) ENGINE=InnoDB AUTO_INCREMENT=15 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `pod` int NOT NULL AUTO_INCREMENT,
  `username` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `cookie` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `email` varchar(150) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `expiration` int DEFAULT '-1',
  `name` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `password` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `session` int DEFAULT NULL,
  `ip` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `role` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `folder` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `lab_session` int DEFAULT NULL,
  `html5` tinyint(1) DEFAULT NULL,
  `license` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `online_time` int DEFAULT NULL,
  `note` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `offline` int DEFAULT NULL,
  `active_time` int DEFAULT NULL,
  `expired_time` int DEFAULT NULL,
  `user_status` int DEFAULT '1',
  `user_workspace` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `max_node` int DEFAULT NULL,
  `max_node_lab` int DEFAULT NULL,
  `user_max_cpu` int DEFAULT NULL,
  `user_max_ram` int DEFAULT NULL,
  `access_days` varchar(16) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `ext_auth` varchar(8) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  PRIMARY KEY (`pod`),
  UNIQUE KEY `email` (`email`),
  KEY `online_time` (`online_time`),
  KEY `lab_session` (`lab_session`),
  KEY `offline` (`offline`),
  KEY `active_time` (`active_time`),
  KEY `expired_time` (`expired_time`),
  KEY `user_status` (`user_status`),
  KEY `max_node` (`max_node`),
  KEY `max_node_lab` (`max_node_lab`)
) ENGINE=InnoDB AUTO_INCREMENT=44 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `wiresharks`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `wiresharks` (
  `ws_id` bigint NOT NULL AUTO_INCREMENT,
  `ws_tenant` int DEFAULT NULL,
  `ws_lab` varchar(200) DEFAULT NULL,
  `ws_node` int DEFAULT NULL,
  `ws_if` int DEFAULT NULL,
  `ws_net` int DEFAULT NULL,
  `ws_node_name` varchar(150) DEFAULT NULL,
  `ws_if_name` varchar(150) DEFAULT NULL,
  `ws_dc_name` varchar(150) DEFAULT NULL,
  `ws_port` int DEFAULT NULL,
  `ws_ip` varchar(150) DEFAULT NULL,
  PRIMARY KEY (`ws_id`),
  KEY `ws_ip` (`ws_ip`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;
