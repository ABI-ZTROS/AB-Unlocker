# A/B Partition Ghost Lock Unlocker - 项目落地草案

## 一、项目概述

本项目旨在解决Android A/B分区系统（特别是ColorOS/OnePlus设备）在OTA更新后可能出现的"幽灵锁死"问题，提供自动化的Magisk/KernelSU模块解决方案。

## 二、问题根因分析

### 技术背景
- **A/B无缝更新**：系统使用两个槽位（A/B），更新时写入未使用槽位，重启后切换
- **update_engine**：Android系统更新服务，以root权限运行，管理整个OTA流程
- **状态机问题**：OTA更新后，update_engine在快照合并阶段可能出现死锁或异常退出
- **资源泄漏**：
  - 未使用O_CLOEXEC标志，进程异常退出时文件描述符未被内核回收
  - 独占锁（O_EXCL）持续持有旧槽位分区
  - 持久化状态文件卡在中间状态（UpdatedNeedReboot/Finalizing）

### 故障现象
1. OTA更新后重启在第一屏卡顿40秒以上
2. dd命令写入旧槽位返回"Device or resource busy"
3. root权限无法解除锁
4. 本地OTA安装失败
5. 极端情况：相机、闪光灯等外设失效

## 三、项目结构

```
AB-Unlocker/
├── module.prop              # 模块配置文件
├── post-fs-data.sh          # 开机启动脚本
├── service.sh               # 核心检测与修复逻辑（改进版）
├── bootctl-helper.sh        # boot_control HAL辅助脚本
├── uninstall.sh             # 卸载清理脚本
└── README.md                # 用户文档
```

## 四、核心功能实现

### 1. 槽位检测机制（多层级fallback）
采用三级fallback机制，确保在各种环境下都能准确获取槽位信息：

**优先级1：内核调试接口（/d/slot_info）**
- 最可靠的数据来源
- 直接读取内核维护的槽位信息
- 不依赖Android框架层

**优先级2：内核命令行参数（/proc/cmdline）**
- Bootloader传递给内核的参数
- 包含androidboot.slot_suffix字段
- 在系统启动早期即可读取

**优先级3：系统属性（getprop）**
- Android框架层属性
- 由init进程设置
- 作为最后备选方案

**槽位信息持久化**
- 将槽位信息存储到`/data/local/tmp/ab_unlocker_last_slot`
- 开机时对比判断是否发生OTA切换
- 支持多级分区检测（boot、system、vendor、odm）

### 2. 锁死探测流程（原生系统调用）
使用Python调用Linux原生系统调用进行精确探测：

**Python os.open() 标志**
```python
os.open(partition, os.O_RDWR | os.O_EXCL | os.O_NOCTTY | os.O_NOFOLLOW)
```

- `O_RDWR`：以读写模式打开
- `O_EXCL`：独占模式，若文件已被占用则返回EBUSY
- `O_NOCTTY`：防止成为控制终端
- `O_NOFOLLOW`：防止符号链接攻击

**返回码分析**
- EBUSY (errno 16)：确认被锁死
- EACCES (errno 13)：权限不足
- 其他错误码：记录详细错误信息

**探测分区列表**
按照对系统影响程度依次探测：
1. boot（旧槽位的boot分区）
2. system（系统分区）
3. vendor（供应商分区）
4. odm（原始设计制造商分区）

任一分区检测到锁死即触发解锁流程

### 3. 自动解锁流程
```
1. 停止update_engine服务
2. 终止所有update_engine相关进程
3. 清除/data/misc/update_engine/*下的持久化状态
4. 再次验证解锁是否成功
```

### 4. 日志系统
- 完整记录每次运行的操作和结果
- 日志位置：`/data/local/tmp/ab_unlocker.log`
- 详细记录槽位检测来源和探测结果

## 五、技术要点

### 槽位检测的可靠性设计
1. **不依赖单一数据源**：三种检测方法互补，避免单点故障
2. **实时性保证**：优先使用内核级接口，确保数据最新
3. **Fallback机制**：任一方法失败时自动尝试下一个
4. **日志追踪**：明确记录使用哪种方法获取槽位

### 分区探测的安全性设计
1. **使用原生系统调用**：绕过shell层面的抽象，准确获取内核返回值
2. **多重标志保护**：O_EXCL + O_NOFOLLOW确保探测准确且安全
3. **详细错误码**：区分不同类型的锁死原因
4. **分区列表覆盖**：多分区检测确保不遗漏

### boot_control HAL集成
- 提供`bootctl`工具的封装脚本
- 支持查询当前槽位和所有槽位状态
- 作为补充数据源，增加可靠性

### Magisk模块生命周期
- 使用post-fs-data.sh在系统早期启动
- 延迟30秒确保系统服务就绪
- 后台运行service.sh避免阻塞启动

## 六、后续优化方向

### 短期计划
1. 添加更多分区的探测（dtbo、vbmeta等）
2. 支持用户配置自动修复选项
3. 添加通知栏提示修复结果
4. 集成到模块的GUI界面

### 长期规划
1. 增加对更多设备品牌的支持
2. 开发诊断工具，检测update_engine状态
3. 提供一键修复的独立APK
4. 收集社区反馈，优化解锁逻辑

## 七、发布计划

1. **Alpha版本**：内部测试，验证基本功能
2. **Beta版本**：小范围社区发布，收集反馈
3. **正式版v1.0**：GitHub公开仓库发布，完善文档

## 八、项目文件说明

- **module.prop**：定义模块ID、名称、版本、作者等元数据
- **post-fs-data.sh**：Magisk开机钩子，延迟启动主服务
- **service.sh**：核心业务逻辑，包含检测、解锁全过程（改进版）
- **bootctl-helper.sh**：boot_control HAL辅助脚本
- **uninstall.sh**：清理脚本，删除模块创建的持久化文件
- **README.md**：用户使用指南
- **PROJECT_DRAFT.md**：本文档，项目技术总结

## 九、参考资料

- AOSP update_engine源码
- Android A/B无缝更新官方文档
- Virtual A/B快照合并机制文档
- Android boot_control HAL文档
- Linux O_EXCL文件锁语义
- 社区复现案例与修复经验
