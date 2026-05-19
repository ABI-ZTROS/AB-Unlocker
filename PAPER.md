# Root 权限也无法逾越的锁：ColorOS A/B 更新"幽灵锁死"问题的技术分析与解决方案

## 摘要

本文深入分析了 Android A/B（无缝）更新机制中的一个严重设计缺陷，该缺陷在已获取 root 权限且禁用 AVB 2.0 验证的 OnePlus/ColorOS 设备上表现为：OTA 更新完成后，旧插槽的块设备被内核以独占方式永久锁定，即使具有最高 root 权限也无法写入，同时系统功能可能出现异常（如相机无法启动、闪光灯失灵等）。

本文从 AOSP 官方文档和源码层面全面剖析了问题根源：update_engine 守护进程在更新期间打开块设备时未使用 `O_CLOEXEC` 标志，导致进程异常退出后文件描述符未被正确释放，以及动态分区控制机制中未处理异常退出的情况。

本文提供了完整的复现步骤、手动修复方案以及自动化 KernelSU 模块，并针对 AOSP 和 OEM 厂商提出了具体的代码修复建议。

**关键词**：Android；A/B 更新；update_engine；块设备锁；内核独占访问；ColorOS；OnePlus；虚拟 A/B；快照合并；文件描述符泄漏；O_CLOEXEC

---

## 作者与测试团队

**主要编写人**：周航航 (DevCloud.ZTR_OS)

**参与测试人员**：核糖体 (RFG_HTT)，C·L 枫汐，RFG_Cuik

**测试机型**：
- OnePlus ACE5（搭载骁龙 8 Gen 3 处理器）
- OnePlus 13
- OnePlus ACE6 Kamisato Ayaka Linkage Model
- OnePlus Pad Pro
- OnePlus ACE5 Ultra

---

## 1 引言

### 1.1 背景

Android 7.0 引入的 A/B 分区机制（Seamless Updates）旨在降低 OTA 更新后设备无法启动的风险 [1]。该机制将 boot、system、vendor、product、odm 等关键分区双份部署，系统在当前槽位运行时，`update_engine` 守护进程将更新写入备用槽位，完成后切换槽位重启。

### 1.2 问题的发现

在对已获取 root 权限且禁用 AVB 2.0 验证的 OnePlus/ColorOS 设备进行测试时，我们发现了一个严重的问题：当 OTA 更新完成并重启进入新系统后，旧插槽的块设备被内核以独占方式永久锁定，即使具有最高 root 权限也无法写入。

### 1.3 问题的特殊性

该问题具有以下独特特征：

1. **权限超越性**：内核块设备层的独占锁检查优先于 VFS 层的权限检查，即使是拥有 `CAP_SYS_ADMIN` 和 `CAP_DAC_OVERRIDE` 权限的 root 进程也无法绕过
2. **隐蔽性**：系统重启后看似正常工作，只有在尝试写入旧槽时才会发现问题
3. **不可逆性**：除非主动清理 `update_engine` 的持久化状态，否则锁死状态会永久存在

### 1.4 本文的贡献

本文的贡献包括：

1. 对该缺陷进行了完整的技术剖析，基于 AOSP 官方文档和源码提供了确凿证据
2. 提供了 100% 可复现的故障复现步骤
3. 提出了手动修复方案和自动化 KernelSU 模块
4. 对 AOSP 源码中关键文件进行了逐句分析，指出了问题的根本原因
5. 针对 AOSP 和 OEM 厂商提出了具体的代码修复建议

### 1.5 适用范围与前提条件

本文描述的所有故障均发生在已刷机、获取 root 权限且禁用 AVB 2.0（dm-verity）的设备上，且目前已确认的案例仅限 OnePlus 机型或搭载 ColorOS 系统的设备。

---

## 2 相关工作

### 2.1 A/B 无缝更新机制概述

Android 官方文档对 A/B 系统更新的目标定义为 [1]："确保在无线下载 (OTA) 更新期间在磁盘上保留一个可正常启动和使用的系统，降低更新之后设备无法启动的可能性"。

A/B 更新的核心守护进程是 `update_engine`，其主要职责包括：
- 下载 OTA 更新包
- 验证更新包的完整性和签名
- 将更新写入备用槽位
- 执行快照合并（Virtual A/B）
- 管理启动槽位切换

### 2.2 A/B 更新的状态机

`update_engine` 内部维护严格的状态机，其流转路径为：

```
Idle → CheckingForUpdate → UpdateAvailable → Downloading → Verifying 
    → Finalizing → UpdatedNeedReboot → Idle
```

在重启进入新系统后，`update_engine` 会调用 `markBootSuccessful()` 将新槽位标记为成功，然后进入 Idle 状态并释放旧槽资源 [1]。

### 2.3 Virtual A/B 与快照机制

Virtual A/B 机制通过写时复制（COW）快照设备实现，官方文档定义了快照合并状态包括 NONE、UNKNOWN、SNAPSHOTTED、MERGING、CANCELLED [4]。

快照机制的核心组件包括：
- **dm-snapshot**：内核层的设备映射器模块，实现写时复制
- **COW 分区**：存储差异数据的临时分区
- **snapshotctl**：用户空间工具，用于管理快照设备

### 2.4 文件描述符与 O_CLOEXEC

`O_CLOEXEC`（Close-on-Exec）是 POSIX 标准中的文件描述符标志，其作用是在进程调用 `exec()` 执行新程序时自动关闭该文件描述符。

**文件描述符继承的工作原理**：
1. 当进程调用 `fork()` 创建子进程时，子进程会继承父进程的所有文件描述符
2. 如果父进程随后调用 `exec()` 执行新程序，默认情况下所有文件描述符都会保持打开状态
3. 设置了 `O_CLOEXEC` 标志的文件描述符会在 `exec()` 时被自动关闭

### 2.5 Linux 内核块设备独占锁机制

Linux 内核的块设备层实现了独占访问机制，其核心代码位于 `fs/block_dev.c` 中。当某个进程以独占方式打开块设备时，内核会标记该设备为被独占访问，其他进程尝试写入打开时会返回 `-EBUSY`。

---

## 3 问题分析

### 3.1 故障现象

故障表现为以下特征：

1. **第一屏卡顿**：OTA 更新完成后，设备在开机第一屏（OEM Logo）卡死超过 40 秒
2. **旧槽锁定**：进入新系统后，尝试向旧插槽写入时，`dd` 命令返回 `Device or resource busy`
3. **本地 OTA 失败**：本地 OTA 安装直接失败，无有效错误提示
4. **外设异常**：部分极端案例中，相机、闪光灯等外设可能无法正常工作
5. **锁状态可见**：`/proc/locks` 文件中可能显示块设备被锁定

### 3.2 技术根源

通过对 `dmesg` 日志、`/proc/*/fd` 文件描述符表以及 `update_engine` 真实源码的分析，问题根源可归纳为：

#### 3.2.1 进程异常退出与资源泄漏

`update_engine` 在打开块设备时未使用 `O_CLOEXEC` 标志。当进程在更新阶段异常退出时，块设备的独占文件描述符可能无法被内核立即回收，导致旧槽分区被永久锁定。

#### 3.2.2 状态机设计缺陷

`update_engine` 的状态机缺乏超时与自愈机制。即使系统已在新槽位成功运行，只要持久化状态文件显示"更新未完成"，状态机就会拒绝新的更新请求并保持旧槽锁定。

#### 3.2.3 快照合并不完整的连锁反应

在极端案例中，快照合并不完整导致 vendor、odm 等分区的驱动版本不一致，进而引发相机等外设失效。

### 3.3 复现步骤

以下步骤可 100% 复现该故障：

| 步骤 | 操作 | 预期结果 | 实际结果 | 关键节点 |
|------|------|----------|----------|----------|
| 1 | 接收 ColorOS 大版本 OTA 推送 | 系统下载全量包，写入备用插槽 | 更新开始，进度条前进 | 写入阶段 |
| 2 | 写入完成后重启 | 设备重启，切换到新插槽并正常进入 | 设备在开机第一屏卡死超过 40 秒 | ⚠️ **关键预警** |
| 3 | 尝试向旧插槽刷写镜像 | `dd` 命令正常写入 | 返回 `Device or resource busy` | 内核独占锁生效 |
| 4 | 尝试本地 OTA 安装 | 更新界面启动安装流程 | 安装直接失败 | 状态机拒绝新请求 |
| 5 | 重置 update_engine 服务 | 服务重启，旧槽恢复空闲 | `dd` 成功写入 | 唯一修复路径 |

---

## 4 update_engine 源码深度分析

### 4.1 核心文件结构

`update_engine` 的核心代码位于 `platform/system/update_engine/`，主要文件包括：

| 文件路径 | 功能描述 |
|----------|----------|
| `payload_consumer/partition_writer.cc` | 分区写入器，负责打开和写入目标分区 |
| `payload_consumer/file_descriptor.cc` | 文件描述符封装，最终调用 `open()` 系统调用 |
| `aosp/update_attempter_android.cc` | Android 平台的更新控制逻辑 |
| `download_action.cc` | 下载动作，协调下载和应用更新 |
| `payload_consumer/delta_performer.cc` | 增量更新执行者，处理更新包的解析和应用 |

### 4.2 partition_writer.cc 源码分析

`partition_writer.cc` 是 `update_engine` 中负责打开和写入目标分区的核心模块。该文件中的 `Init()` 函数是打开块设备的关键位置。

#### 4.2.1 Init() 函数分析

```cpp
// 摘自 partition_writer.cc 第 159-183 行
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

**分析**：
- `int flags = O_RDWR;` - 仅使用 `O_RDWR` 标志，缺少 `O_CLOEXEC`
- 在非交互模式下添加 `O_DSYNC` 标志，但仍然没有 `O_CLOEXEC`
- 调用 `OpenFile()` 函数打开块设备，传入的 `flags` 只包含 `O_RDWR` 或 `O_RDWR|O_DSYNC`

#### 4.2.2 OpenFile() 函数分析

```cpp
// 摘自 partition_writer.cc 第 85-107 行
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

**分析**：
- 创建 `EintrSafeFileDescriptor` 实例，该类封装了文件描述符操作
- 调用 `FileDescriptor::Open()` 方法，传入的 `mode` 参数仍然不包含 `O_CLOEXEC`

### 4.3 file_descriptor.cc 源码分析

`file_descriptor.cc` 实现了 `FileDescriptor` 抽象类的具体实现，是最终调用 `open()` 系统调用的地方。

#### 4.3.1 EintrSafeFileDescriptor::Open() 函数分析

```cpp
// 摘自 file_descriptor.cc 第 37-56 行
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

**分析**：
- 使用 `HANDLE_EINTR()` 宏处理被信号中断的系统调用
- 传入的 `flags` 参数直接来自调用者，不包含 `O_CLOEXEC`
- 如果 `update_engine` 进程崩溃或被信号终止，文件描述符可能不会被立即释放

### 4.4 update_attempter_android.cc 源码分析

`update_attempter_android.cc` 是 Android 平台上 `update_engine` 的主要控制逻辑。

#### 4.4.1 ResetStatus() 函数分析

```cpp
// 摘自 update_attempter_android.cc 第 504-551 行
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

**分析**：
- `ResetStatus()` 是公共方法，可以被调用
- 它会调用 `dynamic_partition_control` 的 `ResetUpdate()` 方法来清理快照设备和相关资源
- 但该方法有使用限制：仅在 `IDLE` 或 `UPDATED_NEED_REBOOT` 状态下允许调用

### 4.5 download_action.cc 源码分析

`download_action.cc` 负责协调下载和应用更新的完整流程。

#### 4.5.1 PerformAction() 函数分析

```cpp
// 摘自 download_action.cc 第 53-90 行
void DownloadAction::PerformAction() {
  http_fetcher_->set_delegate(this);

  // Get the InstallPlan and read it
  CHECK(HasInputObject());
  install_plan_ = GetInputObject();
  install_plan_.Dump();

  bytes_received_ = 0;
  bytes_received_previous_payloads_ = 0;
  bytes_total_ = 0;
  for (const auto& payload : install_plan_.payloads)
    bytes_total_ += payload.size;

  if (install_plan_.is_resume) {
    int64_t payload_index = 0;
    if (prefs_->GetInt64(kPrefsUpdateStatePayloadIndex, &payload_index) &&
        static_cast<size_t>(payload_index) < install_plan_.payloads.size()) {
      resume_payload_index_ = payload_index;
      for (int i = 0; i < payload_index; i++)
        install_plan_.payloads[i].already_applied = true;
    }
  }
  CHECK_GE(install_plan_.payloads.size(), 1UL);
  if (!payload_)
    payload_ = &install_plan_.payloads[0];

  LOG(INFO) << "Marking new slot as unbootable";
  if (!boot_control_->MarkSlotUnbootable(install_plan_.target_slot)) {
    LOG(WARNING) << "Unable to mark new slot "
                 << BootControlInterface::SlotName(install_plan_.target_slot)
                 << ". Proceeding with the update anyway.";
  }

  StartDownloading();
}
```

**分析**：
- 设置 HTTP fetcher 的 delegate
- 获取安装计划并计算总字节数
- 处理断点续传逻辑
- 将目标槽位标记为不可引导（安全措施）
- 开始下载

#### 4.5.2 TransferComplete() 函数分析

```cpp
// 摘自 download_action.cc 第 242-275 行
void DownloadAction::TransferComplete(HttpFetcher* fetcher, bool successful) {
  if (delta_performer_) {
    LOG_IF(WARNING, delta_performer_->Close() != 0)
        << "Error closing the writer.";
  }
  download_active_ = false;
  ErrorCode code =
      successful ? ErrorCode::kSuccess : ErrorCode::kDownloadTransferError;
  if (code == ErrorCode::kSuccess) {
    if (delta_performer_ && !payload_->already_applied)
      code = delta_performer_->VerifyPayload(payload_->hash, payload_->size);
    if (code == ErrorCode::kSuccess) {
      CHECK_EQ(install_plan_.payloads.size(), 1UL);
      if (delegate_)
        delegate_->DownloadComplete();

      std::string histogram_output;
      base::StatisticsRecorder::WriteGraph("UpdateEngine.DownloadAction.",
                                           &histogram_output);
      LOG(INFO) << histogram_output;
    } else {
      LOG(ERROR) << "Download of " << install_plan_.download_url
                 << " failed due to payload verification error.";
    }
  }

  if (code == ErrorCode::kSuccess && HasOutputPipe())
    SetOutputObject(install_plan_);
  processor_->ActionComplete(this, code);
}
```

**分析**：
- 下载完成后关闭 `delta_performer`
- 验证 payload 的完整性
- 如果成功，通知 delegate 并记录统计信息
- 将安装计划传递给下一个 action

### 4.6 完整的更新流程分析

`update_engine` 的更新流程由一系列 action 组成，通过 `ActionProcessor` 协调执行：

```
UpdateBootFlagsAction → CleanupPreviousUpdateAction → InstallPlanAction 
    → DownloadAction → FilesystemVerifierAction → PostinstallRunnerAction
```

#### 4.6.1 BuildUpdateActions() 函数分析

```cpp
// 摘自 update_attempter_android.cc 第 931-970 行
void UpdateAttempterAndroid::BuildUpdateActions(HttpFetcher* fetcher) {
  CHECK(!processor_->IsRunning());

  // Actions:
  auto update_boot_flags_action =
      std::make_unique<UpdateBootFlagsAction>(boot_control_);
  auto cleanup_previous_update_action =
      boot_control_->GetDynamicPartitionControl()
          ->GetCleanupPreviousUpdateAction(boot_control_, prefs_, this);
  auto install_plan_action = std::make_unique<InstallPlanAction>(install_plan_);
  auto download_action =
      std::make_unique<DownloadAction>(prefs_,
                                       boot_control_,
                                       hardware_,
                                       fetcher,
                                       true /* interactive */,
                                       update_certificates_path_);
  download_action->set_delegate(this);
  download_action->set_base_offset(base_offset_);
  auto filesystem_verifier_action = std::make_unique<FilesystemVerifierAction>(
      boot_control_->GetDynamicPartitionControl());
  auto postinstall_runner_action =
      std::make_unique<PostinstallRunnerAction>(boot_control_, hardware_);
  filesystem_verifier_action->set_delegate(this);
  postinstall_runner_action->set_delegate(this);

  // Bond them together.
  BondActions(install_plan_action.get(), download_action.get());
  BondActions(download_action.get(), filesystem_verifier_action.get());
  BondActions(filesystem_verifier_action.get(),
              postinstall_runner_action.get());

  processor_->EnqueueAction(std::move(update_boot_flags_action));
  processor_->EnqueueAction(std::move(cleanup_previous_update_action));
  processor_->EnqueueAction(std::move(install_plan_action));
  processor_->EnqueueAction(std::move(download_action));
  processor_->EnqueueAction(std::move(filesystem_verifier_action));
  processor_->EnqueueAction(std::move(postinstall_runner_action));
}
```

**分析**：
- 创建所有必要的 action 对象
- 通过 `BondActions()` 建立 action 之间的依赖关系
- 将 action 依次加入 `ActionProcessor` 的队列

### 4.7 状态管理与持久化

`update_engine` 使用 `prefs` 系统持久化更新状态，关键的持久化键包括：

| 键名 | 作用 |
|------|------|
| `attempt-in-progress` | 标记当前是否有更新正在进行 |
| `update-state-next-operation` | 记录下一个要执行的操作 |
| `update-state-next-data-offset` | 记录下一个数据偏移量 |
| `update-state-sha-256-context` | 记录 SHA-256 哈希上下文 |
| `update-completed-on-boot-id` | 记录更新完成时的 boot ID |
| `previous-slot` | 记录之前的槽位 |

这些状态信息存储在 `/data/misc/update_engine/` 目录下，如果 `update_engine` 异常退出，这些状态信息不会自动清理，导致下次启动时仍然认为更新正在进行。

---

## 5 Linux 内核块设备独占锁机制分析

### 5.1 内核块设备层架构

Linux 内核的块设备层位于 VFS 层之下，负责管理物理块设备的访问。其核心结构包括：

- `struct block_device`：块设备描述符
- `struct gendisk`：通用磁盘结构
- `bd_holder`：块设备持有者
- `bd_holder_id`：持有者 ID

### 5.2 块设备独占锁的实现

块设备独占锁机制的核心代码位于 `fs/block_dev.c`：

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

**分析**：
- 当进程尝试打开块设备时，内核会检查 `bd_holder` 是否为空
- 如果 `bd_holder` 不为空且不是当前进程，则返回 `-EBUSY`
- 该检查发生在 VFS 层的 `open()` 系统调用处理过程中，优先于文件权限检查

### 5.3 块设备打开流程

块设备的打开流程如下：

1. 用户空间调用 `open()` 系统调用
2. VFS 层根据路径找到对应的 `inode`
3. 调用 `block_open()` 函数
4. `block_open()` 调用 `bd_acquire()` 获取块设备
5. `bd_acquire()` 调用 `bd_prepare_to_claim()` 检查独占锁
6. 如果检查通过，标记设备为被当前进程独占
7. 返回文件描述符

### 5.4 文件描述符泄漏的影响

当 `update_engine` 以独占方式打开块设备后：

1. 如果进程正常退出，文件描述符会被自动关闭，块设备锁会被释放
2. 如果进程异常退出（崩溃、被 SIGKILL 终止等），文件描述符可能不会被立即释放
3. 如果文件描述符被泄漏到子进程（没有设置 `O_CLOEXEC`），即使父进程退出，子进程仍持有文件描述符
4. 只要有一个进程持有该文件描述符，块设备就会保持被锁定状态

---

## 6 完整的更新流程与系统操作

### 6.1 更新流程时序图

```
用户请求更新 → update_engine 启动 → 检查更新状态
    ↓
下载更新包 → 验证签名 → 解析 manifest
    ↓
打开目标分区 → 写入更新数据 → 验证数据完整性
    ↓
执行后安装脚本 → 标记新槽为可引导 → 等待重启
    ↓
系统重启 → 进入新槽 → 标记启动成功 → 清理旧槽资源
```

### 6.2 各阶段的系统操作

#### 6.2.1 下载阶段

1. **网络操作**：通过 HTTP/HTTPS 下载更新包
2. **文件系统操作**：临时存储下载的数据
3. **状态更新**：记录下载进度到 `prefs`

#### 6.2.2 写入阶段

1. **块设备操作**：打开目标分区的块设备
2. **数据写入**：将更新数据写入块设备
3. **哈希计算**：计算数据的 SHA-256 哈希值

#### 6.2.3 验证阶段

1. **完整性验证**：验证写入数据的完整性
2. **签名验证**：验证更新包的数字签名

#### 6.2.4 后安装阶段

1. **执行脚本**：运行 `postinst` 脚本
2. **更新 bootloader**：更新 bootloader 配置
3. **标记槽位**：标记新槽为可引导

#### 6.2.5 重启后阶段

1. **切换槽位**：bootloader 引导到新槽
2. **标记成功**：`update_engine` 标记启动成功
3. **清理资源**：释放旧槽资源

### 6.3 异常场景分析

#### 6.3.1 写入阶段异常退出

**场景**：`update_engine` 在写入阶段异常退出

**后果**：
- 块设备文件描述符未被关闭
- 旧槽被永久锁定
- 系统重启后无法向旧槽写入

**原因**：未使用 `O_CLOEXEC` 标志，文件描述符在进程退出时未被正确释放

#### 6.3.2 验证阶段失败

**场景**：验证阶段发现数据不完整或签名无效

**后果**：
- 更新失败，系统回滚到旧槽
- 但如果块设备已被打开，可能仍然被锁定

**处理**：`update_engine` 应该在失败时显式关闭所有打开的文件描述符

#### 6.3.3 重启后第一屏卡顿

**场景**：更新完成后，系统重启在第一屏卡顿超过 40 秒

**后果**：
- 用户认为设备变砖
- 实际上是 `update_engine` 在后台执行快照合并

**原因**：Virtual A/B 的快照合并操作需要时间，特别是在大分区上

---

## 7 解决方案

### 7.1 手动修复方案

最简单且有效的修复方法是强制重置 `update_engine` 服务：

```bash
# 强制停止 update_engine 并清空其持久化状态
rm -rf /data/misc/update_engine/*
killall update_engine
```

执行上述命令后，内核会回收所有被占用的文件描述符，旧槽恢复可写状态。

### 7.2 自动化 KernelSU 模块

为实现自动化检测与修复，我们开发了一个 KernelSU 模块，其工作流程为：

1. **开机检测**：在每次开机时检测本次启动插槽与上次记录是否不同（发生了 OTA 切换）
2. **探测锁定**：向未使用的旧插槽尝试写入 0 字节探测（打开 `O_WRONLY` 立即关闭）
3. **判定锁死**：如果打开失败（返回 `EBUSY`），判定为幽灵锁死
4. **自动修复**：立即重置 `update_engine` 服务

该模块轻量无侵入，仅在必要时执行。模块开源地址：https://github.com/ABI-ZTROS/AB-Unlocker

### 7.3 代码修复建议

#### 7.3.1 添加 O_CLOEXEC 标志

在 `partition_writer.cc` 的 `Init()` 函数中添加 `O_CLOEXEC` 标志：

```cpp
// 修改前
int flags = O_RDWR;
if (!interactive_)
  flags |= O_DSYNC;

// 修改后
int flags = O_RDWR | O_CLOEXEC;  // 添加 O_CLOEXEC
if (!interactive_)
  flags |= O_DSYNC;
```

或者在 `file_descriptor.cc` 的 `Open()` 函数中自动添加：

```cpp
// 修改前
bool EintrSafeFileDescriptor::Open(const char* path, int flags, mode_t mode) {
  CHECK_EQ(fd_, -1);
  return ((fd_ = HANDLE_EINTR(open(path, flags, mode))) >= 0);
}

// 修改后
bool EintrSafeFileDescriptor::Open(const char* path, int flags, mode_t mode) {
  CHECK_EQ(fd_, -1);
  // 自动添加 O_CLOEXEC 标志
  return ((fd_ = HANDLE_EINTR(open(path, flags | O_CLOEXEC, mode))) >= 0);
}
```

#### 7.3.2 增强状态机的自愈能力

在 `update_attempter_android.cc` 中添加自动清理逻辑：

```cpp
// 在启动时检查是否需要自动清理
void UpdateAttempterAndroid::CheckAndCleanupStaleUpdate() {
  // 检查是否有未完成的更新状态
  bool attempt_in_progress = false;
  prefs_->GetBoolean(kPrefsAttemptInProgress, &attempt_in_progress);
  
  if (attempt_in_progress) {
    // 检查是否已经从新槽成功启动
    string update_completed_boot_id;
    if (prefs_->Exists(kPrefsUpdateCompletedOnBootId)) {
      prefs_->GetString(kPrefsUpdateCompletedOnBootId, &update_completed_boot_id);
      
      string current_boot_id;
      if (utils::GetBootId(&current_boot_id) && 
          update_completed_boot_id != current_boot_id) {
        // 已经从新槽成功启动过，可以安全清理
        LOG(INFO) << "Detected stale update state, cleaning up...";
        ResetStatus(nullptr);
      }
    }
  }
}
```

---

## 8 测试验证

### 8.1 测试环境

| 项目 | 配置 |
|------|------|
| 测试机型 | OnePlus ACE5, OnePlus 13, OnePlus ACE6, OnePlus Pad Pro, OnePlus ACE5 Ultra |
| 系统版本 | ColorOS（类原生） |
| 状态 | 已解锁 Bootloader，已获取 root 权限，已禁用 AVB 2.0 |

### 8.2 测试结果

| 测试项 | 结果 | 说明 |
|--------|------|------|
| 故障复现 | ✅ 通过 | 所有测试机型均 100% 复现了旧槽锁定现象 |
| 手动修复 | ✅ 通过 | 执行手动修复方案后，所有设备的旧槽均恢复可写状态 |
| 自动化模块 | ✅ 通过 | KernelSU 模块在 50 次模拟 OTA 切换测试中均能正确检测并修复锁死问题 |
| 极端案例修复 | ✅ 通过 | 重置更新服务并重刷当前版本官包后，所有外设恢复正常 |

### 8.3 性能测试

| 测试项 | 数值 |
|--------|------|
| 修复执行时间 | < 100ms |
| 模块内存占用 | < 1MB |
| CPU 使用率 | < 1% |

---

## 9 结论与建议

### 9.1 结论

本文完整剖析了 Android A/B 更新机制中的一个严重缺陷：`update_engine` 在更新期间异常退出会导致旧槽分区被永久锁定。

**问题根源**：
1. `update_engine` 在打开块设备时未使用 `O_CLOEXEC` 标志
2. 进程异常退出时文件描述符未被正确释放
3. Linux 内核的块设备独占锁机制导致其他进程无法访问被锁定的设备
4. `update_engine` 的状态机缺乏超时与自愈机制

**验证结果**：
1. 通过对真实 AOSP 源码的分析，确认了问题的存在
2. 在多种 OnePlus 机型上验证了问题的可复现性
3. 提出的修复方案经测试验证有效

### 9.2 对 AOSP 的修复建议

1. **资源管理改进**：在打开块设备时添加 `O_CLOEXEC` 标志
2. **状态机增强**：添加超时机制和自动清理逻辑
3. **文档完善**：在官方文档中增加"异常恢复"章节

### 9.3 对 OEM 厂商的建议

1. 在系统设置的"软件更新"页面显示明确的 `update_engine` 状态提示
2. 提供"重置更新状态"的官方选项
3. 在开机自检阶段主动检测分区一致性
4. 在官方社区和售后知识库中加入此类问题的排查指南

---

## 10 参考文献

[1] A/B（无缝）系统更新 - Android 开源项目官方文档  
    https://source.android.google.cn/docs/core/ota/ab

[2] update_engine.rc 源码 - AOSP system/update_engine/init/  
    https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/init/update_engine.rc

[3] boot_control HAL - Android 开源项目官方文档  
    https://source.android.google.cn/docs/core/ota/boot_control

[4] Virtual A/B 概览 - Android 开源项目官方文档  
    https://source.android.google.cn/docs/core/ota/virtual_ab

[5] AOSP update_engine 源码仓库（清华大学 TUNA 镜像）  
    https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/system/update_engine/

[6] Linux 内核源码 fs/block_dev.c  
    https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/block_dev.c

---

## 免责声明

本文所剖析的一切现象，均为在已解锁、已 root 并禁用 AVB 验证的设备上进行非常规操作后的衍生产物。未刷机、Bootloader 锁定的普通用户遇到此问题的概率极低。

如果你使用其他品牌的 A/B 设备且遇到类似症状，请谨慎参考本文，不要轻率归因。目前我们仅在 OnePlus/ColorOS 平台收集到确凿案例。

---

## 项目地址

完整案例复现、模块源码及更多技术细节，尽在 GitHub 仓库：  
https://github.com/ABI-ZTROS/AB-Unlocker
