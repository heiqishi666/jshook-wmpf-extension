# 给 Agent 的使用提示

使用 jshook 的 WMPF 扩展完成 PC 微信小程序调试。先读取本扩展 README，发现本机 jshook、扩展、受管 WMPFDebugger 路径及 Node 版本，安装缺失依赖并构建；不要复用作者电脑路径，不替换用户已有 MCP 配置。

通过 reload_extensions/list_extensions 确认六个 wmpf 工具已加载。所有日常后端操作使用扩展工具，不绕过扩展运行 WMPF CLI。旧外部进程迁移需先核实归属和授权，扩展不会停止外部服务。

先 wmpf_status，再 wmpf_start（backendPath 为受管模式，endpoint 为明确复用模式）。保存 serviceId/endpoint；跟随 nextActions，提示用户先手动打开小程序，再在 Chrome 访问返回的 DevTools URL。默认不调用 wmpf_open_devtools；仅用户明确要求自动打开 Chrome 时使用。

调用 wmpf_list_targets，排除 preload 页面，通过精确 AppID 或 targetId 调用 wmpf_attach。不要硬编码品牌、AppID、版本或旧 targetId。确认 URL 身份后使用 jshook 内置源码、断点、网络工具。默认仅观察授权目标，不自动登录、发送验证码、下单或重放业务请求。

没有目标时根据 status 日志区分服务启动、注入、加载事件与小程序连接。debugFrida 可在启动时开启。必要时请用户重新打开小程序；当前扩展不会操作微信窗口，也不能靠打开 Chrome 将已运行小程序自动补接入。记录不支持的场景，不自动扩大后端补丁范围。

结束观察时移除本次断点并恢复本次暂停。用户还要使用 Chrome 就保持所属 MCP 实例和服务运行，不调用 wmpf_stop，不卸载或重载扩展。仅在用户要求停止或明确的一次性测试结束时停止本实例资源。

向用户汇报实际通过的检查及未覆盖项：端口监听、目标身份、脚本枚举、源码正文、断点、网络事件、响应体是不同证据，不能相互代替。告知服务是否仍运行及下一步动作。

最新环境入口：工具共七个，先读 wmpf_status.environment。missing 时按返回的安装说明和 nextActions 判断是否已有用户授权；有则 wmpf_install({authorized:true})，无则先询问。ready 后 wmpf_start({})，不要求用户提供 backendPath。安装不等于调试就绪。系统 Git/npm 缺失时报告具体前置条件，不自行提升权限。
