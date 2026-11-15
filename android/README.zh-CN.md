# SpektraLab Android 1.3.3 适配

LightTable.3 构建号 13304 使用新安装包名 `app.spektralab.lighttable` 和新签名证书；它与旧版 `app.spektralab.android` 并存，不会卸载旧版或清除旧版数据。手机、平板使用同一包名和证书，但 APK 中固定的更新渠道分别为 `android-phone-arm64`、`android-tablet-arm64`。

基于 Mac 1.3.3 的原始引擎与 Windows/React 界面。Android 10 起、ARM64、Vulkan 1.1 compute 和支持 WebGL2 的系统 WebView。APK 同时携带 x86_64 引擎用于模拟器检查。建议保持 Android System WebView 更新。

照片通过系统选择器读取并复制到应用私有目录，C++ 只处理本地副本；不把 content:// 当作文件路径。目录授权由系统保存。导出到选定的系统目录；输出存在时遵循导出策略，拒绝覆盖已导入的原始 URI。卸载会删除应用私有导入副本与编辑记录，原始照片和已经导出的文件留在系统目录。

手机使用折叠胶片/调整抽屉和底部工具栏；原生胶片、相纸、DI、双格、Film Edge、曲线、色轮、白平衡、镜头资料与五色域导出复用现有实现。默认 1080px 预览、1GiB 磁盘缓存、1024MB 软缓存预算，避免每次编辑自动执行原尺寸渲染；导出仍使用原尺寸。较大的 RAW、双格和效果可能超出手机 GPU/进程内存；此时显示实际失败，不使用 CPU 胶片替代流水线。

与 Mac 的差异：LibRaw/Core Image 和 Lensfun/Apple 校准不同；手机文件访问、触摸布局、字体与 HDR 支持不同；CLI/MCP 暂只提供桌面版。桌面键盘快捷键可以通过外接键盘使用，鼠标专属手势可使用数值控件完成。

构建：`python3 android/install-minimal-toolchain.py` 先显示固定版本、官方 URL、大小与 SHA-1，不下载；磁盘空间足够后显式运行 `python3 android/install-minimal-toolchain.py --install --package build-tools` 和 `python3 android/install-minimal-toolchain.py --install --package ndk`。NDK 安装器先验证完整官方 ZIP，再仅提取 Android API 29 的 ARM64/x86_64 Release 所需编译器、链接器、sysroot、CMake 文件与通知；该精简组合仍须通过两种 ABI 的实际原生编译验证。然后分别运行 `android/build-native.sh arm64-v8a` 与 `android/build-native.sh x86_64`；用 `SPEKTRALAB_ANDROID_FLAVOR=phone python3 android/build-apk.py` 和 `SPEKTRALAB_ANDROID_FLAVOR=tablet python3 android/build-apk.py` 生成两包。默认 SDK 位于 `build/android-sdk`，NDK 27.2.12479018，SDK 35，Java 11+。默认脚本在 spektralab-build 容器中调用 Java 编译工具；容器未装 JDK 时可加 `SPEKTRALAB_HOST_JAVA=1`，用宿主 Java 21 compiler/jartool 模块编译并在宿主暂存引擎资源。缺少现有签名身份时会拒绝构建，不会自动生成另一个密钥。私钥与口令不进入 APK 或源码包。

签名验证和编译通过不能替代运行验收。最终验证结果另附，真实 Android 手机验收尚未完成。
