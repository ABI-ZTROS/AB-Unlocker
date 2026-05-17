# A/B Partition Ghost Lock Unlocker

> 专为 **ColorOS/OnePlus/Realme** 设备设计的A/B分区幽灵锁解锁器

---

## ⚠️ 重要提示

**本模块仅限满足以下条件的设备使用：**
- ✅ **OPPO ColorOS** 设备
- ✅ **OnePlus ColorOS/OxygenOS** 设备  
- ✅ **Realme UI** 设备
- ❌ 其他品牌设备将被**自动拒绝安装**

---

## 🔍 问题背景

在ColorOS/OnePlus设备进行大版本OTA更新后，可能出现以下**幽灵锁死**问题：

| 现象 | 说明 |
|------|------|
| 开机第一屏卡顿超过30秒 | OTA更新后首次启动异常 |
| 相机等外设无法使用 | 硬件服务被锁死状态影响 |
| `dd`命令刷写失败 | 提示"Device or resource busy" |
| root权限也无法解除 | 普通方法无效 |
| 本地OTA安装失败 | 无法进行后续更新 |

### 问题根源

1. **update_engine状态机异常**：OTA更新后，snapshot合并线程可能死锁
2. **资源泄漏**：进程异常退出时独占文件描述符(`O_EXCL`)未被回收
3. **持久化状态卡死**：状态文件停留在中间状态，无法自动恢复

### 技术细节

根据AOSP源码分析，问题出在以下位置：
- `delta_performer.cc` - 快照合并逻辑
- `snapshot_merge_performer.cc` - 合并状态管理
- `update_attempter.cc` - 更新尝试管理

Google代码缺陷：
- 缺少`O_CLOEXEC`标志
- `Cleanup()`存在不可达路径
- 信号处理不完整

---

## ✨ 模块功能

| 功能 | 描述 |
|------|------|
| **自动兼容性检测** | 安装时验证设备型号，不支持则拒绝安装 |
| **槽位切换检测** | 自动检测OTA更新后的槽位切换 |
| **锁死探测** | 使用原生系统调用精确探测分区锁死状态 |
| **自动解锁** | 自动执行解锁流程 |
| **WebUI界面** | KernelSU WebUI支持，可视化操作 |
| **完整日志** | 记录所有操作供排查 |
| **多数据源Fallback** | 不依赖第三方工具，使用系统底层接口 |

### 核心检测机制

**槽位检测（三级Fallback）：**
1. `/d/slot_info` - 内核调试接口（最可靠）
2. `/proc/cmdline` - 内核命令行参数
3. `getprop` - 系统属性（最后备选）

**分区锁死探测：**
使用Python原生系统调用 `os.open()` 配合 `O_EXCL` 标志精确判断

---

## 📋 使用条件

**必须同时满足以下条件才能使用：**

- [ ] 已完成OTA系统更新
- [ ] 更新过程中保留了Root权限
- [ ] 开机第一屏卡顿超过30秒
- [ ] 进入系统后发现相机无法使用

**禁止使用的情况：**
- ❌ 正常使用无异常
- ❌ 未进行OTA更新
- ❌ 开机正常，无卡顿
- ❌ 相机等外设正常工作
- ❌ 其他非A/B锁死问题

---

## 🚀 安装方法

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

### 安装流程

```
用户刷入模块
    ↓
设备兼容性检测
    ├→ 检测制造商（OPPO/OnePlus/Realme）
    ├→ 检测系统版本（ColorOS/OxygenOS/Realme UI）
    ├→ 验证Android版本（API 30+）
    └→ 检查SELinux状态
        ↓
兼容性判定
    ├→ 支持 → 继续安装
    └→ 不支持 → 显示错误，拒绝安装
        ↓
设置文件权限
        ↓
创建必要目录
        ↓
安装完成
```

---

## 🌐 WebUI 界面

模块支持KernelSU WebUI，提供可视化操作界面：

1. **使用指南确认** - 必须勾选所有使用条件才能继续
2. **系统诊断** - 显示检测到的异常（仅提示，不自动操作）
3. **分区状态检测** - 显示当前槽位和分区状态
4. **一键解锁** - 执行解锁流程
5. **日志查看** - 实时查看运行日志

---

## 📝 日志查看

模块运行日志保存在：`/data/local/tmp/ab_unlocker.log`

查看日志命令：
```bash
adb shell su -c "cat /data/local/tmp/ab_unlocker.log"
```

---

## 🔧 手动修复

如果模块无法自动修复，可以手动执行：

```bash
su
# 停止update_engine服务
stop update_engine
stop update_engine_client

# 终止残留进程
killall -9 update_engine
killall -9 update_engine_client

# 清除持久化状态
rm -rf /data/misc/update_engine/*

# 重启设备
reboot
```

---

## 💡 技术原理

### 解决方案

1. **停止update_engine服务**：阻止其继续持有锁
2. **终止残留进程**：释放内核文件描述符
3. **清除持久化状态**：重置状态机到初始状态
4. **验证解锁**：确认分区可写入

### 解锁流程

```
检测槽位切换
    ↓
探测分区锁死状态
    ↓
判定是否需要解锁
    ├→ 无需解锁 → 退出
    └→ 需要解锁 → 继续
        ↓
停止update_engine服务
        ↓
终止残留进程（带超时保护）
        ↓
清除状态文件
        ↓
验证解锁结果
        ↓
记录日志并退出
```

---

## ❓ 常见问题

### Q: 安装时提示设备不兼容怎么办？
A: 本模块专为ColorOS/OnePlus/Realme设备设计，其他设备无法安装。

### Q: 模块检测到锁死后没有自动解锁？
A: 检查日志文件 `/data/local/tmp/ab_unlocker.log`，可能需要手动重启设备。

### Q: 解锁后仍无法写入分区？
A: 可能需要重启设备使内核完全释放资源。

### Q: 相机仍然无法使用？
A: 尝试清除相机应用缓存，或重启设备。

### Q: WebUI无法访问？
A: 请确保已安装KernelSU并启用WebUI功能。

---

## 📱 适用系统

- Android 11+ (API 30+)
- Android 12/12L/12R
- Android 13
- Android 14
- Android 15
- Android 16

---

## 📄 免责声明

> **使用前请仔细阅读**

1. 本模块仅供学习交流使用
2. 使用本模块造成的任何后果由使用者自行承担
3. 安装前请备份重要数据
4. 在非支持设备上安装将被自动拒绝
5. 本模块不保证能解决所有问题
6. 作者不对使用本模块造成的任何损失负责

---

## 📅 更新日志

### v1.0.0 (2026.05.17)
- ✅ 初始版本发布
- ✅ 支持OPPO/OnePlus/Realme设备
- ✅ 自动化检测和修复功能
- ✅ 多级槽位检测机制
- ✅ 原生系统调用探测
- ✅ KernelSU WebUI支持
- ✅ 使用指南确认机制
- ✅ 系统诊断和警告提示

---

## 👨‍💻 作者

**周航航** (DevCloud.ZTR_OS)

- GitHub: [ABI-ZTROS](https://github.com/ABI-ZTROS)
- 项目地址: [AB-Unlocker](https://github.com/ABI-ZTROS/AB-Unlocker)

---

## 📧 反馈与支持

如有问题或建议，欢迎通过以下方式联系：

- GitHub Issues: [提交问题](https://github.com/ABI-ZTROS/AB-Unlocker/issues)
- 邮箱: CHINAHACK7399@126.COM

---

**⭐ 如果本项目对你有帮助，请给个Star支持！**

---

*本模块基于Android A/B分区机制研究，旨在帮助用户解决OTA更新后出现的分区锁死问题。*