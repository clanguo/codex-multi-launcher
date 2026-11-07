# 每个 Profile 的 Codex CLI

[English](profile-cli.md)

创建名为 `api1` 的 profile 后，会生成可直接执行的 `codex-api1` 命令。在 Multica 等支持自定义命令的平台中，将运行类型设为 **Codex**，命令填写 `codex-api1`，参数交给平台按正常 Codex 协议传入。终端也可以直接使用：

```sh
codex-api1 --version
codex-api1
codex-api2 app-server
```

命令名使用 profile 的固定 ID。修改显示名称不会改变已有命令；重名 profile 会获得不同 ID。请在 profile 详情的“独立 Codex CLI”区域复制实际命令。

## 环境变量与首次使用

电脑上需要有基础 Codex CLI。程序从 PATH 和 macOS 常见安装目录寻找 CLI；仅安装 Codex 桌面版不一定能在这些位置找到命令工具。新建 profile 时自动生成独立命令，已有 profile 在重新打开管理器时补齐。

命令统一放在 `~/.codex-profile-bin`：

- Windows 生成 `codex-api1.exe`，将目录加入当前用户的 PATH，并广播环境变量变更。保留已有 PATH 中的 `%SystemRoot%` 等变量。
- macOS 生成可执行的 `codex-api1` 脚本，将目录加入 zsh/bash 启动文件，同时用用户 LaunchAgent 在登录时为 GUI 应用设置 PATH。

**首次生成后，需要重新打开终端，并重启 Multica 或它的后台 daemon。** 已经运行的进程继续使用原有环境。详情中提供“重新注册 PATH”按钮。如果外部平台自行限定 PATH，请在该平台的环境中加入显示的命令目录；支持绝对路径的平台也可以使用“复制可执行路径”。

命令使用管理器自带的运行时，共用已安装的 Codex CLI，无需给每个 profile 安装 Node 或复制整套 CLI，也不会打开管理器窗口。管理器需要保留在安装位置；移动或升级后打开一次管理器，以更新命令路径。

## 配置、认证与 .env

每次执行都会读取当前 profile，将 `CODEX_HOME` 固定到它自己的目录，加载该目录的 `.env`，然后启动基础 CLI。保留调用方的工作目录、全部参数、标准输入输出和退出码，供平台正常使用交互或 app-server 协议。

继承自外部进程的 API Key、provider 密钥变量、接口地址覆盖和 Node 启动选项会先清理，再加载 profile 明确配置的 `.env`。保存的 profile API Key 优先于复制的密钥变量；`.env` 不能修改绑定的 `CODEX_HOME`。密钥每次从管理器的加密存储读取，修改后无需重新生成命令。

CLI 与对应桌面窗口共用 `config.toml`、认证和资源。官方 profile 不会附加模型参数或预设模型。账号登录模式使用本 profile 的 Codex 登录存储；如果 CLI 提示需要登录，运行对应的 `codex-api1 login`。

`.env` 支持引号和多行值，不执行 shell 代码，也不展开 `$PATH`、`%PATH%` 或其他变量引用。自行设置 PATH 时应写完整路径；未设置时，会合并调用方 PATH 与管理器记录的安装路径。

如果需要为某个 profile 指定 CLI 版本，在它的 `.env` 中设置绝对路径：

```dotenv
# Windows 可使用正斜杠
CODEX_PROFILE_CLI_PATH="C:/Tools/Codex/codex.exe"
# macOS 则使用类似下面的路径：
# CODEX_PROFILE_CLI_PATH="/opt/homebrew/bin/codex"
```

这里应指向基础 CLI，不能指向另一个 profile 的命令。支持 npm 安装的 Codex 入口；Windows 参数不会交给 `cmd.exe` 解释。

CLI 任务由外部平台管理，不计入管理器的桌面窗口状态；关闭 profile 的桌面窗口不会停止 CLI 任务。Windows 命令被终止时会清理子进程；macOS 平台应向任务进程组发送停止信号，以同时停止其工具进程。

## 删除与验证

移除 profile 后命令不可运行，恢复后仍可使用原名。永久删除时会删除属于它的命令和清单。如果发现已有同名外部程序，会保留它并报告冲突。命令清单只记录路径和 ID，不含 API Key；`.env` 仍是本地明文环境文件。

运行 `npm run verify:profile-cli` 验证命令，运行 `npm run verify:runtime-ui` 验证界面。测试使用临时目录和模拟密钥，不修改真实用户 PATH。GitHub CI 在 Windows 和 macOS 上运行命令查找、认证隔离、参数与输入输出、工作目录、退出码、取消任务、旧 profile 迁移、删除和 PATH 检查。
