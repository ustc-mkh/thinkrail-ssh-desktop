# Thinkrail SSH

一个独立的 Linux 桌面连接器：系统 OpenSSH + 原版 Thinkrail 页面。

不 fork Thinkrail，不捆绑固定版本的 Thinkrail 前端，不解析聊天、文件或终端协议，不注入上游 DOM。远端提供什么版本的页面，桌面端就显示什么版本的页面。连接器自身只有 Electron 一个开发依赖，运行逻辑全部使用 Node.js 标准库。

## 使用

### Linux 免安装包

解压 `thinkrail-ssh-linux-x64.tar.gz`（ARM64 构建对应 arm64），进入解压目录，运行：

```bash
./start.sh
```

需要图形桌面、系统 OpenSSH 客户端和支持 Electron 45 的 Linux 环境。推荐近期的 Fedora、Ubuntu 等发行版。保留整个目录，不要单独移动可执行文件。启动器默认保留 Chromium 沙箱。

### 从源码启动

需要 Node.js 22.12+ 和 npm：

```bash
npm ci
npm start
```

`npm ci` 会下载锁定版本的 Electron 运行时，需要能访问 npm 与 Electron 发布下载站。应用不需要 Node.js 全局依赖，也不需要在本机安装 Thinkrail。

### 配置 SSH 和远端

先确认终端能连接：

```bash
ssh dev-server
```

SSH 端口、跳板机和密钥统一在 `~/.ssh/config` 中维护，例如：

```sshconfig
Host dev-server
    HostName server.example.com
    User your-name
    Port 22
    IdentityFile ~/.ssh/id_ed25519
    # ProxyJump bastion
```

在远端安装[官方 Thinkrail CLI](https://github.com/JetBrains/thinkrail#install)，完成模型配置。连接器不会自动安装或升级它。

打开应用，填写 `dev-server` 或 `user@hostname`，点击“连接服务器”。密钥口令、密码和首次主机确认会通过桌面对话框处理；已加载到 ssh-agent 的身份仍直接使用。密码只通过私有临时 socket 传给 SSH，不写入连接配置。

- 默认远端服务为 `127.0.0.1:24242`。
- 有现成服务时直接使用，不重启。
- 勾选“需要时启动远端 Thinkrail”时，会在服务未就绪时运行 `thinkrail --no-open --host 127.0.0.1 --port 24242`。
- “项目路径”只用于启动新的远端服务，不会改变已有服务当前打开的项目。
- 找不到命令时可在高级设置填写可执行文件绝对路径；默认还会检查 `~/.local/bin/thinkrail`。这里是可执行文件路径，不是带参数的 shell 命令。
- 不自动连接上一次的主机；打开应用后由你选择连接。

## 连接和恢复

一条系统 SSH 连接同时提供转发和用于检查/启动服务的远端 POSIX shell，不额外做重复认证。配置里的 ProxyJump、IdentityFile 等由 OpenSSH 原生处理。连接器独占自己的 SSH 进程，不接管用户的 ControlMaster，也不会关闭终端中其他 SSH 连接。

远端通过 `nohup` 后台启动，标准输入、输出、错误均已重定向。退出桌面应用默认只断开 SSH，不停止 agent。运行过程中的 SSH 断线会退避重连，页面保持原样，由 Thinkrail 自己恢复 WebSocket 会话；不会在代理层重放业务操作。认证或主机密钥错误会停止自动重试，避免循环弹出认证提示。

系统休眠期间不发起连接；恢复时重建连接。SSH 保活为 15 秒、最多 3 次未响应；健康检查每 15 秒一次。健康检查超时只提示等待，不擅自重启远端服务。

每个连接保存固定的本地网关端口、独立的持久化 Electron 会话。SSH 隧道端口可以变化，页面 origin 不变，因此断线不会因端口变化丢失本地布局。端口被其他程序占用时会明确报错；高级设置“重置本地地址”可重新分配，但新 origin 会使用新的页面本地偏好。

远端启动记录和日志在：

```text
${XDG_CACHE_HOME:-~/.cache}/thinkrail-ssh/port-24242.pid
${XDG_CACHE_HOME:-~/.cache}/thinkrail-ssh/port-24242.log
```

如果旧 PID 已被系统复用且确实阻止启动，确认对应进程后移除该连接器的 `.pid` 文件即可；连接器不会根据一个 PID 文件自动杀掉远端进程。异常中断遗留的 `.lock` 目录也会在日志中提示。某些服务器会在用户注销后清理全部进程；需要在这些环境下长期运行时，请自行把 Thinkrail 配置为用户服务，连接器选择连接已有服务即可。

## 与 Thinkrail 更新解耦

连接器只依赖以下外部边界：

1. SSH 和远端 POSIX shell。
2. Thinkrail CLI 的 `--no-open`、`--host`、`--port`、可选项目路径。
3. `GET /health` 返回 `ok`。
4. Thinkrail 通过 HTTP 提供自己的页面，页面使用同源 HTTP/WebSocket。

页面、脚本、文件、字体、下载和未知的新路径全部流式透传，HTTP 状态、响应头和 WebSocket 数据保持原有含义。不维护资源路径白名单，不缓存 API，不强行缓存 JS，不安装 service worker，不需要同步升级前端 npm 包。Electron 自己的常规 HTTP 缓存遵循远端响应头；手动“刷新工作页面”会绕过缓存。

若上游以后改变 CLI、健康检查或同源部署约定，才需要调整相应小模块；并不保证任意未来版本永久兼容。自动启动这一边界也可通过关闭“需要时启动”减少依赖。

升级远端 Thinkrail：先等待任务结束，按上游方式升级并重启服务，再在连接器中刷新工作页面。网络重连不会自动刷新页面，以保留未完成输入及上游会话身份；**后端升级重启之后需要手动刷新**，让页面与后端来自同一版。连接器不负责调度更新或回滚数据。

## 实际优化与边界

- 复用远端服务与同一条认证连接，减少启动等待。
- 代理使用流式转发、背压和 TCP_NODELAY，不整包缓冲终端/文件输出。
- 稳定 origin、保留渲染器，减少重连时页面重建。
- 以 SSH 保活、恢复重连和明确日志改善故障恢复。
- 默认不强制压缩，遵循用户的 SSH 压缩配置；不承诺降低物理网络 RTT。

这是独立桌面窗口，内部仍使用 Chromium 渲染原版网页，并不是重写一套原生 IDE。当前主要支持 Linux 本机、Linux/macOS 远端的 POSIX 环境。Windows 本机/远端未验证。

上游无图形远端的“打开项目”目录选择问题仍由上游行为决定；建议用项目路径启动，或使用上游已支持的路径入口。连接器不篡改该对话框。OAuth 若回调远端 localhost 的其他端口，仍需按该供应商流程另行转发；优先在远端先完成认证。原生桌面通知、多主机同时显示、自动安装/更新、远端任意目录浏览和第三方 deep link 均未加入第一版。

## 隔离

连接管理页与 Thinkrail 页面是分开的渲染器。远端页面没有 preload、Node.js 或 SSH 管理 IPC；启用 sandbox、contextIsolation 和 webSecurity。网关仅监听本机 loopback，并要求只由对应桌面页面的同源请求携带的随机凭证。外链交给系统浏览器，连接器页面禁止任意导航。

连接配置保存在 Electron userData 中的 `profiles.json`，Linux 通常是 `~/.config/Thinkrail SSH/`（实际遵循 Electron/XDG 设置），仅保存主机、路径、端口等配置。默认不会关闭已有的远端服务。远端 Thinkrail 的模型凭证仍在远端。服务器上的 loopback TCP 仍可能被同机其他用户访问，这与手动运行 CLI 一样；共享服务器需要由管理员配置适当隔离。

## 验证与打包

```bash
npm run check
npm test
npm run smoke
npm run package
```

测试需要 Linux 的 `ssh`、`sshd`、`ssh-keygen`；测试会在临时目录生成测试密钥、启动仅监听 loopback 的隔离 sshd，并用模拟 Thinkrail HTTP/WS 服务验证真实 SSH 链路，不使用个人 SSH 配置或真实模型。桌面 smoke 额外需要图形桌面和可执行的系统 Node.js；可用 `TRSSH_TEST_NODE=/usr/bin/node npm run smoke` 指定其路径。测试模拟上游页面，不等于对真实 Thinkrail 所有功能的兼容性认证。

打包后可运行 `node test/packaged-smoke.mjs` 验证实际启动器及加密 SSH 密钥的认证弹窗。当前图形环境如需强制 X11，可使用 `npm run smoke -- --ozone-platform=x11`；正常启动同样支持 `./start.sh --ozone-platform=x11`。

对指定的官方 CLI 做隔离兼容检查（需先自行验证该二进制的 SHA-256）：

```bash
TRSSH_TEST_NODE=/usr/bin/node TRSSH_UPSTREAM_BINARY=/absolute/path/to/thinkrail \
  node_modules/.bin/electron test/upstream-smoke.mjs --ozone-platform=x11
```

已完成的验证范围见 [VALIDATION.md](VALIDATION.md)。

打包只复制官方 Electron 运行时和应用源码，无额外打包框架、无本地编译。产物为 `dist/thinkrail-ssh-linux-<arch>.tar.gz`，架构跟随构建机器。

结构：

```text
src/main.js           桌面窗口、IPC、页面隔离
src/core/ssh.js       系统 SSH、远端启动、健康检查
src/core/connection.js 连接生命周期与恢复
src/core/gateway.js   与业务无关的 HTTP/WS 代理
src/core/askpass.js   认证对话框通道
src/core/store.js     连接配置持久化
src/ui/              无前端框架的本地连接界面
```

本项目是独立连接器，与 JetBrains/Thinkrail 官方无隶属关系。
