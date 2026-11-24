-- 补齐 activities.raw_sport_type
--
-- 起因：同步引擎写入时用了这个列，但 001 迁移里没建，
-- 导致真实同步时报 "table activities has no column named raw_sport_type"。
-- 保留原始运动类型很重要 —— 归一化成 SportType 后无法还原平台的原始分类。

ALTER TABLE activities ADD COLUMN raw_sport_type TEXT;
