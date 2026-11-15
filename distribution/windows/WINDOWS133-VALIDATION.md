# Windows 1.3.3 验证记录

对齐目标：JamesQiu2005/SpektraLab，spektralab-v1.3.3，c52657409ad8d4c1bcd2e581879891ae32e8352f。

启动修复（embedded-ui-fix）：用户实机截图证实旧包错误访问 127.0.0.1，导致 ERR_CONNECTION_REFUSED。根因是直接 Cargo release 构建没有启用 Tauri custom-protocol，仍属于开发模式，旧检查未覆盖此缺陷。已为正式构建显式开启此选项，将前端嵌入 EXE；构建脚本拒绝缺少此选项的 release，打包脚本检查最终 EXE 的嵌入界面标记。此修复不代表已经完成真实 Windows GUI 或 RTX 4080 验收。

已完成的自动检查：

- 前端 TypeScript、lint、127 项单元测试通过；4 项需要外部 RAW 的测试明确跳过。
- 完整浏览器回归 26 项通过；新增色轮与导出网格回归 2 项通过。浏览器使用测试平台桥接，不能证明 WebView2 可运行。
- 原生 Vulkan CTest 14 项通过，保持原数值容差。
- Lensfun 0.3.4 独立校准 oracle：3865 项比较通过，最大误差 6.095e-5，边界 1e-4。
- 合成 DNG 的 LibRaw 解码、白平衡取样与镜头修正通过；完整 DNG 主机协议回归 249 项通过。
- Windows 引擎在 Wine 下检查实际 Vulkan 渲染、工作色域导出和缓存；最终检查结果记录在随包 BUILD-INFO.json 和安装包回执。
- Rust Agent/CLI、更新解析和诊断 ZIP 测试通过；独立 ZIP/PNG/TIFF 读取检查校验结构、ICC、位深及像素。

未完成的设备验收：真实 Windows GUI/WebView2、RTX 4080、真实 Mac 对照以及不同相机的完整 RAW 样本矩阵。软件 Vulkan/Wine 不构成这些验收。

已知平台差异：LibRaw 与 Core Image 的 RAW 解码；Lensfun 与 Apple 镜头资料（不匹配时明确不可用）；Windows 系统字体；HDR/EDR 受显示器、驱动和 WebView2 支持限制。五种内建导出色域沿用原生变换，任意外部 ICC 的转换未实现。镜头 TCA 在工作 RGB 中处理，可能不同于相机 RGB 校正。

所有相片输入检查保持原文件不变；卸载仅删除安装清单中的文件，不递归删除个人文件。应用二进制未进行商业代码签名。内含的微软 WebView2 引导程序已核验微软主签名及摘要；该检查未验证时间戳信任链。
