# 第三方二进制说明（NOTICE）

本目录（`bin/native/`）下的以下文件**不是本项目的作品**，也不在根目录
[MIT License](../../LICENSE) 的授权范围内：

| 文件 | 来源 |
|---|---|
| `linker64` | Android 系统动态链接器（`/system/bin/linker64`） |
| `libc.so` / `libm.so` / `libdl.so` / `liblog.so` | Android 系统 bionic / 平台库 |
| `libc++.so` / `libc++_shared.so` | Android NDK C++ 运行库 |
| `lre.so` | 小猿口算 App 的 `libRequestEncoder.so`（sign 计算） |
| `libContentEncoder_patched.so` | 小猿口算 App 的 `libContentEncoder.so`（已把 `DT_NEEDED: libandroid.so` 等长覆盖为 `libc.so`） |
| `dump7` / `enc_device` | 本项目为调用上述 so 而写的 harness（这些是本项目的作品，但依赖上面的库） |
| `pk_body.gz` | 一份用于自检比对的样本数据（已脱敏，仅含数学题与笔迹坐标） |

它们仅用于**本机研究**：让 Node 进程能在 proot 里调用 Android 的 arm64 原生库。
版权归各自权利人所有。若你要分发本项目，请自行评估并遵守相应许可；

**建议**：把这一类文件从版本库中排除，改为提供"如何从你自己的设备提取"的脚本。
