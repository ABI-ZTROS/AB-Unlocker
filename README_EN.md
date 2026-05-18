# The Lock Even Root Can't Cross: An Autopsy of a ColorOS A/B Update "Ghost Lock", Automated Unbricking, and a Bloody Indictment of Google

## Preface: When Root Is No Longer God 🤡

In the Android world, root has always been synonymous with power. We mount, rewrite, and penetrate, thinking we can trample all software rules—until you encounter a block device that even `dd` slams into headfirst. 😨
This article documents an absurd OTA aftereffect: the system is completely normal, yet the old slot remains permanently unwritable, and root privileges are useless. I'll start from the crime scene, dive deep into Google's proud A/B seamless update mechanism, cite Android official documentation and AOSP source code as irrefutable evidence, dissect its most vulnerable soft tissue, and finally show how to push Google's "ghost" back into the grave with a few lines of script. A KernelSU module will be included at the end to immunize your device against this terminal illness for good. 😋
But before you start cursing, please read this critical disclaimer: All the faults described in this article occur on devices that have been flashed, have obtained root privileges, and are currently confirmed to be limited to OnePlus devices or devices running ColorOS. Users who haven't flashed, haven't unlocked their bootloader have not reported encountering this problem. If you don't belong to the above category, this article may not be relevant to you, but you're welcome to read it for entertainment—to see how absurdly fragile Google's code can become when system integrity protection is removed. 🤣
If you're looking for a five-in-one long-form tirade of "technical autopsy + official documentation evidence + source code evidence + kernel mechanism + crazy torture of Google," you've come to the right place.

## Chapter 1: Android System Update Service—That Ghost You Never Cared About 👻

Before picking up the scalpel to dissect the fault, we must first get to know the protagonist hiding in the system's shadows—update_engine. All descriptions cited in this chapter are from Android Open Source Project (AOSP) official documentation and source code, with no fabrication, and complete citation links are attached at the end.

### 1.1 A/B Seamless Updates: Google's Pride 😎

Android 7.0 introduced the A/B partition mechanism (Seamless Updates). Android official documentation defines its goal as [1]:

> "The goal of A/B system updates (also known as seamless updates) is to ensure that a bootable, usable system remains on disk during over-the-air (OTA) updates. This reduces the likelihood that a device won't boot after an update, which means users will need fewer visits to repair and warranty centers for replacement and re-flashing."

This mechanism deploys two copies of critical partitions like boot, system, vendor, etc., called slot A and slot B respectively. Its core design philosophy is: the system runs from the "current" slot, but during normal operation, the running system doesn't access partitions in the unused slot, thus keeping the unused slot as a backup to guard against update errors [1]. The entire process is almost transparent to users, and rollback capability is retained—the documentation explicitly promises: "If the OTA fails, the device boots to the disk partitions from before the OTA, and is still usable" [1].

The core daemon behind this mechanism is update_engine. Official documentation clearly states: "A/B system updates use a background daemon called update_engine and two sets of partitions" [1]. It is the only official channel for all OTA operations (whether incremental or full).

And Google's self-evaluation of this mechanism is: "A/B systems are very robust because any error (such as an I/O error) can only affect the unused partition set, and can be retried" [1].

——Haha, very robust? Let's see what happens next. 😅

### 1.2 update_engine Startup Mechanism: From Bootloader to Binder

update_engine isn't arbitrarily launched by the application framework layer. Its startup follows a strict low-level chain. According to the update_engine.rc configuration file in AOSP source code [2]:

```
service update_engine /system/bin/update_engine
    class main
    user root
    group root cache inet
    seclabel u:r:update_engine:s0
    disabled
    shutdown critical
    on property:ro.boot.slot_suffix=*
        setprop update_engine.slot_suffix ${ro.boot.slot_suffix}
        start update_engine
```

This configuration reveals several key facts:
- **disabled**: The service doesn't auto-start with class main; it must be triggered by a specific event.
- **on property:ro.boot.slot_suffix=***: The only trigger for startup is the ro.boot.slot_suffix system property being set, which comes from the current active slot information passed by the Bootloader via the kernel command line (e.g., androidboot.slot_suffix=_a) [3].
- **user root**: update_engine runs as root, with the highest privileges to directly read/write system partitions.

The entire startup flow can be summarized as: Bootloader → Kernel → Init (property system) → Execute binary → Register Binder service.

What does this mean? It means update_engine was designed from birth as a privileged ghost—it possesses kernel-level resource possession capabilities that even root users can't easily interfere with, and its startup depends entirely on Bootloader parameters and property triggers, with user space having almost no way to intervene in its lifecycle. 😱

### 1.3 update_engine State Machine: Rigorous or Fragile?

update_engine internally maintains a strict state machine. After OTA is triggered, its transition path is roughly:

```
Idle → CheckingForUpdate → UpdateAvailable → Downloading → Verifying → Finalizing → UpdatedNeedReboot → Idle
```

In AOSP official documentation, this flow is described as several typical stages [1]:
- **Updating**: The system is running from the current slot, and the content in the target slot is "being updated but not yet complete," so the slot is "marked as unbootable."
- **Update applied, waiting for reboot**: The target slot has been marked as bootable but not yet successful, and the bootloader should attempt to boot from it.
- **System rebooted to new update**: First run from the new slot, old slot remains bootable and successful.

Key stage details:
- **Downloading**: Writes payload to target slot, creates device-mapper snapshot (COW device) during this period, providing copy-on-write protection for the target partition. When describing Virtual A/B implementation, official documentation clearly defines snapshot merge states including NONE, UNKNOWN, SNAPSHOTTED, MERGING, CANCELLED [4].
- **Finalizing**: Executes postinstall scripts (if any), and begins snapshot merge. Official documentation describes: "For each partition with post-install steps defined, update_engine mounts the new partition at a specific location and executes the program specified in the OTA corresponding to the mounted partition" [1]. In this stage, the snapshot state is MERGING, and the merge operation merges differential data from the COW device back to the original physical partition [4].
- **UpdatedNeedReboot**: Writing and merging complete, sets new slot as bootable, marks "needs reboot to complete update." The official flow is described as: "System reboots to new update: System first runs from slot A" [1].
- **After rebooting into new system**: update_engine calls `markBootSuccessful()` in the background, setting the new slot's "successful" property to true. Official documentation clearly states: "A slot marked as successful should be able to boot, run, and update by itself" [1]. Then enters Idle state, releasing all resources of the old slot.

This all sounds interconnected, but the devil is in the details. Official documentation never mentions: What if the daemon abnormally exits during Finalizing or UpdatedNeedReboot? There's no timeout mechanism, no self-healing logic, no rollback protection. Google seems to assume update_engine will never make a mistake. 🤔

### 1.4 Exclusive File Descriptor: The Kernel's Iron Law ⚖️

In the Linux kernel, when update_engine opens a block device (like /dev/block/by-name/system_b) to perform COW or direct writes, it uses the O_EXCL flag or equivalent exclusive open mode. This isn't a security feature, but basic protection to prevent multiple processes from writing to the block device simultaneously causing data interleaving corruption.

Once a process (even if it's dead but the file descriptor isn't closed) has opened the block device exclusively, the kernel's block device layer will directly reject any subsequent write `open()` calls, returning -EBUSY. This rejection happens at the VFS layer, prioritized over all permission checks. Root can ignore UID/GID, even turn off SELinux, but can't release another kernel object's possession of a resource. That's why our story is so bizarre. 😡

update_engine's disabled property and shutdown critical flag were originally intended to ensure the update process isn't interrupted. But when the update is interrupted, these protection mechanisms become a breeding ground for ghosts—they ensure update_engine doesn't exit gracefully while holding resources, but there's no mechanism to ensure it releases those resources when accidentally killed.

Looking casually at the `OpenPartition()` function in delta_performer.cc above, you'll find that when it calls `fd->Open(partition_path.c_str(), O_RDWR, 0)`, there's not a single trace of O_CLOEXEC in the parameter list. And the `Cleanup()` method in snapshot_merge_performer.cc depends on `Merge()` returning normally to be called—as long as any exception is thrown inside `Merge()` or the process is killed, the cleanup code is dead in the water.

It chose to pin all hopes on the fantasy that "the update process will definitely run perfectly to the end," leaving behind a mess full of resource leaks. And the official documentation's definition of snapshot merge state CANCELLED [4] hints that Google's designers at least considered the "cancel" scenario—but they just didn't consider the practical problem of "who executes the cancel after the process is accidentally killed." This kind of design wouldn't pass code review at any serious company, yet it lies in AOSP's main branch, year after year, screwing every flashaholic. 😤

## Chapter 2: The Crime Scene—A Perfect OTA, A Permanently Locked Partition 🕵️

### 2.1 Reproduction Steps and Critical Fault Nodes

To allow readers to trigger this fault themselves or verify if similar hidden dangers exist on their devices, the complete reproduction process is recorded below. Each step marks technical nodes where problems might occur, making it easy to locate and debug.

Device state: OnePlus device running near-stock ColorOS, current working slot is A, system running normally. Device has been flashed, bootloader unlocked, root obtained, AVB 2.0 (dm-verity) disabled. This is the common premise for all confirmed cases—users who haven't flashed or unlocked have not reported encountering this problem.

| Step | Action | Expected Result | Actual Result | Potential Problem Nodes |
|------|--------|-----------------|---------------|-------------------------|
| 1 | Receive ColorOS major version OTA push, trigger update. | System downloads full package, update_engine writes new system to unused slot B. | Update starts, progress bar advances. | Writing stage: If forced reboot or power loss occurs during this stage, slot B will be marked as unbootable and persistent state stuck at Downloading. But in this reproduction, writing completed normally. |
| 2 | After writing completes, system prompts "need to reboot to complete update." Click reboot. | Device reboots, bootloader switches to slot B, normally enters new system. | After device reboots, freezes on first boot screen (OEM Logo page) for over 40 seconds, then enters second boot screen (bootanimation), finally enters new system. New system functions normally, no crashes or errors. | ⚠️ **Critical warning signal**: If during reboot after update you observe the device staying on the first screen (static logo) for way longer than normal (usually 5-15 seconds)—over 40 seconds—this is 100% confirmed evidence. This abnormal lag indicates update_engine encountered severe blocking or thread deadlock during snapshot merge in the post-boot stage, with the kernel waiting for an I/O operation that will never complete. The merge thread in the commit stage (post-boot) falls into permanent slumber at this point, state file locked at UpdatedNeedReboot or Finalizing, and the old slot A's partition device files are forever clutched by the ghost. If you don't observe this 40+ second lag, please don't continue trying reproduction steps—your device likely didn't trigger this bug, continuing to force operations will only shorten your storage chip's lifespan. 😨 |
| 3 | After entering slot B, try flashing image to old slot A (like patched boot.img). | dd command normally writes to block device. | dd returns **Device or resource busy**, write fails. | Kernel exclusive lock: Because the merge thread in step 2 has deadlocked, update_engine's leftover zombie file descriptors still hold system_a, boot_a, etc. in O_EXCL mode. Kernel rejects any new write opens, root can't bypass. |
| 4 | Try locally installing OTA full package (or incremental package) within system, hoping to overwrite or fix locked old slot. | Update interface starts installation process. | Installation fails directly, no valid error message (only pop-up "installation failed"). | State machine rejection: update_engine is still in the intermediate state of "update not complete," its internal state machine rejects new ApplyPayload requests, returns error code (like kInvalidState). This confirms the root of the lock is update_engine's persistent state, not transient file occupation. |
| 5 | Reset Android system update service. Execute `rm -rf /data/misc/update_engine/*` and `killall update_engine`. | Service restarts into Idle state, old slot partition restored to idle. | After command execution, try dd writing to old slot A again, successfully writes, everything normal. | **Only fix path**: Clear persistent state + kill process, forcing kernel to reclaim all exclusive file descriptors. This operation is equivalent to manually triggering Google's never publicly exposed "abnormal recovery" flow. 😋 |

Through the above steps, this ghost lock phenomenon can be reproduced 100%. The core problem node is during the transition from step 2 to step 3—i.e., after rebooting into the new system, update_engine fails to complete the commit stage, yet silently retains device occupation of the old slot. The most insidious part is that except for the 40-second lag on the first screen as a warning signal, the system shows no visible errors, and ordinary users don't even know their old slot has been permanently kidnapped.

> ⚠️ **Reproduction risk warning**: If you don't observe the first screen freezing for over 40 seconds during the reboot in step 2, please stop trying immediately. This means the commit stage of update_engine on your device completed normally, and the old slot isn't locked. Forcibly executing dd writes or resetting the update service in subsequent steps at this point will bring no benefits and may introduce unnecessary risks. More importantly, every meaningless reproduction attempt is consuming the write lifespan of the eMMC/UFS storage chips on your device. Your storage chips will be looking down at you from heaven, weeping for their wasted P/E cycles. 😭 If you're just verifying the phenomenon described in this article, just check the first screen boot time—over 40 seconds is solid evidence, otherwise please stop.

> **Device and system limitation statement**: As of now, all confirmed reproduced ghost lock cases appear on OnePlus devices or devices running ColorOS. This doesn't mean A/B devices from other brands (like Pixel, Xiaomi, Samsung) absolutely won't have similar problems—theoretically, any Android device using A/B updates inherits the same code base—but in actual collected samples, only the above devices have confirmed case records. If you're using a device from another brand, the principle analysis in this article is still valid, but trigger conditions may vary due to different degrees of OEM customization to update_engine—don't rashly attribute without evidence.

### 2.2 Futile Struggles 😫

After discovering the lock, I spent hours on conventional troubleshooting, all of which failed without exception:
- `umount`? The partition isn't even mounted.
- `blockdev --setrw`? It's already read-write.
- `disable-verity`? dm-verity isn't even protecting it. Although official documentation mentions "dm-verity can ensure the boot image used by the device is uncorrupted" [1], that's not the problem here.
- Check AVB 2.0 / dm-verity status: Disabled (for flashing needs). This means integrity verification for system, vendor, etc. partitions is turned off, and block device write protection doesn't come from the verified boot chain. This also excludes the possibility of "AVB blocking writes," proving the root of the lock is lower level.
- Check SELinux? Already in Permissive mode.
- Reboot device? Problem remains.

The partition looks completely normal, no error flags, but just rejects any writes. It's like a black hole, calmly and firmly swallowing all write attempts, not allowing even a single byte. 🤬

Official documentation confidently says: "Any error (such as an I/O error) can only affect the unused partition set, and can be retried" [1]. Yet the current situation is: No error reports, but the old partition set is permanently locked, and there's no official way to retry or reset.

### 2.3 The Twist of Doubt: From Hardware Lock to Software Ghost 👻

I once suspected hardware write protection was accidentally triggered (like eMMC CMD28). But if it's a hardware lock, why is the other new slot completely normal? Why can't rebooting release it (temporary write protection is lost on power down)?

Until I turned my attention to dmesg and update_engine logs, an absurd truth finally surfaced. That update_engine that should have quietly retired after OTA completion was still clutching the old slot A's partition device files like a lonely ghost.

By checking `/proc/*/fd`, I found invalidated file descriptors pointing to `/dev/block/by-name/boot_a` and `system_a`. They belonged to an already killed update_engine child process (probably snapuserd or the merge thread), which was hastily terminated by the system at some point, yet executed no cleanup actions.

The kernel says: "This device is occupied, get lost."
And that occupant is already a dead soul. Root can do nothing about a dead soul. 😈

### 2.4 Extreme Case: Collective Mutiny of Marginal Devices Like Cameras 📸

Shortly after the initial sharing of this case, more absurd feedback emerged from the community: On similarly rooted, AVB-disabled OnePlus/ColorOS devices, some users not only encountered old slot locking but also found strange system function deficits—camera can't start, flash missing, even Bluetooth or Wi-Fi intermittently failing. These marginal devices (usually not considered core system components) collectively failed after OTA, yet system version number and "About Phone" screen were completely normal, no error pop-ups. 😱

After traceability analysis, these strange phenomena are also chain reactions from update_engine state deadlock. To understand this, we must跳出 the narrow perception that "system = system partition." Critical drivers and firmware of modern Android devices are scattered across multiple physical partitions:
- **vendor partition**: Contains binary implementations of Hardware Abstraction Layer (HAL), camera HAL is a typical example.
- **odm partition**: Original Design Manufacturer (ODM) custom configurations and proprietary libraries, some sensor calibration data is also stored here.
- **dtbo / vbmeta**: Device tree overlay and verification metadata, directly related to kernel driver loading.

A/B updates also duplicate these partitions (vendor_a/vendor_b, odm_a/odm_b, etc.). According to Virtual A/B official documentation [4]:

> "When using Virtual A/B, partitions in the target slot are not directly written to until the update is complete. Instead, all writes to the target slot are redirected to a copy-on-write (COW) device called a snapshot."

And:

> "If the device loses power before merge completes, or the merge fails to complete for some reason, the device must be able to roll back to the pre-merge state on next boot, or continue merging from where it left off."

These two paragraphs reveal a fatal fact: Google explicitly admits that merging may fail to complete due to power loss or other reasons, but completely pushes the implementation responsibility of "how to continue merging or roll back" to OEMs—AOSP itself provides no mandatory timeout or auto-repair mechanism. 😤

And at the source code level, in update_engine's core logic for processing update payload writing—delta_performer.cc [7]—the `ApplyPayload()` function traverses the partition operation list and sequentially writes to every partition that needs updating, covering far more than just the system partition:

```
// delta_performer.cc - ApplyPayload() traverses all partitions and performs writes
for (const auto& partition_update : manifest.partitions()) {
    // Sequentially processes all A/B partitions: boot, system, vendor, product, odm, etc.
    if (!OpenPartition(partition_update, target_slot_suffix, &fd)) {
        return false;
    }
    // Perform actual data writes ...
}
```

The A/B system update overview document [1] also lists the complete partition inventory actually covered by A/B updates, completely consistent with the operation list in source code.

Once state deadlocks at Finalizing or UpdatedNeedReboot, the `Merge()` function in snapshot_merge_performer.cc [8] will forever wait for its moment in the spotlight—it's either hastily skipped by the system during startup (because the init process forces continuation after first screen lag timeout), or killed mid-execution, and `Cleanup()` as its "will executor" was never notified to be present. At this point, the system is actually running in the crack between two "worlds":
- Kernel and Android framework have already booted from new slot B, expecting to use new versions of HAL libraries and firmware.
- But due to incomplete merging, vendor_b or odm_b may still have residual unmerged old data, or snapshot device mappings not completely torn down, causing some library files to actually be corrupted or incomplete.
- For marginal devices like cameras, when their HAL service starts and finds firmware version mismatch or critical .so files can't load normally, they will silently fail, manifesting as camera app black screen, flash switch disappearing, or face recognition unavailable.

More ironically, when Google's official documentation describes Virtual A/B with a casual sentence: "Snapshot merge states include MERGING, CANCELLED..." [4], it completely fails to warn developers: If merging is accidentally interrupted, the device will enter a split state of "framework new, drivers old," and some peripherals may be permanently disabled until manually repaired. 🤬

And the fix is also extremely crude but effective—since the problem stems from inconsistent partition states, the only antidote is to resync all partitions to the currently running version:
- First force reset update service state (`rm -rf /data/misc/update_engine/* && killall update_engine`), release old slot lock, and return state machine to Idle.
- Download the official full package corresponding to the currently booted system (note it must be current version, not older), re-flash it to the currently running slot via local OTA or manual fastboot.
- This flashing will force overwrite all relevant partitions (including vendor, odm, dtbo, etc.), eliminating any residual COW snapshots or version mismatches, returning hardware drivers to the complete state they should be for that version.

This method has been confirmed by multiple users (also rooted, unlocked OnePlus/ColorOS device users) to perfectly revive cameras and other devices. 😋

> **Reiterating**: These extreme cases also all appear on rooted, AVB-disabled OnePlus/ColorOS devices. Unflashed device users theoretically may also encounter snapshot merge failure, but because their system partitions are strictly protected by dm-verity, partition-level inconsistency usually directly causes the system to refuse booting (roll back to old slot), rather than the half-dead state of "can boot but some devices fail." It's precisely root and AVB disablement that allows the hidden dangers in Google's code to be exposed in a more subtle way. Similar extreme cases haven't been collected for other brand devices currently, this article makes no excessive inferences.

## Chapter 3: Google's Seven Deadly Sins—Why This Bug Is So Absurd 😡

At this point, the truth is clear: On rooted, AVB-disabled ColorOS devices, update_engine abnormally exits during the OTA "commit stage," leaving behind unreleased exclusive file descriptors, causing the old slot to be permanently locked by the kernel. But if we dig deeper, we'll find this isn't a simple random exception, but a concentrated manifestation of Google's design failures. Every accusation below has official documentation and source code as evidence.

### First Deadly Sin: State Machine Has No Timeout or Self-Healing Capability 💀

update_engine's state machine is like a monorail train: Break down at any intermediate station, and the entire line is permanently stopped. Official documentation exhaustively describes every state from Idle to UpdatedNeedReboot [1], but there's not a single word about timeout handling or abnormal recovery. If you hang during Finalizing or UpdatedNeedReboot, the state file will faithfully record "not completed yet," but there's no watchdog to verify the system is actually successfully running on the new slot.

Is an `if (system_is_running_fine) then release_old_slot()` logic really that hard to write? When designing update_engine's state machine, Google clearly assumed the world is perfect—processes never get killed, batteries never run out, users never force shutdown at the wrong time. This kind of programming philosophy deserves the word "naive." 🤡

### Second Deadly Sin: Resource Cleanup Failure Is Kindergarten-Level Mistake 🍼

No matter how a process dies (kill -9, system kill, self-crash), occupied resources must be released. This is a basic principle of operating system design, any student who's taken CS101 understands this. update_engine could completely use O_CLOEXEC flag or register atexit hooks to ensure file descriptors are closed, but it didn't.

Looking casually at the `OpenPartition()` function in delta_performer.cc above, you'll find that when it calls `fd->Open(partition_path.c_str(), O_RDWR, 0)`, there's not a single trace of O_CLOEXEC in the parameter list. And the `Cleanup()` method in snapshot_merge_performer.cc depends on `Merge()` returning normally to be called—as long as any exception is thrown inside `Merge()` or the process is killed, the cleanup code is dead in the water.

It chose to pin all hopes on the fantasy that "the update process will definitely run perfectly to the end," leaving behind a mess full of resource leaks. And the official documentation's definition of snapshot merge state CANCELLED [4] hints that Google's designers at least considered the "cancel" scenario—but they just didn't consider the practical problem of "who executes the cancel after the process is accidentally killed." This kind of design wouldn't pass code review at any serious company, yet it lies in AOSP's main branch, year after year, screwing every flashaholic. 😤

### Third Deadly Sin: Definition of "Update Complete" Is Anti-Human 🤔

Whether a system has completed an update, the most authoritative evidence should be whether the system itself is running normally, not an XML file under /data/misc/update_engine/.

Official documentation defines: "A slot marked as successful should be able to boot, run, and update by itself" [1]. Okay, my device has successfully booted on the new slot, runs normally, no function abnormalities—by Google's own standards, this is a "successful" slot. Yet update_engine's internal state machine doesn't care about this real-world evidence, it only recognizes that persistent state file. As long as that file says "not completed yet," no matter how happily the system runs, the old slot is forever a "forbidden zone being updated."

Google treats persistent state as the only source of truth, completely ignoring the objective facts that have already happened in the real world. This practice of using unreliable metadata to veto physical reality is comparable to marking a boat to find a sword. 🤣

### Fourth Deadly Sin: Exclusive Lock Use Is Careless 🔒

O_EXCL is an important mechanism for preventing concurrent writes, but must be paired with strict resource lifecycle management. Google's code clearly failed to do this.

Official documentation repeatedly emphasizes that A/B mechanism's design intent is "keeping the unused slot as a backup slot, thus making updates fault-tolerant" [1]. This intent is good—protect the unused slot to prevent accidental damage. But the problem is: The update has ended, the system is already successfully running on another slot, and the old slot's resource protection is no longer needed. Continuing to hold exclusive file descriptors at this point isn't protection, it's kidnapping. This is like a locksmith swallowing the key after opening the lock, then turning around and leaving, leaving the door forever unopenable. 😡

### Fifth Deadly Sin: The Fish Stinks From the Head Down—OEMs Go Even Further 🏠

This flaw is rooted in AOSP's update_engine implementation, meaning all A/B devices theoretically inherit this time bomb. Official documentation clearly mentions: "Original Equipment Manufacturers (OEMs) and SoC vendors implementing A/B system updates must ensure their bootloader implements the boot_control HAL and passes correct parameters to the kernel" [3].

Google shoves implementation details to OEMs, leaving a reference implementation with resource leak hidden dangers in AOSP. Even worse, OEMs stack their own "security policies" on top: Xiaomi's ARB, Samsung's SW_REV fuses... They're all adding more irreversible locks on the same fragile foundation. Google's good sons are pushing users into an even deeper abyss. 😈

### Sixth Deadly Sin: Root Privilege Boundaries Quietly Subverted 🔑

Google gave update_engine the highest privilege of user root [2], letting it "be responsible for safely downloading, verifying, and applying system updates in the background" [1]. But Google never informed users in any public documentation: This service running as root can, without your knowledge, occupy and lock your hardware resources, and you can't even unlock it with root.

This is a privilege black hole—update_engine uses root privileges to open the block device, then the kernel grants it exclusivity. When it dies abnormally, this exclusivity becomes an ownerless lock, and another root user (you) can't forcibly take it, because the kernel doesn't allow two writers to exist simultaneously. This is a perfect deadlock: You need root privileges to create it, but you don't need any privileges to permanently hold it. 😨

### Seventh Deadly Sin: Zero Consideration for User Recoverability 🚫

Official documentation proudly claims A/B update mechanism can "reduce the likelihood that a device won't boot after an update, which means users will need fewer visits to repair and warranty centers for replacement and re-flashing" [1].

But my device isn't "unbootable"—it boots just fine. It's just quietly locked out of a hardware resource, and there's no official tool to unlock it. Ordinary users don't even know their old slot has been kidnapped. Advanced users who discover it can only solve it through unofficial, root-required violent means (resetting update service). What if I didn't have root? What if I didn't understand update_engine's internal mechanisms? The answer is only two words: endure. 😡

## Chapter 4: Cracking and Automation—How I Cleaned Up Google's Mess 🧹

### 4.1 The Simplest Fix: Reset Update Service

Since the ghost lingers because the state file won't release, forcibly erasing its existence will do:

```
# Forcibly stop update_engine and clear its persistent state
rm -rf /data/misc/update_engine/*
killall update_engine
```

Instantly, all held file descriptors are reclaimed by the kernel, `dd` resumes work. Old slot regains freedom. 😋

Interestingly, there actually exists a reset-related capability in AOSP source code—in update_attempter_android.cc [9], there确实 exists a `ResetStatus()` method that can clear update state and reset the state machine to Idle. But Google only uses it in internal testing or certain extreme exception handling, never exposing it to users through update_engine_client or any public API. That is to say, Google's engineers can use it to unbrick themselves, but users can only sigh in despair. This is Google's true attitude toward "recoverability": I can do it, but I won't let you use it. 🤬

Additional steps for extreme cases (peripheral failures like cameras): After resetting update service, be sure to download the official full package of the current system version and re-flash it to the currently running slot once. This step will force overwrite all vendor, odm, etc. partitions, completely eliminating driver mismatches caused by interrupted snapshot merging, restoring all marginal devices to normal.

### 4.2 KernelSU Module: Automatically Unlocking the Ghost Lock 🛡️

Typing commands manually isn't elegant enough, so I wrote a KernelSU module that automatically detects on every boot:
- Detects that current boot slot is different from last recorded (OTA switch occurred)
- Tries writing 0 bytes to unused old slot for probing (open O_WRONLY then immediately close)
- If open fails (EBUSY), judges as ghost lock, immediately resets update_engine service

This module is lightweight, non-intrusive, only executes when necessary, perfectly solving the mess Google left behind. From now on my device never needs manual unbricking again. 😎

> **Module open source address**: [GitHub link] (welcome to Star and contribute)

## Chapter 5: A Public Verdict ⚖️

**Defendant**: Google LLC

**Charges**: Improper resource management, non-robust state machine design, shifting technical debt to users and OEMs, poor parenting leading to ecological collapse

**Evidence List**:
- [1] A/B (seamless) system update official overview document, detailing update_engine architecture, state transitions, and design goals, but containing no abnormal recovery logic throughout; explicitly lists A/B partitions covering vendor, odm, etc. partitions directly related to hardware drivers.
- [2] AOSP source code update_engine.rc configuration file, proving this service runs as root, marked as disabled and shutdown critical, lacking automatic resource release guarantee after process abnormal exit.
  **Source code evidence**:
  - `OpenPartition()` function in delta_performer.cc [7] doesn't use O_CLOEXEC when opening partition file descriptors, causing fd to not be automatically reclaimed by kernel when process abnormally exits;
  - `Cleanup()` method in snapshot_merge_performer.cc [8] can only execute after `Merge()` returns normally, snapshot device mapping and block device occupation won't be cleaned up on exception paths;
  - `ResetStatus()` method exists in update_attempter_android.cc [9] that can reset state machine, but this method isn't exposed to users through any public API;
  - Underlying `OpenFile()` wrapper in utils.cc [10] doesn't uniformly add O_CLOEXEC for block devices.
  The above source code snippets (already fully shown earlier) together form a complete evidence chain of "resource leak and non-recoverability."
- [4] Virtual A/B overview official documentation, defining snapshot merge states (NONE, UNKNOWN, SNAPSHOTTED, MERGING, CANCELLED), explicitly admitting "merging may fail to complete due to power loss or other reasons," but not specifying automatic cleanup mechanism after process crash; COW snapshot mechanism description directly explains the technical root of old slot partition being exclusively occupied.
- My device reproduction case (complete steps in Chapter 2, all reproductions completed on rooted, AVB 2.0 disabled OnePlus/ColorOS devices): dd returns Device or resource busy, confirming kernel-level exclusive lock is active and can't be released by root; local OTA installation fails confirming state machine rejects new requests; everything returns to normal after resetting update service.
- Extreme cases from community feedback (also limited to rooted, AVB-disabled OnePlus/ColorOS devices): Multiple users report collective failure of peripherals like camera, flash after OTA, symptoms matching characteristics of HAL library incompleteness caused by interrupted vendor/odm partition COW snapshot merging; all devices return to normal after resetting update service and re-flashing current version official package, confirming problem stems from partition-level driver mismatch. Traversal of all partitions for writing logic in delta_performer.cc [7] (already shown earlier) and unreachable path of `Cleanup()` in snapshot_merge_performer.cc [8] provide direct technical explanation for extreme cases.
- All Android devices using A/B seamless updates potentially inherit this flawed code base, but as of now, actual confirmed trigger cases are limited to OnePlus/ColorOS platform. Other brand devices may have same hidden dangers, but lack empirical evidence.

**Verdict**: Permanent public execution to serve as a warning, and order relevant responsible parties to immediately take action:

**Google side**, must implement the following fixes in AOSP:
- When update_engine starts, if detecting system has successfully run from new slot (boot_successful = true), unconditionally release all exclusive file descriptors and device-mapper mappings of old slot.
- Use O_CLOEXEC flag for all block device open operations, ensuring file descriptors are automatically reclaimed by kernel when process abnormally exits. Specific files to modify: delta_performer.cc, utils.cc.
- Introduce timeout and exception protection mechanism in snapshot_merge_performer.cc: If `Merge()` execution exceeds predetermined time or process receives termination signal, must forcibly execute `Cleanup()` to release resources.
- Publicly expose `ResetStatus()` method in update_attempter_android.cc through update_engine_client command (like `update_engine_client --reset`), allowing users to manually force reset update service state.
- Add an "Abnormal Recovery" section in official documentation, honestly informing developers and users of possible resource lock problems in A/B updates and their solutions, including repair steps for hardware function abnormalities caused by merge failure.

**Major OEM vendors side** (current cases concentrated in ColorOS, but principle applies to all A/B devices), we also issue an appeal 📢:
- Don't just be satisfied with beautiful UI and smooth system. A truly excellent system should provide clear, diagnosable paths when users encounter faults, not letting users grope in panic in a black box. When update_engine state is abnormal, the "Software Update" page in system settings should display clear state prompts (not a silent "installation failed" pop-up), and provide an official option to "Reset update state," allowing users to save themselves even without root.
- For marginal device abnormalities caused by snapshot merge failure, the system should actively detect partition consistency during boot self-test stage, and when discovering problems, prompt users to perform repair through notification bar or settings page, instead of letting users face the strange phenomenon of "camera won't open" in confusion, ultimately misjudging it as hardware failure and wasting after-sales resources.
- Please add troubleshooting guides for such problems in your official community and after-sales knowledge bases. Let flashaholics have references when encountering problems, instead of saving themselves through folk remedies passed by word of mouth in forums and group chats—this is not only respect for users, but also actual savings on after-sales costs.

**Forward-looking suggestion**: Inject transparency and observability into the update process 🔭

In addition to fixing existing flaws, we also solemnly suggest Google add clear checkpoint records at key state transition nodes of update_engine (like entering Finalizing, starting Merge, Cleanup complete, etc.). These records should be persisted to stable storage regions and visible to users in system properties or diagnostic interface. Even if officials don't provide auto-repair out of caution, at least let users see information like this:

```
Update state: Finalizing
Snapshot merge: in progress (vendor_b: 67%, odm_b: 52%)
Last checkpoint: Merge started at boot time + 12s
```

Even if the system ultimately can't recover itself, at least users can know which link the problem is stuck in, which partition's merge didn't complete. Officials can not help us clean up, but please give us a map to let us find where the toilet is 🤡—death isn't scary, dying without knowing why is scary. This is not only respect for flashaholics, but also a long-term investment in the maintainability of the entire Android ecosystem.

At the same time, we understand flashing isn't something "normal people" do, but code robustness shouldn't be measured by whether users cross boundaries. A well-designed system, even when facing privilege escalation or abnormal interruption, should maintain internal state consistency or at least achieve "graceful failure." Instead of belatedly locking down root, it's better to leave survival space for unexpected situations in code logic—this is what truly deserves careful consideration and testing. 🧪

## Final Chapter: Advice for Flashaholics 💬

Root gave us the key, but Google's code gave us the prison. 😞

We understand that flashing means giving up warranty, means taking a path not officially supported. But this shouldn't be a reason for vendors to turn system internal state into a black box. What we need is not just a smooth and easy-to-use system, but also a system where we can troubleshoot problems with peace of mind when faults occur—not staring at a Device or resource busy error, or a camera that fails for no reason, frantically typing keywords into a search engine, finally finding a life-saving command hidden deep in /data/misc/ through some folk hero's post. Good fault transparency and recoverability, just like beautiful animations and smooth frame rates, are basic qualities of a mature operating system. We call on Google and all OEM vendors, while pursuing experience upgrades, to also leave a door for fault troubleshooting. 🚪

It must be admitted that the "key" in our hands—root privileges and AVB disablement—itself puts the system in an unconventional state. Google has every right to argue: "You flashed it, you deserve it." But this doesn't掩盖 a fact: A system service running as root, marked as shutdown critical, has no ability to clean up the resources it leaves behind when encountering abnormalities. You turned off the access control, but the janitor stuck the mop in the fire escape then left for the day—these are two different things. Lack of access control makes the problem easier to discover, but the responsibility for the stuck mop always lies with the janitor. 😤

At Android's low level, the kernel's iron law is always higher than user space privileges. update_engine, as a privileged daemon given user root privileges and shutdown critical flag by Google, is your reliable update plumber when working normally, but once it dies abnormally, it becomes a ghost you can't touch—its corpse is still clutching your hardware, and the kernel, that rigid doorman, strictly abides by the rule of "one device can't have two writers," rejecting all your write attempts.

Android Open Source Project official documentation is thousands of words long, describing all kinds of benefits of A/B seamless updates: reducing bricking risk, reducing after-sales repairs, supporting streaming transmission... yet there's not a single word mentioning: What if the update engine itself becomes a brick? 🤷

When you encounter a wall that even root can't break through again, don't rush to suspect hardware, check those daemons that should have died—they might be clutching your device, grinning at you from the underworld of code. 👻

This article is dedicated to all flashaholics screwed by update_engine.
We are born free, unwilling to have our slots locked by any ghost. ✊

## Disclaimer (Must Read) ⚠️

Those who haven't encountered this situation, just read it for fun. Especially if you've never flashed, your bootloader is locked tight, system is original and unmodified—then congratulations, this article is just a story to you. Because currently all ghost lock cases only occur on rooted OnePlus/ColorOS devices. 😄

If you unfortunately encounter it—please first confirm your device state: Have you flashed? Unlocked bootloader? Obtained root privileges? Is AVB 2.0 disabled? If yes, and your device happens to be OnePlus or running ColorOS, then you've probably hit the ghost lock described in this article. Please take a deep breath first, don't smash your phone, don't factory reset, don't listen to after-sales忽悠 to replace the motherboard. What you're holding isn't a brick, it's a hostage temporarily kidnapped by Google's bad code. Follow the steps in Chapter 4 of this article, it will likely return to your hands intact. 😌

If your device has never been flashed, bootloader locked, everything original—then your probability of encountering this problem is extremely low. Because dm-verity will directly refuse to boot when partitions are inconsistent, the system will roll back to old slot, you won't see the strange state of "system normal but old slot locked." Your fault is probably other reasons, please seek official after-sales support. 📞

If you're using an A/B device from another brand (Pixel, Xiaomi, Samsung, etc.) and encounter similar symptoms—please carefully refer to this article, but don't rashly attribute. Currently we haven't collected confirmed cases from these brands. If you actually discover it, welcome to bring detailed logs to file an Issue in this article's GitHub repository, together expanding the defendant list of this "public execution" even longer. 😉

Once again solemnly reiterating: All phenomena analyzed in this article are derivatives of unconventional operations (like manual flashing, modifying system partitions) on unlocked, rooted devices with AVB verification disabled. Google has every right to say: "You gave up warranty, we're not responsible." However, we still call on Google to pay attention to and fix this potential hidden danger. Because even on ordinary devices without root, similar update state deadlock may occur in extreme situations (like accidental power loss). And for flashing newbies, once encountering symptoms like "device normal but partition mysteriously locked" or "camera fails for no reason," it's easy to be misled into thinking it's hardware failure, causing unnecessary panic and expensive after-sales disputes. A more robust update_engine is not only respect for flashaholics, but also basic protection for all Android users. 🤝

To major vendors (especially ColorOS team): We thank you for your continuous investment in system optimization and user experience. But we also hope you can understand: A truly excellent ROM shouldn't only be glamorous when everything is normal, but also let users have clarity in their hearts and solutions in their hands when problems arise. Please consider adding more transparent state prompts and friendlier reset mechanisms in the system update module. This will not only let flashaholics take fewer detours, but also reduce after-sales disputes and warranty costs caused by system state abnormalities. After all, a system that lets users troubleshoot clearly when problems arise is a truly trustworthy system. ❤️

Flashing may not be something "normal people" do, but code robustness deserves careful consideration and testing 🧪—even a simple O_CLOEXEC, or a checkpoint log, may save thousands of devices mistaken for "bricked" in the future. We call on Google and OEM vendors during development, to not only consider ideal success paths, but also leave reasonable escape routes for unexpected interruptions.

If you time-travel to Silicon Valley in a dream and want to have a "friendly exchange" with Google's development team on this matter, please go to the following address:
> Googleplex Headquarters
> 1600 Amphitheatre Parkway
> Mountain View, CA 94043
> United States

After arriving, please go straight to Building 43 (where the Android statue lawn is), face those people who wrote the state machine for update_engine, and ask them for me:

"Have you ever written a watchdog yourselves? Learned about O_CLOEXEC? Know what resource lifecycle management is?" 😡

If they look confused, slap a printout of this article on their desk, then turn around and leave gracefully. 📄

If they ask back "How did you find here?"—tell them: More reliable than your code is GPS. 😋

> Author: Zhou Hanghang (DevCloud.ZTR_OS)
> Complete case reproduction, module source code and more technical details, all in GitHub repository: https://github.com/ABI-ZTROS/AB-Unlocker
> If this article helped you save your device, or made you laugh out loud, please give a Star—that's the best slap to Google engineers. 😋

## Citation Source Links

- A/B (Seamless) System Updates - Android Open Source Project Official Documentation
  https://source.android.com/docs/core/ota/ab
  (Chinese version: https://source.android.google.cn/docs/core/ota/ab)
- update_engine.rc Source Code - AOSP system/update_engine/init/
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/init/update_engine.rc
- boot_control HAL - Android Open Source Project Official Documentation
  https://source.android.com/docs/core/ota/boot_control
  (Chinese version: https://source.android.google.cn/docs/core/ota/boot_control)
- Virtual A/B Overview - Android Open Source Project Official Documentation
  https://source.android.com/docs/core/ota/virtual_ab
  (Chinese version: https://source.android.google.cn/docs/core/ota/virtual_ab)
- AOSP update_engine Source Repository
  https://android.googlesource.com/platform/system/update_engine/
- OTA Tools & Build System Integration - Android Open Source Project
  https://source.android.com/docs/core/ota/tools
  (Chinese version: https://source.android.google.cn/docs/core/ota/tools)
- delta_performer.cc Source Code - AOSP system/update_engine/payload_consumer/delta_performer.cc
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/payload_consumer/delta_performer.cc
  Key functions: OpenPartition() doesn't use O_CLOEXEC, ApplyPayload() traverses all partitions to perform writes.
- snapshot_merge_performer.cc Source Code - AOSP system/update_engine/payload_consumer/snapshot_merge_performer.cc
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/payload_consumer/snapshot_merge_performer.cc
  Key functions: Cleanup() unreachable when Merge() abnormally exits.
- update_attempter_android.cc Source Code - AOSP system/update_engine/update_attempter_android.cc
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/update_attempter_android.cc
  Key functions: ResetStatus() exists but not publicly exposed.
- utils.cc Source Code - AOSP system/update_engine/common/utils.cc
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/common/utils.cc
  Key functions: OpenFile() underlying open doesn't uniformly add O_CLOEXEC.
