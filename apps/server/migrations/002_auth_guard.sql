-- 风控防护状态（决策：学习参考项目的冷却/限流经验）
--
-- 关键依据（参考项目 sports-data-sync-multiplatform 原文）：
--   「佳明对错误密码敏感：输错一次即可能触发风控」
--   「冷却期约数小时到一天」
--   「冷却期内反复尝试会延长封禁」
--   「勿同时登录开发体验版与正式版」（同账号多端并发也触发）
--
-- 因此：识别到风控信号后进入冷却，期间拒绝一切自动登录尝试。

CREATE TABLE IF NOT EXISTS auth_guard (
  platform_id      TEXT NOT NULL,
  account         TEXT NOT NULL,
  cooldown_until  TEXT,
  cooldown_reason TEXT,
  cooldown_kind   TEXT,
  last_login_at   TEXT,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (platform_id, account)
);
