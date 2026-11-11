# 单群提醒回执

Windows 桌面版可以在正在运行小汐的同一 Windows 用户下，查询一个已授权群的一项提醒。关闭面板也能查之前已保存的记录。请从已安装 Electron 的仓库根目录运行，用部署文件里指定的群 ID、提醒完整内容及建单时间（含时区）替换示例。时间范围含起点、不含终点。

```powershell
node scripts/query_reminder.cjs --target team --text "取文件" --from "2026-01-02T10:00:00+08:00" --until "2026-01-02T10:05:00+08:00"
```

结果 `matched` 表示找到唯一的一条；`not_found` 和 `ambiguous` 分别表示没有精确匹配，以及同一时段存在多条同名提醒。缩小时间范围可区分重名记录。查询输出北京时间、待批准状态、由收件 ID 关联的建单回执及到期的本机发送回执；找不到关联时输出 `not_linked`。建单时回复“等主人确认”与批准执行是两个不同状态，`local_echo` 只证明本机出现了发送气泡。

也可以从标准输入传入 UTF-8 JSON。以下 PowerShell 7 示例在提示中输入事项，事项不会进入命令历史或进程参数。

```powershell
$item = Read-Host "提醒完整内容"
@{target="team";text=$item;from="2026-01-02T10:00:00+08:00";until="2026-01-02T10:05:00+08:00"} | ConvertTo-Json -Compress | node scripts/query_reminder.cjs --stdin
```

工具使用桌面版自己的 `Store` 和 Windows 当前用户的 Electron `safeStorage`。密钥由系统管理。查询进程沿用桌面端的 `userData` 和 `sessionData` 路径，不打开窗口；临时文件、日志和崩溃记录均隔离在仓库 `temp` 下。用于核验的虚构桌面配置和实际部署都通过了原路径解密测试。换机时需要保留原系统可用的密钥环境。

查询只针对本仓库已存在的 `data/companion.enc`。正常存储类先将单一加密文件解密到本机内存，查询只用目标群的任务、关联收件编号及发件回执，输出中没有聊天正文。它不会修改任务、发信或访问微信数据库。浏览器演示状态没有可供此工具查询的桌面加密库。

报错 `desktop_store_read_failed` 表示系统无法读取应用文件，`desktop_store_decrypt_failed` 表示当前用户或配置目录无法解密，`desktop_store_format_invalid` 表示应用无法解析数据格式。这三种情况的提醒状态均未知。在持有原存储实例的桌面客户端内，可直接复用 `src/reminder_receipt.mjs` 的 `queryReminderReceipt(store.value, query)`。
