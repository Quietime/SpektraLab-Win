# SpektraLab Windows / Android

面向 macOS SpektraLab 1.3.3 的社区适配，包含 Windows x64、Android 手机和平板，以及胶片看片台。原项目说明保留在 [README.upstream.md](README.upstream.md)，许可见 [license/LICENSE](license/LICENSE)。

**当前为开发中的源码快照，版本 `1.3.3-lighttable.3` / build `13304`，尚未发布通过完整验收的安装包。源码推送不表示测试已全部通过。**

## 当前状态（2026-11-17）

| 范围 | 已执行验证 | 待完成 |
| --- | --- | --- |
| 前端 | 157 项单测通过，4 项需额外原生输入的测试跳过；37 个基线界面用例在分段运行和修复复测后全部通过；最新预览尺寸修复另通过像素和比例复测 | 随实际改动进行相关复测 |
| 原生引擎 | Linux Vulkan 14 项检查；Linux、Wine 及真实 Windows 系统均通过 1000 文件探测、32 次完整渲染、192 MiB 大图预算拒绝和同进程恢复 | 真实 RTX / Adreno 设备验证 |
| Windows | 新构建的 23 项 Rust 测试；真实 Windows/WebView2 内嵌界面、看片台灯光与持久化、Vulkan 渲染及压力测试；E 盘默认和含空格路径安装/卸载；签名更新助手接管、重启及下载包清理均通过 | 用户 RTX 4080 实机验证；签名更新演练采用同一有效载荷重装，未声称跨真实版本迁移 |
| Android 手机 | 安装器 URI 授权修复后的 APK，双 ABI、签名、渠道、公钥、16KB 对齐检查通过；API29 模拟器 109 项原生/WebView 检查通过，包含看片台 | 真实系统升级的取消/确认及清理演练；小米实机验证 |
| Android 平板 | APK 构建及签名、渠道、公钥、16KB 对齐检查通过 | 完整模拟器用例及真实系统升级验证 |

Windows/WebView2 验收在 GitHub 托管 Windows 上执行，使用 Mesa 软件 Vulkan；Android 使用 API29 软件渲染模拟器。当前没有连接用户的 RTX 4080 电脑、小米 17 Ultra 或小米平板 6S Pro，不能据此宣称实机帧率或性能。

## 功能与平台

- Windows 默认安装到 `E:\SpektraLab`，正式构建内嵌界面资源，无需本地开发服务器；运行需要 WebView2 和支持 Vulkan 的显卡。
- Android 查询设备显示模式，请求最高分辨率及该分辨率下的最高刷新率，按实际像素密度绘制；实际刷新率由系统、WebView 和温控共同决定。
- 看片台包含照片托盘、摆放、灯光与亮度、片套、放大、幻灯片及分块布局保存。选中照片显示画布输出，其他预览标明来源。
- 图片缓存和并发有界；Vulkan 分配计账、留出预算并回收空闲缓存；预算不足时明确报错，避免无限分配。
- 三个更新渠道使用签名清单、SHA-256、包身份和安装结果校验。Android 保留系统安装确认，确认成功后清理应用自身下载的更新包。更新合同见 [CONTRACT.md](distribution/updater/CONTRACT.md)。

Android 新包名为 `app.spektralab.lighttable`，与旧 `app.spektralab.android` 并行安装，保留旧应用及其数据。手机、平板是同一包名和证书的不同渠道，分别用于不同设备。

## 源码与构建

- [Windows 构建与验证](distribution/windows/README.md)
- [Android 构建](android/README.zh-CN.md)
- [Android 模拟器环境](android/EMULATOR-SETUP.md)
- [原生压力测试](distribution/stress/README.md)
- [更新合同](distribution/updater/CONTRACT.md)

源码主分支不包含私钥、签名口令、维护备份或构建缓存；验证候选包与对应源码暂存在维护分支和草稿发行，不能视为正式发行。公开更新公钥是验证所需的公开信息。完整安装包和对应校验回执会在验证完成后放入 Releases。
