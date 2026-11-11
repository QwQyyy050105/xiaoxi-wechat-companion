# 小汐：从一条微信群消息读代码

第一次运行可以只用浏览器面板和虚构消息。需要接 Windows 微信时再读原生部分；开发模型、人格或搜索插件不需要打开微信。

| 想看或改什么 | 从这里读 | 对照的离线用例 |
| --- | --- | --- |
| 演示、浏览器面板和桌面外壳如何接入同一个核心 | [CLI](../scripts/cli.mjs)、[浏览器面板](../src/panel_server.mjs)、[桌面入口](../desktop.cjs) → [运行时装配](../src/runtime.mjs) | [模板测试](../test/public_template.test.mjs)：演示不会启用真实传输或云搜索 |
| Windows 微信的消息和发送结果怎样到达核心 | [桌面传输](../src/desktop_transport.mjs) 与 [Python 桥接](../scripts/desktop_bridge.py)交换命令和结果；版本边界见[构建清单](../native_builds.json) | [传输用例](../test/desktop_transport.test.mjs)覆盖未授权会话和伪造绑定；它不证明新版微信兼容 |
| 为什么接话、带什么上下文、用谁的人格 | [回复策略](../src/reply_policy.mjs)、[会话上下文](../src/conversation_context.mjs)、[人格加载](../src/persona_loader.mjs)；业务在[核心](../src/core.mjs)组合 | [模型上下文测试](../test/model_context.test.mjs)、[人格加载测试](../test/persona_loader.test.mjs) |
| 换模型或新增搜索、媒体能力 | [模型调用](../src/model.mjs)、[扩展加载](../src/extension_host.mjs)、[本地模型插件](../plugins/example_model.mjs) | 按[扩展契约](EXTENDING.md)运行示例；[模板测试](../test/public_template.test.mjs)演示插件如何经过核心生成一次回复 |

遇到漏回，先区分接收器没看到新消息、策略决定不接话、模型没返回、发送结果不明。最后一种要核对目标窗口再恢复，不能把超时当作一定未发，也不能靠重试整条消息验证。
