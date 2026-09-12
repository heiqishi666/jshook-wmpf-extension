# jshook WMPF 扩展

为已有 jshook MCP 增加 Windows PC 微信小程序调试能力。只需配置一个 MCP；扩展自动安装并管理独立的 WMPFDebugger 后端，不要求用户另行克隆或启动 WMPF。

## 安装

要求 Windows、Git、带 npm 的 Node.js，以及兼容的 jshook 0.3.5（扩展声明 ~0.3.5）。建议 Node 24.15.0，满足已验证 jshook 的运行要求。已有微信运行时版本不受支持时，应诊断而非自动扩大补丁范围。

克隆本仓库，在仓库根目录执行：

```powershell
git clone https://github.com/heiqishi666/jshook-wmpf-extension.git
cd jshook-wmpf-extension
npm ci --workspaces=false
npm run typecheck
npm test
npm run build
```

在已有 jshook MCP 的启动环境中，将本仓库绝对路径加入 `MCP_PLUGIN_ROOTS`（多个根目录用逗号分隔）。严格加载模式下，将以下命令输出的摘要合并进 `MCP_PLUGIN_ALLOWED_DIGESTS`：

```powershell
(Get-FileHash ./dist/manifest.js -Algorithm SHA256).Hash.ToLowerInvariant()
```

保留原配置，不能覆盖已有扩展根目录或摘要列表。环境变量变化需要重启对应 MCP；重启会影响它持有的调试资源。默认 search 模式下，先通过 `search_tools` 发现管理工具，再调用 `activate_tools({names:["reload_extensions","list_extensions"]})`，然后调用 `reload_extensions`、`list_extensions`，核对以下七个工具。不要在提供调试服务时反复 reload。

## 使用

| 工具 | 用途 |
| --- | --- |
| wmpf_status | 当前实例状态、缓存检查及安装引导 |
| wmpf_install | 获得安装授权后准备固定版本后端 |
| wmpf_start | 默认使用缓存；可显式复用外部 endpoint |
| wmpf_list_targets | 枚举目标，可按精确 AppID 筛选 |
| wmpf_attach | 核验目标并连接 jshook |
| wmpf_open_devtools | 仅用户明确要求时自动打开 Chrome |
| wmpf_stop | 停止本实例拥有的服务和会话 |

先检查环境。missing 时，已有环境安装授权则调用 `wmpf_install({authorized:true})`；否则解释下载、目录与原生依赖安装脚本并询问。该字段不能替代客户端审批。ready 后调用 `wmpf_start({})`，保存 serviceId 和 endpoint。

默认提示用户手动打开小程序，再在 Chrome 地址栏访问工具返回的 DevTools URL（默认端口 62000）。之后按真实 AppID 选择目标，排除 preload 页面，使用 jshook 内置脚本、断点及网络工具。search 模式下先激活 browser_attach、browser_attach_cdp_target、browser_evaluate_cdp_target 及所需分析工具，避免尚未激活导致调用失败。不要自动登录或重放业务请求。

用户仍需调试时保持所属 MCP 实例运行；清理临时断点不等于停止服务。仅在用户要求停止或明确的一次性测试结束时调用 stop。此扩展不会操作微信窗口，某些情形需要用户重新打开小程序才能触发注入后的加载事件。

## 缓存与恢复

默认缓存为 LOCALAPPDATA/jshook/wmpf，可通过 `JSHOOK_WMPF_CACHE` 覆盖。后端固定上游提交，应用本仓库 GPL 后端补丁，以精确版本清单和锁文件执行 `npm ci --include=dev`。75 个包记录已锁定，并校验 integrity；原生安装脚本的额外下载和系统环境仍可能影响结果。

安装失败保留 staging/install.log。repair_required 表示已有安装不完整或清单不符，不覆盖原目录。安装锁存在时先检查活动进程，不能因客户端超时就删除锁或并发重试。可以配置新缓存目录准备另一份环境。旧缓存与已有服务不自动删除。

受管服务只绑定本机回环，debug 端口为 9421；端口被占用时不接管其他进程。serviceId 只属于创建它的 MCP 实例。另一实例可明确以 endpoint 复用服务，其 stop 不影响原服务。

## 验证与限制

15 项本地测试覆盖会话隔离、授权提示、安装故障、锁定依赖及生命周期。已在 Windows 验证自动缓存安装、注入、目标选择、脚本枚举、临时断点和网络事件。不能据此保证所有微信版本、逻辑层或小程序都支持。

可选集成验证脚本 `scripts/smoke.mjs` 要求 `JSHOOK_CORE_ROOT` 指向构建过的 jshook 仓库；普通使用无需这个路径。该脚本是有限时长验收，会清理自有资源，不适合提供持续服务。

## 许可与来源

本扩展代码沿用来源项目的 AGPLv3，见 LICENSE。独立下载的 WMPFDebugger 为 GPL-2.0-only；assets/managed.patch 保留该许可，见 assets/WMPF-LICENSE 和 assets/NOTICE.md。不可移除上游或第三方通知，不将这些文件重新标为 AGPL。公开分发的组合方式仍需审核，本仓库整理完成不代表许可审核已完成。

给接收方 Agent 的提示见 INSTALL_FOR_AGENT.md；详细操作规则见 agent-guide.md。
