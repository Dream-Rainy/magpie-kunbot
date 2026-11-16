# 0.3.1 试用预览

0.3.1 修复桌面端测试返回时 wails.localhost 拒绝连接：返回到同一本地服务下的配置页，仍由 Magpie 读取和保存设置。下方测试界面截图沿用 0.3.0。

0.3.0 增加额外的模型测试界面：从配置页打开，选择账号与模型，预览或发送 JSON，查看逐条主备请求、响应和错误。登录仍仅填写 Account name 与 API Key。

截图来自 Magpie **v0.1.4267** 的真实插件沙盒页面，使用隔离配置。后缀示例使用用户提供的 `MiniMax-H3-Image`，备线主机与其他模型均为示例，未发送真实模型请求。

- [线路管理](kunbot-model-manager.png)
- [手动模型](kunbot-manual-models.png)
- [模型后缀与地址预览](kunbot-model-suffix.png)
- [模型测试与请求诊断](kunbot-model-test.png)（本地模拟主线 503、备线 200，未调用真实上游）

下载 `dist/magpie-kunbot-0.3.1.zip` 后先解压，将包含 `package.json` 的目录添加为本地插件；工作区可直接运行：

```sh
magpie plugin add /vol3/1000/coding/data/projects/magpie-kunbot
```

若同时安装了 GitHub 版，请在插件页选择由当前本地版本提供 `kunbot`。侧边栏中的 **kunbot · 线路与模型** 是新的配置入口。

验证：36 项 Node 回归测试通过；真实 Magpie v0.1.4267 的新增测试页已验证服务代理、双账号复用、预览不发送、实际主备请求体、错误响应、脱敏、Messages/Chat/Responses、生图、取消、退出账号与窄屏布局；服务内返回配置、保存及宿主重启后的再次进入测试也通过。Windows 虚拟主机失效场景使用浏览器模拟，并未在真实 Windows WebView2 上运行。没有使用真实 Key 或调用付费模型，真实上游的权限、模型 ID 和协议仍需按实际服务填写。
