CREATE DATABASE IF NOT EXISTS fcrp_stream_bot;
USE fcrp_stream_bot;

CREATE TABLE IF NOT EXISTS tracked_users (
    discord_id VARCHAR(30) PRIMARY KEY,
    twitch_username VARCHAR(100) NOT NULL,
    last_stream_id VARCHAR(50) DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS keywords (
    keyword VARCHAR(100) PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS bot_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    level VARCHAR(10) NOT NULL,
    context VARCHAR(50) NOT NULL,
    message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_config (
    config_key VARCHAR(50) PRIMARY KEY,
    config_value TEXT NOT NULL
);

INSERT IGNORE INTO bot_config (config_key, config_value) VALUES ('announcement_channel_id', '');
INSERT IGNORE INTO bot_config (config_key, config_value) VALUES ('allowed_admin_roles', '');
INSERT IGNORE INTO bot_config (config_key, config_value) VALUES ('announcement_ping_role_id', '');
INSERT IGNORE INTO bot_config (config_key, config_value) VALUES ('live_role_id', '');