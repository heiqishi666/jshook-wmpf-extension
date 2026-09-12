# 发布检查

- [x] 独立目录仅保留扩展源码、测试、构建入口和必需资产。
- [x] 不包含日志、缓存、node_modules 或本机业务资料。
- [x] README 和 Agent 安装提示不依赖作者电脑目录。
- [x] 独立目录 npm ci / typecheck / test / build 验证（15 项测试通过）。
- [ ] 用户提供 GitHub 空仓库 URL；核对 remote 后获得明确推送授权。
- [ ] 审核后端补丁与第三方素材的公开分发方式。
- [ ] 确定版本、创建 Release；注册表收录另行申请。

不保证仅凭 GitHub URL 可调用 install_extension；该工具需要已配置注册表的条目。未收录时按 README 从仓库安装。
