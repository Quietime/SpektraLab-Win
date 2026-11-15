# SpektraLab Windows 1.3.3

按 macOS 1.3.3 功能对齐的社区适配，适用于 Windows 10/11 x64、支持 Vulkan 的显卡。建议使用华硕提供或 NVIDIA 官方的较新驱动，并在 Windows 图形设置中将程序指定为高性能显卡。

运行安装程序；首次安装 WebView2 可能需要联网。也可完整解压便携包后运行 `SpektraLab-Windows.exe`。不要只复制主程序。无需安装 Python、Node 或 Rust。

embedded-ui-fix 修订修复旧包启动访问 127.0.0.1 被拒绝的问题，正式 EXE 内嵌界面，不需要启动本机开发服务器。

已补齐 16 位 ProPhoto 工作画布、原生色彩变换、五种导出色域、PNG/TIFF 16 位、软打样、RAW 白平衡取样、实测镜头配置、曲线取样、三向色轮、裁切拉直、胶片条排序、导出网格与日志、缓存与内存设置、诊断 ZIP、更新查询，以及与 Mac 同名的 12 个 Agent 工具。CLI 为 `SpektraLab-CLI.exe`；Agent 访问默认关闭，需在设置中启用。

这不是原作者发布的 Windows 版本。RAW 使用 LibRaw，镜头修正使用 Lensfun 实测资料；与 macOS Core Image 和 Apple 私有镜头资料可能产生差异。系统字体、窗口与触摸交互也不同。不能保证与 Mac 逐像素相同。

本次自动验证覆盖 Linux Vulkan、Wine 下 Windows 引擎、WebGL 界面、导出格式、安装文件与卸载保护；尚未在真实 Windows/WebView2、你的 RTX 4080 或真实 Mac 上完成验收。具体结果见 `VALIDATION.zh-CN.md`。不要将 Wine 检查理解为真实 Windows GUI 测试。

卸载保留照片、个人设置与应用缓存。源码及依赖许可在 `source/` 和 `host/licenses/`；校验清单为 `SHA256SUMS.json`。
