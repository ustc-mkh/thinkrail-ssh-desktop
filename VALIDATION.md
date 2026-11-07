# 验证记录

日期：2026-11-07（Asia/Hong_Kong）。

环境：Fedora 45 GNOME x64、Node.js 22.23.1、Electron 45.2.3、OpenSSH 10.5p1；Chromium 沙箱保持启用。

## 已通过

- JavaScript 全量语法检查。
- v0.1.1 HTTP 连接池测试：5 次连续请求只建立 1 条上游连接；切换目标清理旧连接；HTTP 池满时 WebSocket 正常升级；正确处理远端 `Connection: close`。Node 测试共 14 项通过。
- Node 测试：透明代理的未知路由、PUT 和二进制数据；请求凭证隔离；WebSocket 双向数据和初始字节；后端断开时管道关闭；稳定地址重绑定。
- 配置及启动测试：主机参数校验、远端路径 shell quoting、原子写入和私有文件权限、损坏配置报错。
- 连接生命周期：服务响应慢或占用错误服务时不重复启动；健康检查故障不重启 SSH/agent；主动取消清理端口和重试。
- askpass 私有 socket 传递口令。
- 使用隔离 sshd 和临时密钥的真实 OpenSSH 集成：后台启动、断线重连复用原进程、固定页面 origin、断开后服务继续运行。
- Electron 源码桌面测试：HTTP/WS 正常、远端无 Node/连接管理 IPC、重连不刷新页面、本地偏好保留。
- 自定义标题栏：最大化、还原、最小化、关闭及最大化图标状态；远端页面没有窗口控制桥。拖动区域和按钮排除区域经过 CSS 检查，实际鼠标拖动/双击仍需用户在自己的 GNOME 配置下确认。
- v0.1.2：标题栏由 64px 改为 36px，工作视图同步上移；桌面测试检查标题栏实际高度和工作视图可用高度。
- GNOME/X11 可查询最小化状态；Wayland 按 [Electron 文档](https://www.electronjs.org/docs/latest/api/browser-window#event-minimize)不暴露最小化状态，因此 Wayland 测试只验证按钮调用原生最小化，不伪造该状态。
- 打包后的 Linux 启动器测试：真实表单提交、加密 SSH 密钥弹窗、HTTP/WS、再次认证后的重连不刷新页面。
- 官方 Thinkrail **v0.3.2** 初始页面：从官方 release 下载 CLI 并核验 SHA256SUMS；在临时数据目录、真实本地 SSH 隔离环境启动，原版前端成功挂载、显示 **Connected**，同源资源无 HTTP 4xx/5xx。未使用真实模型凭证。
- npm 安装依赖检查：0 个已知漏洞；无生产 npm 依赖。

## 未覆盖

- 用户真实远端、企业 VPN/跳板机、硬件密钥及各类 MFA。
- 模型调用、长时间 agent 任务和大项目的端到端压力测试。
- 上游任意未来版本的兼容性；上游原生目录选择、OAuth 额外回调端口问题仍然适用。
- Windows/macOS 本机与 ARM64 二进制运行。

已交付的 Linux x64 包不包含 Thinkrail；更新远端 Thinkrail 无需重新打包连接器。对当前官方初始页面的验证不代表对上游每个功能的兼容性认证。
