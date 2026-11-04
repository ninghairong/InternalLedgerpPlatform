-- 首次启动时额外创建测试库，供 npm test 使用（每次测试前清空重建）
CREATE DATABASE ledger_test OWNER ledger;
