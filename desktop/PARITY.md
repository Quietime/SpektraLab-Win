# macOS 1.3.3 → Windows 功能对齐

当前状态与验证限制见 [Windows 使用说明](../README.windows133.zh-CN.md) 和 [验证记录](../distribution/windows/WINDOWS133-VALIDATION.md)。这是一份社区适配，尚无真实 Windows/RTX 4080/Mac 对照验收。

| 区域 | 实现 |
|---|---|
| 胶片/相纸/DI/Film Edge/日期背印 | 原始资料与 Vulkan 原生流水线；不修改材料响应掩盖渲染问题 |
| 工作画布与输出 | ProPhoto RGBA16、Post-Dev 与几何处理、原生 CAM16/Cmax 变换；支持的浏览器使用 Display P3 |
| 导出 | JPEG、PNG 8/16、TIFF 8/16、五种色域、ICC/EXIF、软打样、配方、批量日志、网格、打开方式、DI 与 LUT |
| RAW 与镜头 | LibRaw、取样白平衡、Lensfun 实测配置、明确拒绝不匹配镜头；与 Apple 解码/校准存在差异 |
| 裁切与浏览 | 照片在水平裁切框下旋转、Ctrl 拖线拉直、缩放/比较、胶片条持久排序 |
| 调整 | 曲线取样、五通道曲线、三向色轮与弧形控件、曝光、层与 undo/redo |
| 双格 | 原生组合、每格 WB/取景/印相/Post-Dev、作用域、比较、导出 |
| 场景宽容度 | 原生测量、L* 分离度、核心范围、固定 ±8 直方图与放置 |
| 缓存与内存 | 可验证线性解码磁盘缓存、容量与清理；真实主机 RAM 与 GPU 池统计；软缓存预算、保留 RAM 与释放空闲池 |
| 设置与诊断 | 本地诊断 ZIP、日志保留、手动查询 Mac/Windows 发布版本、语言与布局 |
| CLI/Agent/MCP | Mac 的 138 个字段与 12 个工具、严格原子 patch、同一导出流水线；用户启用后使用带令牌的本机桥接 |
| 隐藏功能 | Mac 本身撤回的 Masks/交互 Tone Mask 不开放 |

主机进程与 WebGL 之间的协议扩展见 HOST-PROTOCOL.md。Linux Vulkan、Wine 原生二进制、浏览器 mock 桥接各自只证明对应层，不能合并声称物理设备通过。
