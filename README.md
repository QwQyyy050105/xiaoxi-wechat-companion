# Xiaoxi WeChat Companion

A local AI companion template with editable personality, conversation controls, a browser/desktop panel, and an **experimental Windows WeChat group adapter**. This repository starts with **no account, no authorized conversations, no cloud calls**. It is an independent template, not an official WeChat bot service.

先看 [三种模板怎么选](docs/CHOOSING_A_TEMPLATE.md)、[小白可以直接复制的提问](docs/BEGINNER_PROMPTS.md) 和 [可移植性说明](docs/PORTABILITY.md)。这三个仓库各自部署；本仓库专注微信端，不能继承 QQ 的协议接入能力。

## 先运行，不必准备账号或 API Key

需要 Node.js 20.16 或更高版本；建议当前受维护的 LTS。普通演示和浏览器面板可在 Windows/macOS/Linux 运行。原生微信收发只支持下文列出的 Windows 实验构建。

```sh
npm ci
npm run init
npm run demo
```

打开命令行显示的 `http://127.0.0.1:8765`，在“本地试聊”发一句话。Mock 会明确标注“本机演示”，不会假装调用了模型或接通微信。按 Ctrl+C 关闭。端口占用可用 `npm run demo -- --port 8766`。

```sh
npm run demo -- --smoke  # 自动核对面板和一次 Mock 回答，然后退出
npm run doctor -- --json # 只检查配置和本机命令，不读聊天、不调用模型
npm test                # 离线测试；真实微信验收单独进行
```

## 换成你自己的模型

先退出演示，再运行 `npm run panel`。在“模型与启动”选择来源、填写模型名称并保存，然后点“测试 AI”。**模型名称由你选择；超时或失败不会自动换成别的模型。**

| 路线 | 需要什么 | 实际支持 | 尚不支持 |
| --- | --- | --- | --- |
| Mock | 无账号、无网络 | 本机固定规则演示、面板与插件测试 | 真实智能回答、搜索 |
| OpenAI-compatible API | Chat Completions 基础地址、提供方模型名、密钥环境变量 | JSON/SSE 流式文本、图片输入（服务需支持）、取消、总超时、有限重试 | 把普通 Chat Completions 自动变成联网搜索 |
| Codex CLI | 本机安装且已登录的 `codex`，可用的模型名 | `codex exec --json`、图片、取消、总超时；可选实际联网搜索 | 代替你注册/登录、保证所有 CLI 发行版和模型都支持相同参数 |

浏览器面板只接受 **密钥环境变量名**，例如 `OPENAI_API_KEY`。先在启动面板的同一终端设置真正的密钥，面板内只填变量名：

```powershell
$env:OPENAI_API_KEY = "YOUR_OWN_KEY"
npm run panel
```

```sh
export OPENAI_API_KEY='YOUR_OWN_KEY'
npm run panel
```

API 基础地址应含提供方要求的版本路径，例如 `https://api.openai.com/v1`；程序在后面拼接 `/chat/completions`。远程地址要求 HTTPS；本机 `127.0.0.1/localhost/[::1]` 可以使用 HTTP。密钥不回显在状态 API、诊断或示例配置中。Codex 可用 `CODEX_CLI_PATH` 指定可执行文件；否则从 PATH 查找。认证沿用 CLI 自己的登录位置，不复制认证文件。默认调用带官方 `--ignore-user-config`，不继承本机 `CODEX_HOME/config.toml` 中的自定义 provider、MCP、hooks 或插件配置；认证位置仍保留，模型、搜索和工具限制由本程序显式传入。若你选的 CLI 模型依赖自定义 user config，请改用兼容 API 或审核过的本机 model 插件。旧 CLI 不认识这个隔离参数时直接报错，不会删除参数重试或换模型。

API SSE 是**接收流式输出**，微信在完整且未取消后才发送，避免向群里连续刷半句。总超时默认 120 秒，可设 1–300 秒；默认最多重试 1 次，可设 0–2。只有尚未收到内容时的连接错误和 HTTP 429/502/503/504 会重试，已开始输出的请求不重试。取消会中止请求；Codex 超时/取消结束本次子进程，不自动重试。

浏览器面板聊天保存在本机普通文件中。桌面版 `npm start` 使用 Electron 与操作系统密钥存储，加密保存聊天和可选的直接 API Key；操作系统密钥存储不可用时停止，不退回明文。演示、浏览器面板、桌面版分别存储在 `data/demo/`、`data/panel/`、`data/companion.enc`，不要相互复制加密状态。全部为 Git 忽略文件。

## 在面板上个性化

- “人格与参与”：姓名、身份、特点、说话方式、喜欢/讨厌、呼叫别名、默认风格；保存后下一轮生效。独立卡写入 `character_card.local.json`，不覆盖公开示例。
- “会话管理”：每个已授权会话的启停、叫名或仅观察、风格、分条、连续接话时长和主动参与。主动参与默认关闭，有间隔、日额度、安静时段和无人回应停止机制。
- “账号与授权”：指定机器人账号与会话；新增、删除、改名会停止监听，正常重启后才使用新的授权表。聊天内容和人格卡不能修改这张表。
- “会话记忆”“提醒任务”：先由本机主人确认，再持久化或执行。取消、错过和结果不明保留收据；关机期间不运行、不补发积压。

可迁移关系图与会话背景分离；可用 `group_profiles.json` 的版本 2 关系图（见 `test/fixtures/group_profiles.json` 中的虚构团队示例），不要提交自己的关系图。关系图只帮助理解人物，不作为发言者认证或管理员权限。

## 微信接入：先明确限制，再配置

**普通微信账号作为载体。当前 Windows 原生适配不是官方机器人 API。** 它使用 UI Automation/Win32 后台控件接口，不靠 OCR 识屏，也不读取聊天数据库。会话必须有独立窗口；最小化可读写，在你手动使用目标微信窗口、存在草稿、锁屏或身份无法核验时会暂停。没有 GPT 远程控制也能运行；电脑、微信和本地程序需要保持运行。

已在原部署验证：Windows、微信 **4.1.15.56**，DLL SHA-256 记录在 `native_builds.json`；后台群文字收发、微信已有的语音转文字、可选图片缓存候选。**公开模板的跨设备原生收发尚待使用者在自己账号上验收**。macOS/Linux 微信、手机、其他构建、联系人原生私聊、自动语音转文字、原始语音提取、音频/表情发送、可靠发言者 ID 均为 **unsupported**。不要通过修改版本字符串或猜地址强行启用。

高级适配需要临时开启该精确构建的 Qt 无障碍开关，守护进程在退出/失联时恢复。图片缓存为额外显式授权：需要准确的账号缓存根、wxid 和每个群的 wechatPeerId（原始 chatroom ID）。UIA 的 windowBinding 另由运行时绑定，二者不能混用。解码前优先从精确构建的磁盘 DLL 定位 landmark，再读取必要指针、账号与图像参数。若 landmark 只在运行时构造，必须另行设置 native.allowModuleDataScan=true 才允许只读扫描该模块 .data 段：总范围小于 32MiB，每次最多4KiB，可能经过段内其他敏感字节；段内容与派生密钥只在本机进程短暂存在，不写文件、不记录、不通过IPC或网络传出。之后的必要指针读每次最多256B。不扫描整个堆，不打开聊天数据库或导出认证/数据库密钥。默认关闭图片缓存和段扫描；未授权时明确失败，不暗中降级扫描。缓存图不能保证绑定具体消息或发送者；未知版本保持关闭。

Windows 准备步骤（**均在仓库目录**；先停止程序）：

```powershell
$env:TEMP = "$PWD\temp"
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = "$PWD\.pip_cache"
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
python -B -m venv runtime/desktop_bridge
.\runtime\desktop_bridge\Scripts\python.exe -B -m pip install -r requirements-desktop.txt
```

在“账号与授权”填机器人微信显示名、本机账号文件夹名与完整群名，勾选实验适配。账号文件夹名用于匹配进程打开文件的**路径元数据**；它不是密码，也不会被搜索/模型接收。原生适配只接受群聊。窗口权限等级要匹配，系统权限弹窗由你自己处理。

准备精确构建的只读兼容报告（DLL 路径由自己的微信安装位置决定）：

```powershell
npm run native:prepare -- --dll "FULL_PATH_TO_INSTALLED_WECHAT_DLL"
```

这一步只读 DLL、核对允许列表后写入本仓库 `data/`；不改微信。然后正常重启 `npm start`，或重新运行 `npm run panel`，点“测试 AI”“连接小汐”。模型设置里只有在确实支持视觉时才勾选图片输入；默认面板不宣称图片已接通，需真实取得缓存图才显示候选可用。先在一个测试群检查读取、叫名、连续接话、后台回复、停止和重新连接。**不要把 `connected` 当作手机已送达证明**；`local_echo` 只证明本机气泡，结果不明不会自动重发。

## 扩展、调用、移植

[插件与 API](docs/EXTENDING.md) 给出本地模块契约、实际调用形状和工作示例。[配置参考](docs/CONFIGURATION.md) 列出路径、环境变量、持久化和能力边界。新的微信版本或其他平台应提供新的 transport 插件及能力测试，不复用旧版偏移。

演示不需要 Python；Node 测试中的 Python/Win32 进程集成在缺少相应依赖时会明确 skip。Python 原生单元测试可在 Windows 环境安装上述依赖后运行：

```powershell
$env:XIAOXI_CONFIG = "$PWD\test\fixtures\deployment.json"
.\runtime\desktop_bridge\Scripts\python.exe -B -m unittest discover -s test -p "*_test.py"
```

本仓库不含私人会话、机器人帐号凭据或个人媒体。发布前运行 `npm run check:release`。Apache-2.0；第三方研究与派生代码见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## AI maintenance workflows

Read [AGENTS.md](AGENTS.md) for project boundaries and task routing. Reusable project skills cover release verification, adapter/provider extensions, personality edits and incident handoff under `.agents/skills/`. These files do not install a global agent or an operating-system sandbox.

Windows 可在安装依赖后双击 `Start_Panel.cmd` 打开本机配置面板；它不会自动登录平台或发送消息。终端窗口保持运行，Ctrl+C 停止服务。`Start_Panel.cmd --check` 只检查启动条件。

发布隐私、默认权限、真实模型数据流与高级路线边界见 [安全与模型扩展说明](docs/SECURITY_AND_MODELS.md)。
