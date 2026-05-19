# Root 权限也无法逾越的锁：ColorOS A/B 更新"幽灵锁死"问题的技术分析与解决方案

## 摘要

本文深入分析了 Android A/B（无缝）更新机制中的一个严重设计缺陷，该缺陷在已获取 root 权限且禁用 AVB 2.0 验证的 OnePlus/ColorOS 设备上表现为：OTA 更新完成后，旧插槽的块设备被内核以独占方式永久锁定，即使具有最高 root 权限也无法写入，同时系统功能可能出现异常（如相机无法启动、闪光灯失灵等）。本文从 AOSP 官方文档和源码层面全面剖析了问题根源：update_engine 守护进程在更新期间打开块设备时未使用 O_CLOEXEC 标志，导致进程异常退出后文件描述符未被正确释放，以及动态分区控制机制中未处理异常退出的情况。本文提供了完整的复现步骤、手动修复方案以及自动化 KernelSU 模块，并针对 AOSP 和 OEM 厂商提出了具体的代码修复建议。

**关键词**：Android；A/B 更新；update_engine；块设备锁；内核独占访问；ColorOS；OnePlus；虚拟 A/B；快照合并；文件描述符泄漏；O_CLOEXEC

---

## 作者与测试团队

**主要编写人**：周航航 (DevCloud.ZTR_OS)

**参与测试人员**：核糖体 (RFG_HTT)，C·L 枫汐，RFG_Cuik

**测试机型**：OnePlus ACE5，OnePlus 13，OnePlus ACE6 Kamisato Ayaka Linkage Model，OnePlus Pad Pro，OnePlus ACE5 Ultra

---

## 1 引言

Android 7.0 引入的 A/B 分区机制（Seamless Updates）旨在降低 OTA 更新后设备无法启动的风险 [1]。该机制将 boot、system、vendor、product、odm 等关键分区双份部署，系统在当前槽位运行时，update_engine 守护进程将更新写入备用槽位，完成后切换槽位重启。然而，本文揭示了该机制中的一个严重设计缺陷：当 update_engine 在更新期间异常退出时，会遗留未释放的块设备文件描述符，导致旧插槽被内核以独占方式永久锁定，即使具有 root 权限也无法写入。

该问题的特殊性在于：
1. **权限超越性**：内核块设备层的独占锁检查优先于 VFS 层的权限检查，即使是拥有 CAP_SYS_ADMIN 和 CAP_DAC_OVERRIDE 权限的 root 进程也无法绕过
2. **隐蔽性**：系统重启后看似正常工作，只有在尝试写入旧槽时才会发现问题
3. **不可逆性**：除非主动清理 update_engine 的持久化状态，否则锁死状态会永久存在

本文的贡献包括：
1. 对该缺陷进行了完整的技术剖析，基于 AOSP 官方文档和源码提供了确凿证据
2. 提供了 100% 可复现的故障复现步骤
3. 提出了手动修复方案和自动化 KernelSU 模块
4. 对 AOSP 源码中关键文件进行了逐句分析，指出了问题的根本原因
5. 针对 AOSP 和 OEM 厂商提出了具体的代码修复建议

### 1.1 适用范围与前提条件

本文描述的所有故障均发生在已刷机、获取 root 权限且禁用 AVB 2.0（dm-verity）的设备上，且目前已确认的案例仅限 OnePlus 机型或搭载 ColorOS 系统的设备。未刷机、未解锁 Bootloader 的普通用户暂未报告遭遇此问题，因为 dm-verity 会在检测到分区不一致时直接拒绝启动并回退到旧槽，从而避免了 update_engine 在异常状态下的退出。

---

## 2 相关工作

### 2.1 A/B 无缝更新机制概述

Android 官方文档对 A/B 系统更新的目标定义为 [1]："确保在无线下载 (OTA) 更新期间在磁盘上保留一个可正常启动和使用的系统，降低更新之后设备无法启动的可能性"。该机制的核心设计哲学是：系统从"当前"槽位运行，但在正常操作期间，运行中的系统不会访问未使用的槽位中的分区，从而将未使用的槽位保留为后备 [1]。

A/B 更新的核心守护进程是 update_engine，官方文档明确指出："A/B 系统更新使用称为 update_engine 的后台守护进程以及两组分区" [1]。update_engine 以 root 身份运行，拥有直接读写系统分区的最高权限 [2]。其主要职责包括：
- 下载 OTA 更新包
- 验证更新包的完整性和签名
- 将更新写入备用槽位
- 执行快照合并（Virtual A/B）
- 管理启动槽位切换

### 2.2 Virtual A/B 与快照机制

Virtual A/B 机制通过写时复制（COW）快照设备实现，官方文档定义了快照合并状态包括 NONE、UNKNOWN、SNAPSHOTTED、MERGING、CANCELLED [4]。在更新期间，对目标槽位的所有写入都会被重定向到 COW 设备，更新完成后执行快照合并，将差异数据合并回原始物理分区 [4]。

快照机制的核心组件包括：
- **dm-snapshot**：内核层的设备映射器模块，实现写时复制
- **COW 分区**：存储差异数据的临时分区
- **snapshotctl**：用户空间工具，用于管理快照设备

在快照合并阶段，update_engine 会执行合并操作，将 COW 分区中的数据逐块合并回原始物理分区。

### 2.3 update_engine 状态机

update_engine 内部维护严格的状态机，其流转路径为：Idle → CheckingForUpdate → UpdateAvailable → Downloading → Verifying → Finalizing → UpdatedNeedReboot → Idle [1]。在重启进入新系统后，update_engine 会调用 markBootSuccessful() 将新槽位标记为成功，然后进入 Idle 状态并释放旧槽资源 [1]。

状态机的每个状态都对应着 update_engine 的具体操作：
- **Idle**：空闲状态，等待更新请求
- **CheckingForUpdate**：检查是否有可用更新
- **UpdateAvailable**：发现可用更新
- **Downloading**：下载更新包
- **Verifying**：验证更新包的签名和完整性
- **Finalizing**：完成更新的最后阶段，包括快照合并
- **UpdatedNeedReboot**：更新完成，等待重启
- **Idle**：重启后，新槽位标记为成功，回到空闲状态

---

## 3 问题分析

### 3.1 故障现象

故障表现为以下特征：
1. OTA 更新完成后，设备重启进入新系统，一切功能看似正常
2. 尝试向旧插槽写入时，dd 命令返回 `Device or resource busy`
3. 本地 OTA 安装直接失败，无有效错误提示
4. 部分极端案例中，相机、闪光灯等外设可能无法正常工作
5. /proc/locks 文件中可能显示块设备被锁定

### 3.2 技术根源

通过对 dmesg 日志、/proc/*/fd 文件描述符表以及 update_engine 真实源码的分析，问题根源可归纳为：

#### 3.2.1 进程异常退出与资源泄漏

update_engine 在打开块设备时未使用 O_CLOEXEC 标志 [7]。当进程在更新阶段异常退出时，块设备的独占文件描述符可能无法被内核立即回收，导致旧槽分区被永久锁定。

Linux 内核中，一旦某个进程以独占方式打开块设备，内核块设备层会直接拒绝后续写入打开请求（返回 -EBUSY），该检查发生在 VFS 层，优先于一切权限检查，即使 root 也无法绕过。这一机制在 fs/block_dev.c 中的 bd_prepare_to_claim() 函数中实现。

#### 3.2.2 状态机设计缺陷

update_engine 的状态机缺乏超时与自愈机制。官方文档详尽描述了状态流转，但未提及任何超时处理或异常恢复逻辑 [1]。即使系统已在新槽位成功运行，只要持久化状态文件显示"更新未完成"，状态机就会拒绝新的更新请求并保持旧槽锁定。

持久化状态存储在 /data/misc/update_engine/ 目录下，包括：
- update_engine_status：记录当前状态机状态
- payload_state：记录更新包处理状态
- ... 其他状态文件

#### 3.2.3 快照合并不完整的连锁反应

在极端案例中，快照合并不完整导致 vendor、odm 等分区的驱动版本不一致，进而引发相机等外设失效。这是因为：
1. 现代 Android 设备的关键驱动散布在 vendor、odm、product 等多个分区
2. A/B 更新同样会复制这些分区
3. 快照合并不完整会导致新系统运行在"框架新、驱动旧"的割裂状态
4. 相机 HAL 层与内核驱动的版本不匹配会导致外设无法正常初始化

---

## 4 源码深度分析

本节将对 AOSP update_engine 中的关键源码文件进行逐句分析，揭示问题的根本原因。所有分析基于从清华大学 TUNA 镜像站下载的真实 AOSP 源码。

### 4.1 partition_writer.cc 源码分析

partition_writer.cc 是 update_engine 中负责打开和写入目标分区的核心模块。该文件中的 Init() 函数是打开块设备的关键位置。

#### 4.1.1 Init() 函数与 OpenFile() 函数分析

```cpp
// 摘自真实源码 partition_writer.cc 第 159-183 行
bool PartitionWriter::Init(const InstallPlan* install_plan,
                           bool source_may_exist,
                           size_t next_op_index) {
  // ... 前置代码 ...
  
  // 关键问题：打开块设备文件时未使用 O_CLOEXEC 标志
  int flags = O_RDWR;
  if (!interactive_)
    flags |= O_DSYNC;

  LOG(INFO) << "Opening " << target_path_ << " partition with"
            << (interactive_ ? "out" : "") << " O_DSYNC";

  target_fd_ = OpenFile(target_path_.c_str(), flags, true, &err);
  if (!target_fd_) {
    // ... 错误处理 ...
    return false;
  }
  
  // ... 后续代码 ...
}
```

```cpp
// 摘自真实源码 partition_writer.cc 第 85-107 行
FileDescriptorPtr OpenFile(const char* path,
                           int mode,
                           bool cache_writes,
                           int* err) {
  // ... 前置代码 ...
  
  FileDescriptorPtr fd(new EintrSafeFileDescriptor());
  if (cache_writes && !read_only) {
    fd = FileDescriptorPtr(new CachedFileDescriptor(fd, kCacheSize));
    LOG(INFO) << "Caching writes.";
  }
  // 关键调用：调用 FileDescriptor::Open()
  if (!fd->Open(path, mode, 000)) {
    *err = errno;
    PLOG(ERROR) << "Unable to open file " << path;
    return nullptr;
  }
  *err = 0;
  return fd;
}
```

**逐句分析**：

1. `int flags = O_RDWR;`
   - **问题**：仅使用 O_RDWR 标志，缺少 O_CLOEXEC
   - **后果**：文件描述符可能在进程意外退出时泄漏
   - **正确做法**：应该使用 `O_RDWR | O_CLOEXEC`

2. `if (!interactive_) flags |= O_DSYNC;`
   - 在非交互模式下添加 O_DSYNC 标志以确保数据同步写入
   - 但仍然没有 O_CLOEXEC

3. `target_fd_ = OpenFile(target_path_.c_str(), flags, true, &err);`
   - 调用 OpenFile() 函数打开块设备
   - 传入的 flags 只包含 O_RDWR 或 O_RDWR|O_DSYNC

4. `FileDescriptorPtr fd(new EintrSafeFileDescriptor());`
   - 创建 EintrSafeFileDescriptor 实例，该类封装了文件描述符操作
   - 提供 EINTR（被中断的系统调用）安全处理

5. `if (!fd->Open(path, mode, 000))`
   - 调用 FileDescriptor 抽象类的 Open 方法
   - 传入的 mode 仍然不包含 O_CLOEXEC

**总结**：partition_writer.cc 中的 Init() 函数是打开目标分区块设备的关键位置，其调用链为：Init() → OpenFile() → FileDescriptor::Open()，整个调用链中都没有添加 O_CLOEXEC 标志！

### 4.2 file_descriptor.cc 源码分析

file_descriptor.cc 实现了 FileDescriptor 抽象类的 EintrSafeFileDescriptor 具体实现，是最终调用 open() 系统调用的地方。

#### 4.2.1 EintrSafeFileDescriptor::Open() 函数分析

```cpp
// 摘自真实源码 file_descriptor.cc 第 37-56 行
bool EintrSafeFileDescriptor::Open(const char* path, int flags, mode_t mode) {
  CHECK_EQ(fd_, -1);
  // 关键问题：最终调用 open() 系统调用，但传入的 flags 不含 O_CLOEXEC
  return ((fd_ = HANDLE_EINTR(open(path, flags, mode))) >= 0);
}

bool EintrSafeFileDescriptor::Open(const char* path, int flags) {
  CHECK_EQ(fd_, -1);
  // 关键问题：同上，不含 O_CLOEXEC
  return ((fd_ = HANDLE_EINTR(open(path, flags))) >= 0);
}
```

**逐句分析**：

1. `HANDLE_EINTR(open(path, flags, mode))`
   - 使用 HANDLE_EINTR() 宏，该宏用于处理被信号中断的系统调用，会自动重试
   - 但传入的 flags 参数直接来自调用者，不包含 O_CLOEXEC
   - 如果在打开文件后，update_engine 进程崩溃或被信号终止，文件描述符可能不会被立即释放
   - 如果 update_engine 调用 fork() 创建子进程，文件描述符会被子进程继承
   - 即使父进程退出，子进程如果仍在运行，文件描述符会保持打开，导致块设备被锁定

2. **为什么需要 O_CLOEXEC？**
   - O_CLOEXEC（Close-on-Exec）标志的作用是在进程调用 exec() 执行新程序时自动关闭该文件描述符
   - 防止文件描述符泄漏到子进程
   - 即使不调用 exec()，设置 O_CLOEXEC 也是一个良好的安全实践

### 4.3 update_attempter_android.cc 源码分析

update_attempter_android.cc 是 Android 平台上 update_engine 的主要控制逻辑。好消息是，该文件中确实存在 ResetStatus() 公共方法！

#### 4.3.1 ResetStatus() 函数分析

```cpp
// 摘自真实源码 update_attempter_android.cc 第 504-551 行
bool UpdateAttempterAndroid::ResetStatus(Error* error) {
  LOG(INFO) << "Attempting to reset state from "
            << UpdateStatusToString(status_) << " to UpdateStatus::IDLE";
  if (processor_->IsRunning()) {
    return LogAndSetGenericError(
        error,
        __LINE__,
        __FILE__,
        "Already processing an update, cancel it first.");
  }
  if (status_ != UpdateStatus::IDLE &&
      status_ != UpdateStatus::UPDATED_NEED_REBOOT) {
    return LogAndSetGenericError(
        error,
        __LINE__,
        __FILE__,
        "Status reset not allowed in this state, please "
        "cancel on going OTA first.");
  }

  if (apex_handler_android_ != nullptr) {
    LOG(INFO) << "Cleaning up reserved space for compressed APEX (if any)";
    std::vector<ApexInfo> apex_infos_blank;
    apex_handler_android_->AllocateSpace(apex_infos_blank);
  }
  // Remove the reboot marker so that if the machine is rebooted
  // after resetting to idle state, it doesn't go back to
  // UpdateStatus::UPDATED_NEED_REBOOT state.
  if (!ClearUpdateCompletedMarker()) {
    return LogAndSetGenericError(error,
                                 __LINE__,
                                 __FILE__,
                                 "Failed to reset the status because "
                                 "ClearUpdateCompletedMarker() failed");
  }
  if (status_ == UpdateStatus::UPDATED_NEED_REBOOT) {
    if (!resetShouldSwitchSlotOnReboot(error)) {
      LOG(INFO) << "Failed to reset slot switch.";
      return false;
    }
    LOG(INFO) << "Slot switch reset successful";
  }
  // 关键调用：重置动态分区控制的更新状态
  if (!boot_control_->GetDynamicPartitionControl()->ResetUpdate(prefs_)) {
    LOG(WARNING) << "Failed to reset snapshots. UpdateStatus is IDLE but"
                 << "space might not be freed.";
  }
  return true;
}
```

**逐句分析**：

1. `ResetStatus()` 是公共方法！
   - **好消息**：该方法是公开的，可以被调用
   - 它接受 Error* 参数，用于返回错误信息

2. `if (!boot_control_->GetDynamicPartitionControl()->ResetUpdate(prefs_))`
   - 关键调用：重置动态分区控制的更新状态
   - 这会清理快照设备和相关资源
   - 如果失败，会记录警告但方法仍返回 true

3. `ClearUpdateCompletedMarker()`
   - 清理更新完成标记
   - 避免重启后错误地进入 UPDATED_NEED_REBOOT 状态

4. **限制**：
   - 仅在 IDLE 或 UPDATED_NEED_REBOOT 状态下允许调用
   - 如果 update_engine 正在处理更新（processor_->IsRunning()），则拒绝重置

### 4.4 总结：真实源码中的问题

通过对真实 AOSP 源码的分析，我们确认：

1. **问题 1**：partition_writer.cc 中的 Init() 函数打开块设备时，使用的 flags 仅包含 O_RDWR 或 O_RDWR|O_DSYNC，**确实没有** O_CLOEXEC
2. **问题 2**：file_descriptor.cc 中的 Open() 函数将 flags 原样传递给 open() 系统调用，不做任何修改
3. **好消息**：update_attempter_android.cc 中确实有 ResetStatus() 公共方法，它会调用 dynamic_partition_control 的 ResetUpdate() 方法

---

## 5 复现步骤

以下步骤可 100% 复现该故障：

| 步骤 | 操作 | 预期结果 | 实际结果 | 关键节点 |
|------|------|----------|----------|----------|
| 1 | 接收 ColorOS 大版本 OTA 推送，触发更新 | 系统下载全量包，写入未使用的插槽 | 更新开始，进度条前进 | 写入阶段 |
| 2 | 写入完成后，系统提示"需要重启以完成更新"，点击重启 | 设备重启，切换到新插槽并正常进入 | 设备在开机第一屏（OEM Logo）卡死超过 40 秒，随后进入新系统 | ⚠️ **关键预警**：第一屏卡顿超过 40 秒是铁证 |
| 3 | 进入新插槽后，尝试向旧插槽刷写镜像 | dd 命令正常写入 | dd 返回 `Device or resource busy` | 内核独占锁生效 |
| 4 | 尝试通过系统内本地安装 OTA 全量包 | 更新界面启动安装流程 | 安装直接失败 | 状态机拒绝新请求 |
| 5 | 执行 `rm -rf /data/misc/update_engine/*` 并 `killall update_engine` | 服务重启，旧槽恢复空闲 | 命令执行后，dd 成功写入 | 唯一修复路径 |

**复现风险警告**：如果在步骤 2 的重启过程中未观察到第一屏卡死超过 40 秒的现象，请立刻停止尝试。每一次无意义的复现都会消耗 eMMC/UFS 存储颗粒的写入寿命。

---

## 6 解决方案

### 6.1 手动修复方案

最简单且有效的修复方法是强制重置 update_engine 服务：

```bash
# 强制停止 update_engine 并清空其持久化状态
rm -rf /data/misc/update_engine/*
killall update_engine
```

执行上述命令后，内核会回收所有被占用的文件描述符，旧槽恢复可写状态。

针对相机等外设失效的极端案例，在重置更新服务后，需下载当前系统版本的官方全量包，重新刷入当前运行的插槽，以强制覆盖所有 vendor、odm 等分区，消除驱动不匹配问题。

### 6.2 自动化 KernelSU 模块

为实现自动化检测与修复，我们开发了一个 KernelSU 模块，其工作流程为：
1. 在每次开机时检测本次启动插槽与上次记录是否不同（发生了 OTA 切换）
2. 向未使用的旧插槽尝试写入 0 字节探测（打开 O_WRONLY 立即关闭）
3. 如果打开失败（返回 EBUSY），判定为幽灵锁死，立即重置 update_engine 服务

该模块轻量无侵入，仅在必要时执行。模块开源地址：https://github.com/ABI-ZTROS/AB-Unlocker

---

## 7 测试验证

### 7.1 测试环境

| 项目 | 配置 |
|------|------|
| 测试机型 | OnePlus ACE5, OnePlus 13, OnePlus ACE6 Kamisato Ayaka Linkage Model, OnePlus Pad Pro, OnePlus ACE5 Ultra |
| 系统版本 | ColorOS（类原生） |
| 状态 | 已解锁 Bootloader，已获取 root 权限，已禁用 AVB 2.0 |

### 7.2 测试结果

1. **故障复现测试**：所有测试机型均 100% 复现了旧槽锁定现象
2. **修复验证**：执行手动修复方案后，所有设备的旧槽均恢复可写状态
3. **极端案例修复**：对于相机失效的设备，重置更新服务并重刷当前版本官包后，所有外设恢复正常
4. **自动化模块测试**：KernelSU 模块在 50 次模拟 OTA 切换测试中均能正确检测并修复锁死问题
5. **OnePlus ACE5 专项测试**：该机型搭载骁龙 8 Gen 3 处理器，UFS 4.1 存储，测试结果表明锁死问题同样存在，且修复方案有效

---

## 8 深入技术分析

### 8.1 Linux 内核块设备独占锁机制

Linux 内核的块设备层实现了独占访问机制，其核心代码位于 fs/block_dev.c 中的 bd_prepare_to_claim() 函数：

```c
// 内核源码 fs/block_dev.c 中的关键逻辑
static int bd_prepare_to_claim(struct block_device *bdev,
                               struct block_device_holder *holder,
                               void *holder_id)
{
    // 检查是否已有进程独占该设备
    if (bdev->bd_holder && bdev->bd_holder != holder) {
        return -EBUSY;
    }
    
    // 标记设备为被当前持有者独占
    bdev->bd_holder = holder;
    bdev->bd_holder_id = holder_id;
    return 0;
}
```

**技术要点**：
- 该检查发生在 VFS 层的 open() 系统调用处理过程中
- 优先于文件权限检查，即使 root 也无法绕过
- 只有当持有独占锁的进程关闭所有文件描述符后，锁才会被释放

### 8.2 文件描述符继承与 O_CLOEXEC 标志

O_CLOEXEC 标志是 POSIX 标准中的一个文件描述符标志，其作用是在进程调用 exec() 执行新程序时自动关闭该文件描述符。

**文件描述符继承的工作原理**：
1. 当进程调用 fork() 创建子进程时，子进程会继承父进程的所有文件描述符
2. 如果父进程随后调用 exec() 执行新程序，默认情况下所有文件描述符都会保持打开状态
3. 设置了 O_CLOEXEC 标志的文件描述符会在 exec() 时被自动关闭

**O_CLOEXEC 的重要性**：
- 防止文件描述符泄漏到子进程
- 提高安全性，避免子进程访问不应访问的文件
- 确保资源在进程退出时能够被正确释放

### 8.3 Virtual A/B 快照合并的完整流程

Virtual A/B 快照合并的完整流程如下：
1. update_engine 下载更新包并写入 COW 设备
2. 系统重启到新槽位
3. update_engine 在新槽位启动，检测到快照需要合并
4. 开始执行合并操作
5. 逐块将 COW 设备中的数据合并回原始物理分区
6. 合并完成后，释放快照设备，清理资源
7. update_engine 调用 markBootSuccessful() 标记启动成功

**异常情况下的流程**：
1. 步骤 4 或 5 中，update_engine 异常退出
2. 快照设备可能未被释放，块设备文件描述符可能未被关闭
3. 内核保持独占锁
4. 旧槽无法写入

---

## 9 结论与建议

### 9.1 结论

本文完整剖析了 Android A/B 更新机制中的一个严重缺陷：update_engine 在更新期间异常退出会导致旧槽分区被永久锁定。该缺陷根植于 AOSP 的 update_engine 实现，具体表现为：
1. 未使用 O_CLOEXEC 标志导致文件描述符泄漏（已通过真实源码验证）
2. 状态机缺乏超时与自愈机制
3. 快照合并失败后缺乏自动清理机制
4. ResetStatus() 方法虽然存在，但使用场景有限制

### 9.2 对 AOSP 的修复建议

我们建议 Google 在 AOSP 中实施以下修复：

1. **资源管理改进**：
   - 在 partition_writer.cc 的 Init() 函数中，为打开块设备添加 O_CLOEXEC 标志：
     ```cpp
     int flags = O_RDWR | O_CLOEXEC;  // 添加 O_CLOEXEC
     if (!interactive_)
       flags |= O_DSYNC;
     ```
   - 或者在 file_descriptor.cc 的 EintrSafeFileDescriptor::Open() 函数中，自动为所有打开操作添加 O_CLOEXEC：
     ```cpp
     bool EintrSafeFileDescriptor::Open(const char* path, int flags, mode_t mode) {
       CHECK_EQ(fd_, -1);
       // 自动添加 O_CLOEXEC 标志
       return ((fd_ = HANDLE_EINTR(open(path, flags | O_CLOEXEC, mode))) >= 0);
     }
     ```
   - 使用 RAII 模式管理文件描述符和其他资源

2. **状态机增强**：
   - 在 update_engine 启动时，若检测到系统已从新插槽成功运行（boot_successful = true），则无条件释放旧插槽资源
   - 为状态机添加超时机制，避免长时间卡在某个状态

3. **文档完善**：
   - 在官方文档中增加"异常恢复"章节，说明可能出现的资源锁死问题及其解决方案
   - 更新开发者指南，强调使用 O_CLOEXEC 标志的重要性

### 9.3 对 OEM 厂商的建议

针对 OEM 厂商（特别是 ColorOS 团队），我们建议：
1. 在系统设置的"软件更新"页面显示明确的 update_engine 状态提示
2. 提供"重置更新状态"的官方选项
3. 在开机自检阶段主动检测分区一致性，发现问题时提示用户执行修复
4. 在官方社区和售后知识库中加入此类问题的排查指南
5. 考虑在系统更新失败时自动调用 ResetStatus() 方法

---

## 参考文献

[1] A/B（无缝）系统更新 - Android 开源项目官方文档  
    https://source.android.google.cn/docs/core/ota/ab  
    https://source.android.com/docs/core/ota/ab (英文版)

[2] update_engine.rc 源码 - AOSP system/update_engine/init/  
    https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/init/update_engine.rc

[3] boot_control HAL - Android 开源项目官方文档  
    https://source.android.google.cn/docs/core/ota/boot_control  
    https://source.android.com/docs/core/ota/boot_control (英文版)

[4] Virtual A/B 概览 - Android 开源项目官方文档  
    https://source.android.google.cn/docs/core/ota/virtual_ab  
    https://source.android.com/docs/core/ota/virtual_ab (英文版)

[5] AOSP update_engine 源码仓库（清华大学 TUNA 镜像）  
    https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/system/update_engine/

[6] partition_writer.cc 源码 - AOSP system/update_engine/payload_consumer/partition_writer.cc  
    https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/payload_consumer/partition_writer.cc  
    关键问题：Init() 函数打开块设备时未使用 O_CLOEXEC

[7] file_descriptor.cc 源码 - AOSP system/update_engine/payload_consumer/file_descriptor.cc  
    https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/payload_consumer/file_descriptor.cc  
    关键问题：Open() 函数将 flags 原样传递给 open()，不添加 O_CLOEXEC

[8] update_attempter_android.cc 源码 - AOSP system/update_engine/aosp/update_attempter_android.cc  
    https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/aosp/update_attempter_android.cc  
    关键函数：ResetStatus() 公共方法存在，但有限制条件

[9] Linux 内核源码 fs/block_dev.c  
    https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/block_dev.c  
    关键函数：bd_prepare_to_claim() 实现块设备独占锁机制

---

## 免责声明

本文所剖析的一切现象，均为在已解锁、已 root 并禁用 AVB 验证的设备上进行非常规操作后的衍生产物。未刷机、Bootloader 锁定的普通用户遇到此问题的概率极低，因为 dm-verity 会在分区不一致时直接拒绝启动并回退到旧槽。

如果你使用其他品牌的 A/B 设备且遇到类似症状，请谨慎参考本文，不要轻率归因。目前我们仅在 OnePlus/ColorOS 平台收集到确凿案例。

---

## 项目地址

完整案例复现、模块源码及更多技术细节，尽在 GitHub 仓库：  
https://github.com/ABI-ZTROS/AB-Unlocker
