# 给接收方 Agent

请从 https://github.com/heiqishi666/jshook-wmpf-extension 获取本扩展，并作为 Plugin 安装到我已有的 jshook MCP。先读取 README.md 和 agent-guide.md，核对本机 jshook 版本和配置；当前 0.3.5 需使用 MCP_TOOL_PROFILE=full 才能完成扩展内部连接调用，并向用户说明工具上下文占用会增加，安装到独立目录。执行 npm ci、类型检查、测试和构建；备份并合并已有扩展路径与严格加载摘要，不覆盖其他配置。重启会影响活动任务时先询问。

search 模式下先发现并用 activate_tools 激活 reload_extensions/list_extensions，再加载并确认七个 wmpf 工具，调用 wmpf_status。缺少后端环境时，说明安装内容、专用缓存路径及原生依赖安装脚本；已有明确安装授权就继续，否则先询问。遇到客户端审批、系统工具缺失或管理员权限要求时遵守实际限制。

完成后汇报路径、版本、检查结果和限制。使用时由用户手动打开小程序，并在 Chrome 访问启动工具返回的 DevTools 地址；保持服务运行直到用户要求停止。不自动登录、下单或重放业务请求。
