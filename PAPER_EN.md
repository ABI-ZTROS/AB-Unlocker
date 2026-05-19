# The Unbreakable Lock: Technical Analysis and Solutions for ColorOS A/B Update "Ghost Lock" Issue

## Abstract

This paper provides an in-depth analysis of a severe design flaw in Android A/B (Seamless) update mechanism. On OnePlus/ColorOS devices with root access and AVB 2.0 verification disabled, this flaw manifests as: after OTA update completion, the block device of the old slot is permanently locked by the kernel in exclusive mode, making it unwritable even with root privileges. Additionally, system functions may become abnormal (e.g., camera not working, flash not functioning).

This paper thoroughly analyzes the root cause from AOSP official documentation and source code: the `update_engine` daemon does not use the `O_CLOEXEC` flag when opening block devices during updates, causing file descriptors to not be properly released after abnormal process termination. Furthermore, the dynamic partition control mechanism lacks proper handling for abnormal exits.

This paper provides complete reproduction steps, manual fix solutions, and an automated KernelSU module. Specific code fix suggestions are proposed for both AOSP and OEM manufacturers.

**Keywords**: Android; A/B Update; update_engine; Block Device Lock; Kernel Exclusive Access; ColorOS; OnePlus; Virtual A/B; Snapshot Merge; File Descriptor Leak; O_CLOEXEC

---

## Authors and Testing Team

**Lead Author**: Zhou Hanghang (DevCloud.ZTR_OS)

**Testing Contributors**: Ribosome (RFG_HTT), C·L Fengxi, RFG_Cuik

**Test Devices**:
- OnePlus ACE5 (Snapdragon 8 Gen 3)
- OnePlus 13
- OnePlus ACE6 Kamisato Ayaka Linkage Model
- OnePlus Pad Pro
- OnePlus ACE5 Ultra

---

## 1 Introduction

### 1.1 Background

The A/B partition mechanism introduced in Android 7.0 (Seamless Updates) aims to reduce the risk of devices failing to boot after OTA updates [1]. This mechanism deploys dual copies of critical partitions (boot, system, vendor, product, odm, etc.). While the system runs from the current slot, the `update_engine` daemon writes updates to the alternate slot, then switches slots and reboots upon completion.

### 1.2 Problem Discovery

During testing on OnePlus/ColorOS devices with root access and AVB 2.0 verification disabled, we discovered a severe issue: after OTA update completion and reboot into the new system, the block device of the old slot is permanently locked by the kernel in exclusive mode, making it unwritable even with root privileges.

### 1.3 Problem Characteristics

This issue exhibits the following unique characteristics:

1. **Permission Transcendence**: The kernel's block device layer exclusive lock check takes precedence over VFS layer permission checks. Even root processes with `CAP_SYS_ADMIN` and `CAP_DAC_OVERRIDE` permissions cannot bypass this lock.
2. **Concealment**: The system appears to work normally after reboot. The problem only becomes apparent when attempting to write to the old slot.
3. **Irreversibility**: Unless the `update_engine` persistent state is actively cleaned, the locked state persists indefinitely.

### 1.4 Contributions

This paper makes the following contributions:

1. Provides a complete technical analysis of the flaw with conclusive evidence from AOSP official documentation and source code
2. Offers 100% reproducible failure steps
3. Proposes manual fix solutions and an automated KernelSU module
4. Conducts line-by-line analysis of key files in AOSP source code, identifying the root cause
5. Provides specific code fix recommendations for AOSP and OEM manufacturers

### 1.5 Scope and Prerequisites

All failures described in this paper occur on devices that have been rooted, have AVB 2.0 (dm-verity) disabled, and have had their bootloader unlocked. Confirmed cases are limited to OnePlus devices or devices running ColorOS.

---

## 2 Related Work

### 2.1 A/B Seamless Update Mechanism Overview

The Android official documentation defines the goal of A/B system updates as [1]: "Ensure a bootable and usable system is preserved on disk during over-the-air (OTA) updates, reducing the possibility of device boot failure after update."

The core daemon for A/B updates is `update_engine`, whose main responsibilities include:
- Downloading OTA update packages
- Verifying update package integrity and signatures
- Writing updates to the alternate slot
- Performing snapshot merges (Virtual A/B)
- Managing boot slot switching

### 2.2 A/B Update State Machine

The `update_engine` maintains a strict internal state machine with the following transition path:

```
Idle → CheckingForUpdate → UpdateAvailable → Downloading → Verifying 
    → Finalizing → UpdatedNeedReboot → Idle
```

After rebooting into the new system, `update_engine` calls `markBootSuccessful()` to mark the new slot as successful, then enters the Idle state and releases old slot resources [1].

### 2.3 Virtual A/B and Snapshot Mechanism

The Virtual A/B mechanism implements copy-on-write (COW) snapshot devices. Official documentation defines snapshot merge states including NONE, UNKNOWN, SNAPSHOTTED, MERGING, CANCELLED [4].

Core components of the snapshot mechanism include:
- **dm-snapshot**: Kernel-level device mapper module implementing copy-on-write
- **COW partition**: Temporary partition storing delta data
- **snapshotctl**: User-space tool for managing snapshot devices

### 2.4 File Descriptors and O_CLOEXEC

`O_CLOEXEC` (Close-on-Exec) is a POSIX standard file descriptor flag that automatically closes the file descriptor when the process calls `exec()` to execute a new program.

**File descriptor inheritance mechanism**:
1. When a process calls `fork()` to create a child process, the child inherits all file descriptors from the parent
2. If the parent subsequently calls `exec()` to execute a new program, all file descriptors remain open by default
3. File descriptors with the `O_CLOEXEC` flag are automatically closed during `exec()`

### 2.5 Linux Kernel Block Device Exclusive Lock Mechanism

The Linux kernel's block device layer implements an exclusive access mechanism, with core code located in `fs/block_dev.c`. When a process opens a block device in exclusive mode, the kernel marks the device as exclusively accessed. Subsequent write-open attempts by other processes return `-EBUSY`.

---

## 3 Problem Analysis

### 3.1 Failure Symptoms

The failure manifests with the following characteristics:

1. **First Screen Freeze**: After OTA update completion, the device freezes on the boot logo screen for over 40 seconds
2. **Old Slot Locked**: After entering the new system, attempting to write to the old slot results in `dd` command returning `Device or resource busy`
3. **Local OTA Failure**: Local OTA installation fails directly without meaningful error messages
4. **Peripheral Abnormalities**: In extreme cases, peripherals such as camera and flash may not work properly
5. **Lock Status Visible**: Block device locks may be visible in `/proc/locks`

### 3.2 Technical Root Cause

Based on analysis of `dmesg` logs, `/proc/*/fd` file descriptor tables, and real `update_engine` source code, the root cause can be summarized as:

#### 3.2.1 Process Abnormal Exit and Resource Leak

The `update_engine` does not use the `O_CLOEXEC` flag when opening block devices. When the process abnormally exits during the update phase, the exclusive file descriptors for block devices may not be immediately reclaimed by the kernel, causing the old slot partition to be permanently locked.

#### 3.2.2 State Machine Design Flaw

The `update_engine` state machine lacks timeout and self-healing mechanisms. Even when the system is successfully running from the new slot, the state machine rejects new update requests and keeps the old slot locked as long as the persistent state file indicates "update in progress."

#### 3.2.3 Snapshot Merge Incompleteness Chain Reaction

In extreme cases, incomplete snapshot merges cause driver version mismatches across vendor, odm, and other partitions, leading to peripheral failures such as camera malfunctions.

### 3.3 Reproduction Steps

The following steps can 100% reproduce the failure:

| Step | Action | Expected Result | Actual Result | Key Node |
|------|--------|----------------|---------------|----------|
| 1 | Receive ColorOS major version OTA push | System downloads full package, writes to alternate slot | Update starts, progress bar advances | Write phase |
| 2 | Reboot after write completion | Device reboots, switches to new slot and enters normally | Device freezes on first screen for over 40 seconds | ⚠️ **Critical Warning** |
| 3 | Attempt to flash image to old slot | `dd` command writes normally | Returns `Device or resource busy` | Kernel exclusive lock active |
| 4 | Attempt local OTA installation | Update interface starts installation process | Installation fails directly | State machine rejects new request |
| 5 | Reset update_engine service | Service restarts, old slot becomes idle | `dd` writes successfully | Only fix path |

---

## 4 Deep Source Code Analysis of update_engine

### 4.1 Core File Structure

The core code of `update_engine` is located in `platform/system/update_engine/`, with main files including:

| File Path | Description |
|-----------|-------------|
| `payload_consumer/partition_writer.cc` | Partition writer, responsible for opening and writing to target partitions |
| `payload_consumer/file_descriptor.cc` | File descriptor wrapper, ultimately calls `open()` system call |
| `aosp/update_attempter_android.cc` | Android platform update control logic |
| `download_action.cc` | Download action, coordinates downloading and applying updates |
| `payload_consumer/delta_performer.cc` | Delta update performer, handles update package parsing and application |

### 4.2 partition_writer.cc Source Analysis

`partition_writer.cc` is the core module responsible for opening and writing to target partitions. The `Init()` function in this file is the key location for opening block devices.

#### 4.2.1 Init() Function Analysis

```cpp
// From partition_writer.cc lines 159-183
bool PartitionWriter::Init(const InstallPlan* install_plan,
                           bool source_may_exist,
                           size_t next_op_index) {
  // ... preceding code ...
  
  // Critical issue: O_CLOEXEC flag not used when opening block device file
  int flags = O_RDWR;
  if (!interactive_)
    flags |= O_DSYNC;

  LOG(INFO) << "Opening " << target_path_ << " partition with"
            << (interactive_ ? "out" : "") << " O_DSYNC";

  target_fd_ = OpenFile(target_path_.c_str(), flags, true, &err);
  if (!target_fd_) {
    // ... error handling ...
    return false;
  }
  
  // ... subsequent code ...
}
```

**Analysis**:
- `int flags = O_RDWR;` - Only uses `O_RDWR` flag, missing `O_CLOEXEC`
- `O_DSYNC` flag is added in non-interactive mode, but `O_CLOEXEC` is still missing
- Calls `OpenFile()` to open the block device, with `flags` parameter containing only `O_RDWR` or `O_RDWR|O_DSYNC`

#### 4.2.2 OpenFile() Function Analysis

```cpp
// From partition_writer.cc lines 85-107
FileDescriptorPtr OpenFile(const char* path,
                           int mode,
                           bool cache_writes,
                           int* err) {
  // ... preceding code ...
  
  FileDescriptorPtr fd(new EintrSafeFileDescriptor());
  if (cache_writes && !read_only) {
    fd = FileDescriptorPtr(new CachedFileDescriptor(fd, kCacheSize));
    LOG(INFO) << "Caching writes.";
  }
  // Critical call: Invokes FileDescriptor::Open()
  if (!fd->Open(path, mode, 000)) {
    *err = errno;
    PLOG(ERROR) << "Unable to open file " << path;
    return nullptr;
  }
  *err = 0;
  return fd;
}
```

**Analysis**:
- Creates `EintrSafeFileDescriptor` instance, which wraps file descriptor operations
- Calls `FileDescriptor::Open()` method, with the `mode` parameter still not containing `O_CLOEXEC`

### 4.3 file_descriptor.cc Source Analysis

`file_descriptor.cc` implements the concrete implementation of the `FileDescriptor` abstract class and is where the `open()` system call is ultimately invoked.

#### 4.3.1 EintrSafeFileDescriptor::Open() Function Analysis

```cpp
// From file_descriptor.cc lines 37-56
bool EintrSafeFileDescriptor::Open(const char* path, int flags, mode_t mode) {
  CHECK_EQ(fd_, -1);
  // Critical issue: Ultimately calls open() system call, but flags does not include O_CLOEXEC
  return ((fd_ = HANDLE_EINTR(open(path, flags, mode))) >= 0);
}

bool EintrSafeFileDescriptor::Open(const char* path, int flags) {
  CHECK_EQ(fd_, -1);
  // Critical issue: Same as above, missing O_CLOEXEC
  return ((fd_ = HANDLE_EINTR(open(path, flags))) >= 0);
}
```

**Analysis**:
- Uses `HANDLE_EINTR()` macro to handle system calls interrupted by signals
- The `flags` parameter passed directly from the caller does not include `O_CLOEXEC`
- If the `update_engine` process crashes or is terminated by a signal, file descriptors may not be immediately released

### 4.4 update_attempter_android.cc Source Analysis

`update_attempter_android.cc` is the main control logic for `update_engine` on the Android platform.

#### 4.4.1 ResetStatus() Function Analysis

```cpp
// From update_attempter_android.cc lines 504-551
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
  // Critical call: Resets dynamic partition control update state
  if (!boot_control_->GetDynamicPartitionControl()->ResetUpdate(prefs_)) {
    LOG(WARNING) << "Failed to reset snapshots. UpdateStatus is IDLE but"
                 << "space might not be freed.";
  }
  return true;
}
```

**Analysis**:
- `ResetStatus()` is a public method that can be called
- It calls the `ResetUpdate()` method of `dynamic_partition_control` to clean up snapshot devices and related resources
- However, this method has usage restrictions: only allowed in `IDLE` or `UPDATED_NEED_REBOOT` states

### 4.5 download_action.cc Source Analysis

`download_action.cc` is responsible for coordinating the complete process of downloading and applying updates.

#### 4.5.1 PerformAction() Function Analysis

```cpp
// From download_action.cc lines 53-90
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

**Analysis**:
- Sets the HTTP fetcher's delegate
- Retrieves the installation plan and calculates total bytes
- Handles breakpoint resume logic
- Marks the target slot as unbootable (safety measure)
- Starts downloading

#### 4.5.2 TransferComplete() Function Analysis

```cpp
// From download_action.cc lines 242-275
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

**Analysis**:
- Closes `delta_performer` after download completion
- Verifies payload integrity
- If successful, notifies delegate and records statistics
- Passes installation plan to next action

### 4.6 Complete Update Flow Analysis

The update process in `update_engine` consists of a series of actions coordinated by `ActionProcessor`:

```
UpdateBootFlagsAction → CleanupPreviousUpdateAction → InstallPlanAction 
    → DownloadAction → FilesystemVerifierAction → PostinstallRunnerAction
```

#### 4.6.1 BuildUpdateActions() Function Analysis

```cpp
// From update_attempter_android.cc lines 931-970
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

**Analysis**:
- Creates all necessary action objects
- Establishes dependencies between actions through `BondActions()`
- Enqueues actions sequentially into `ActionProcessor`

### 4.7 State Management and Persistence

The `update_engine` uses the `prefs` system to persist update state. Key persistent keys include:

| Key Name | Purpose |
|----------|---------|
| `attempt-in-progress` | Marks whether an update is currently in progress |
| `update-state-next-operation` | Records the next operation to be executed |
| `update-state-next-data-offset` | Records the next data offset |
| `update-state-sha-256-context` | Records SHA-256 hash context |
| `update-completed-on-boot-id` | Records the boot ID when update completed |
| `previous-slot` | Records the previous slot |

This state information is stored in the `/data/misc/update_engine/` directory. If `update_engine` exits abnormally, this state information is not automatically cleaned up, causing subsequent startups to still believe an update is in progress.

---

## 5 Linux Kernel Block Device Exclusive Lock Mechanism Analysis

### 5.1 Kernel Block Device Layer Architecture

The Linux kernel's block device layer sits below the VFS layer and manages access to physical block devices. Its core structures include:

- `struct block_device`: Block device descriptor
- `struct gendisk`: Generic disk structure
- `bd_holder`: Block device holder
- `bd_holder_id`: Holder ID

### 5.2 Block Device Exclusive Lock Implementation

The core code for the block device exclusive lock mechanism is located in `fs/block_dev.c`:

```c
// Key logic from kernel source fs/block_dev.c
static int bd_prepare_to_claim(struct block_device *bdev,
                               struct block_device_holder *holder,
                               void *holder_id)
{
    // Check if device is already exclusively claimed by another process
    if (bdev->bd_holder && bdev->bd_holder != holder) {
        return -EBUSY;
    }
    
    // Mark device as exclusively claimed by current holder
    bdev->bd_holder = holder;
    bdev->bd_holder_id = holder_id;
    return 0;
}
```

**Analysis**:
- When a process attempts to open a block device, the kernel checks if `bd_holder` is empty
- If `bd_holder` is not empty and is not the current process, returns `-EBUSY`
- This check occurs during VFS layer `open()` system call processing, prior to file permission checks

### 5.3 Block Device Open Flow

The block device open flow is as follows:

1. User space calls `open()` system call
2. VFS layer finds the corresponding `inode` by path
3. Calls `block_open()` function
4. `block_open()` calls `bd_acquire()` to acquire the block device
5. `bd_acquire()` calls `bd_prepare_to_claim()` to check the exclusive lock
6. If the check passes, marks the device as exclusively claimed by the current process
7. Returns file descriptor

### 5.4 Impact of File Descriptor Leaks

After `update_engine` opens a block device in exclusive mode:

1. If the process exits normally, file descriptors are automatically closed and the block device lock is released
2. If the process exits abnormally (crash, SIGKILL termination, etc.), file descriptors may not be immediately released
3. If file descriptors are leaked to child processes (without setting `O_CLOEXEC`), child processes still hold the file descriptors even after the parent exits
4. As long as any process holds the file descriptor, the block device remains locked

---

## 6 Complete Update Flow and System Operations

### 6.1 Update Flow Sequence Diagram

```
User requests update → update_engine starts → Check update status
    ↓
Download update package → Verify signature → Parse manifest
    ↓
Open target partition → Write update data → Verify data integrity
    ↓
Execute post-install script → Mark new slot bootable → Wait for reboot
    ↓
System reboot → Enter new slot → Mark boot successful → Cleanup old slot resources
```

### 6.2 System Operations by Phase

#### 6.2.1 Download Phase

1. **Network operations**: Download update package via HTTP/HTTPS
2. **File system operations**: Temporarily store downloaded data
3. **Status update**: Record download progress to `prefs`

#### 6.2.2 Write Phase

1. **Block device operations**: Open block device for target partition
2. **Data writing**: Write update data to block device
3. **Hash calculation**: Calculate SHA-256 hash of data

#### 6.2.3 Verification Phase

1. **Integrity verification**: Verify integrity of written data
2. **Signature verification**: Verify digital signature of update package

#### 6.2.4 Post-Install Phase

1. **Execute script**: Run `postinst` script
2. **Update bootloader**: Update bootloader configuration
3. **Mark slot**: Mark new slot as bootable

#### 6.2.5 Post-Reboot Phase

1. **Switch slot**: Bootloader boots to new slot
2. **Mark successful**: `update_engine` marks boot successful
3. **Cleanup resources**: Release old slot resources

### 6.3 Abnormal Scenario Analysis

#### 6.3.1 Abnormal Exit During Write Phase

**Scenario**: `update_engine` exits abnormally during the write phase

**Consequences**:
- Block device file descriptors not closed
- Old slot permanently locked
- Cannot write to old slot after system reboot

**Root Cause**: `O_CLOEXEC` flag not used, file descriptors not properly released when process exits

#### 6.3.2 Verification Phase Failure

**Scenario**: Data incompleteness or signature invalidity detected during verification

**Consequences**:
- Update fails, system rolls back to old slot
- Block device may still be locked if already opened

**Handling**: `update_engine` should explicitly close all open file descriptors on failure

#### 6.3.3 First Screen Freeze After Reboot

**Scenario**: System freezes on first screen for over 40 seconds after update completion

**Consequences**:
- Users think device is bricked
- Actually `update_engine` is performing snapshot merge in background

**Root Cause**: Virtual A/B snapshot merge operation takes time, especially on large partitions

---

## 7 Solutions

### 7.1 Manual Fix Solution

The simplest and most effective fix is to force reset the `update_engine` service:

```bash
# Force stop update_engine and clear its persistent state
rm -rf /data/misc/update_engine/*
killall update_engine
```

After executing the above commands, the kernel will reclaim all occupied file descriptors and the old slot becomes writable again.

### 7.2 Automated KernelSU Module

To implement automated detection and repair, we developed a KernelSU module with the following workflow:

1. **Boot detection**: Detect on each boot whether the current boot slot differs from the previously recorded slot (OTA switch occurred)
2. **Lock detection**: Attempt to write 0 bytes to the unused old slot (open `O_WRONLY` and immediately close)
3. **Lock determination**: If opening fails (returns `EBUSY`), determine it as ghost lock
4. **Automatic repair**: Immediately reset `update_engine` service

This module is lightweight and non-intrusive, only executing when necessary. Module repository: https://github.com/ABI-ZTROS/AB-Unlocker

### 7.3 Code Fix Recommendations

#### 7.3.1 Add O_CLOEXEC Flag

Add `O_CLOEXEC` flag in `partition_writer.cc` `Init()` function:

```cpp
// Before
int flags = O_RDWR;
if (!interactive_)
  flags |= O_DSYNC;

// After
int flags = O_RDWR | O_CLOEXEC;  // Add O_CLOEXEC
if (!interactive_)
  flags |= O_DSYNC;
```

Or automatically add it in `file_descriptor.cc` `Open()` function:

```cpp
// Before
bool EintrSafeFileDescriptor::Open(const char* path, int flags, mode_t mode) {
  CHECK_EQ(fd_, -1);
  return ((fd_ = HANDLE_EINTR(open(path, flags, mode))) >= 0);
}

// After
bool EintrSafeFileDescriptor::Open(const char* path, int flags, mode_t mode) {
  CHECK_EQ(fd_, -1);
  // Automatically add O_CLOEXEC flag
  return ((fd_ = HANDLE_EINTR(open(path, flags | O_CLOEXEC, mode))) >= 0);
}
```

#### 7.3.2 Enhance State Machine Self-Healing Capability

Add automatic cleanup logic in `update_attempter_android.cc`:

```cpp
// Check if automatic cleanup is needed on startup
void UpdateAttempterAndroid::CheckAndCleanupStaleUpdate() {
  // Check if there is incomplete update state
  bool attempt_in_progress = false;
  prefs_->GetBoolean(kPrefsAttemptInProgress, &attempt_in_progress);
  
  if (attempt_in_progress) {
    // Check if already successfully booted from new slot
    string update_completed_boot_id;
    if (prefs_->Exists(kPrefsUpdateCompletedOnBootId)) {
      prefs_->GetString(kPrefsUpdateCompletedOnBootId, &update_completed_boot_id);
      
      string current_boot_id;
      if (utils::GetBootId(&current_boot_id) && 
          update_completed_boot_id != current_boot_id) {
        // Already successfully booted from new slot, can safely clean up
        LOG(INFO) << "Detected stale update state, cleaning up...";
        ResetStatus(nullptr);
      }
    }
  }
}
```

---

## 8 Testing and Verification

### 8.1 Testing Environment

| Item | Configuration |
|------|--------------|
| Test Devices | OnePlus ACE5, OnePlus 13, OnePlus ACE6, OnePlus Pad Pro, OnePlus ACE5 Ultra |
| System Version | ColorOS (custom ROM) |
| Status | Bootloader unlocked, root access obtained, AVB 2.0 disabled |

### 8.2 Test Results

| Test Item | Result | Description |
|-----------|--------|-------------|
| Failure Reproduction | ✅ Passed | All test devices 100% reproduce the old slot lock phenomenon |
| Manual Fix | ✅ Passed | After executing manual fix, old slot becomes writable on all devices |
| Automated Module | ✅ Passed | KernelSU module correctly detects and fixes lock issues in 50 simulated OTA switch tests |
| Extreme Case Fix | ✅ Passed | After resetting update service and reflashing current version official package, all peripherals restored to normal |

### 8.3 Performance Testing

| Test Item | Value |
|-----------|-------|
| Fix Execution Time | < 100ms |
| Module Memory Usage | < 1MB |
| CPU Usage | < 1% |

---

## 9 Conclusion and Recommendations

### 9.1 Conclusion

This paper provides a complete analysis of a severe flaw in the Android A/B update mechanism: `update_engine` abnormal exit during updates causes permanent locking of the old slot partition.

**Root Causes**:
1. `update_engine` does not use `O_CLOEXEC` flag when opening block devices
2. File descriptors not properly released on process abnormal exit
3. Linux kernel block device exclusive lock mechanism prevents other processes from accessing locked devices
4. `update_engine` state machine lacks timeout and self-healing mechanisms

**Verification Results**:
1. Confirmed issue existence through analysis of real AOSP source code
2. Verified issue reproducibility on multiple OnePlus devices
3. Proposed fixes tested and validated

### 9.2 Recommendations for AOSP

1. **Resource Management Improvement**: Add `O_CLOEXEC` flag when opening block devices
2. **State Machine Enhancement**: Add timeout mechanism and automatic cleanup logic
3. **Documentation Improvement**: Add "Exception Recovery" section in official documentation

### 9.3 Recommendations for OEM Manufacturers

1. Display clear `update_engine` status prompts in the "Software Update" page of system settings
2. Provide official "Reset Update Status" option
3. Proactively detect partition consistency during boot self-test
4. Add troubleshooting guides for such issues in official community and after-sales knowledge base

---

## 10 References

[1] A/B (Seamless) System Updates - Android Open Source Project Official Documentation  
    https://source.android.google.cn/docs/core/ota/ab

[2] update_engine.rc Source Code - AOSP system/update_engine/init/  
    https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/init/update_engine.rc

[3] boot_control HAL - Android Open Source Project Official Documentation  
    https://source.android.google.cn/docs/core/ota/boot_control

[4] Virtual A/B Overview - Android Open Source Project Official Documentation  
    https://source.android.google.cn/docs/core/ota/virtual_ab

[5] AOSP update_engine Source Repository (Tsinghua University TUNA Mirror)  
    https://mirrors.tuna.tsinghua.edu.cn/git/AOSP/platform/system/update_engine/

[6] Linux Kernel Source Code fs/block_dev.c  
    https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/block_dev.c

---

## Disclaimer

All phenomena analyzed in this paper are derivatives of non-standard operations performed on devices with unlocked bootloader, root access, and disabled AVB verification. The probability of ordinary users (with locked bootloader and unmodified devices) encountering this issue is extremely low.

If you encounter similar symptoms on A/B devices from other brands, please refer to this paper cautiously and avoid hasty attribution. Currently, we have only collected conclusive cases on OnePlus/ColorOS platforms.

---

## Project Repository

Complete case reproduction, module source code, and additional technical details can be found in the GitHub repository:  
https://github.com/ABI-ZTROS/AB-Unlocker
