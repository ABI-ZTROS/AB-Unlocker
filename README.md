# A/B Partition Ghost Lock Unlocker

自动检测并解除Android A/B分区因OTA更新失败导致的幽灵锁死问题。

## ⚠️ 重要提示

**本模块专为ColorOS/OnePlus/Realme设备设计，仅限以下设备安装：**
- ✅ OPPO ColorOS 设备
- ✅ OnePlus ColorOS/OxygenOS 设备  
- ✅ Realme UI 设备
- ❌ 其他品牌设备将被拒绝安装

安装时会自动检测设备型号，不匹配的设备将无法安装。

## 问题描述

在ColorOS/OnePlus设备进行大版本OTA更新后，可能出现以下情况：
- 系统成功从新槽位启动，但旧槽位被update_engine的状态机永久锁死
- 使用dd命令刷写旧槽位时报错"Device or resource busy"
- root权限也无法解除此锁
- 本地OTA安装也会失败

## 模块功能

- ✅ **自动兼容性检测**：安装时验证设备型号，不支持则拒绝安装
- ✅ **槽位切换检测**：自动检测OTA更新后的槽位切换
- ✅ **锁死探测**：使用原生系统调用精确探测分区锁死状态
- ✅ **自动解锁**：自动执行解锁流程
- ✅ **完整日志**：记录所有操作供排查
- ✅ **多数据源Fallback**：不依赖第三方工具，使用系统底层接口

### 核心检测机制

**槽位检测（三级Fallback）：**
1. `/d/slot_info` - 内核调试接口（最可靠）
2. `/proc/cmdline` - 内核命令行参数
3. `getprop` - 系统属性（最后备选）

**分区锁死探测：**
使用Python原生系统调用 `os.open()` 配合 `O_EXCL` 标志精确判断

## 安装方法

### 自动安装（推荐）

1. 下载最新的模块zip包
2. 在Magisk/KernelSU Manager中刷入
3. 安装时模块会自动检测设备兼容性
4. 重启设备

### 手动安装

```bash
# 通过ADB安装
adb push AB-Unlocker-v1.0.0.zip /sdcard/
adb reboot recovery
# 在Recovery中选择刷入模块
```

## 安装流程

模块安装时会执行以下检查：

```
1. 检测设备制造商（OPPO/OnePlus/Realme）
2. 检测系统版本（ColorOS/ColorOS UI）
3. 验证兼容性
4. 通过则安装，失败则拒绝
```

## 日志查看

模块运行日志保存在：`/data/local/tmp/ab_unlocker.log`

查看日志命令：
```bash
adb shell su -c "cat /data/local/tmp/ab_unlocker.log"
```

## 手动修复

如果模块无法自动修复，可以手动执行：
```bash
su
stop update_engine
stop update_engine_client
killall -9 update_engine
killall -9 update_engine_client
rm -rf /data/misc/update_engine/*
```

## 技术原理

### 问题根因

1. **update_engine状态机异常**：OTA更新后，snapshot合并线程可能死锁
2. **资源泄漏**：进程异常退出时独占文件描述符未被回收
3. **持久化状态卡死**：状态文件停留在中间状态

### 解决方案

1. **停止update_engine服务**：阻止其继续持有锁
2. **终止残留进程**：释放内核文件描述符
3. **清除持久化状态**：重置状态机
4. **验证解锁**：确认分区可写入

## 常见问题

### Q: 安装时提示设备不兼容怎么办？
A: 本模块专为ColorOS/OnePlus/Realme设备设计，其他设备无法安装。

### Q: 模块检测到锁死后没有自动解锁？
A: 检查日志文件 `/data/local/tmp/ab_unlocker.log`，可能需要手动重启设备。

### Q: 解锁后仍无法写入分区？
A: 可能需要重启设备使内核完全释放资源。

## 适用系统

- Android 11+
- Android 12/12L/12R
- Android 13
- Android 14
- Android 15
- Android 16

## 免责声明

- 本模块仅供学习交流使用
- 使用本模块造成的任何后果由使用者自行承担
- 安装前请备份重要数据
- 在非支持设备上安装将被自动拒绝

## 更新日志

### v1.0.0 (2025.05.17)
- 初始版本发布
- 支持OPPO/OnePlus/Realme设备
- 自动化检测和修复功能
- 多级槽位检测机制
- 原生系统调用探测
