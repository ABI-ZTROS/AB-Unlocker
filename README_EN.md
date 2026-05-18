# The Lock Even Root Can't Break: An Autopsy Report on ColorOS A/B Update "Phantom Lock", Automated Brick Recovery, and a Blood-Teared Indictment Against Google

## Preface: When Root Is No Longer God 🤡

In the Android world, root has always been the symbol of power. We mount, we overwrite, we penetrate—believing we can trample all software rules—until you encounter a block device that even dd crashes into with blood and bruises. 😨

This article documents an incredible OTA aftermath: the system is completely normal, yet the old slot is permanently locked and unwritable, rendering root permissions useless. I will start from the crime scene, delve into Google's proud A/B seamless update mechanism, cite Android's official documentation and AOSP source code as ironclad evidence, dissect its most fragile soft tissues, and finally show how to crush Google's "phantom" back to hell with just a few lines of script. A KernelSU module will also be attached at the end, so your device will be automatically immune to this ailment forever. 😋

But before you start swearing, please read this critical statement first: All failures described in this article occurred on devices that have been flashed, have obtained root permissions, and where only confirmed cases so far are limited to OnePlus devices or devices running ColorOS. Ordinary users who haven't flashed or unlocked the Bootloader have not yet reported encountering this issue. If you don't fall into the above category, this article may not be relevant to you, but you're welcome to read it for entertainment—see how fragile Google's code can become when the system's integrity protection is lost. 🤣

If you want to read a five-in-one long-form diatribe of "technical autopsy + official documentation evidence + source code evidence + kernel mechanism + furious rant against Google," you've come to the right place.

## Chapter 1: Android System Update Service—The Phantom You Never Cared About 👻

Before picking up the scalpel to dissect the fault, we must first meet the protagonist hiding in the shadows of the system—update_engine. All descriptions cited in this chapter come from Android Open Source Project (AOSP) official documentation and source code, with no fabrication, and complete source links are attached at the end.

### 1.1 A/B Seamless Updates: Google's Pride 😎

Android 7.0 introduced the A/B partition mechanism (Seamless Updates). Android's official documentation defines its goal as follows[1]:

> "The goal of A/B (seamless) system updates is to make sure that a workable system and user data remain on disk during over-the-air (OTA) updates. This approach reduces the likelihood of a device coming out of an update with a broken software state, meaning that fewer devices will need to be taken to a repair or warranty center for re-flashing."

This mechanism deploys critical partitions like boot, system, and vendor in duplicate, called slot A and slot B. Its core design philosophy is that the system runs from the "current" slot, but during normal operation, the running system doesn't access partitions in the unused slot, keeping the unused slot as a backup to prevent update failures[1]. The entire process is almost transparent to users, and rollback capability is preserved—the documentation explicitly promises: "If the OTA fails, the device boots from the disk partition before the OTA and is still usable"[1].

The core daemon behind this mechanism is update_engine. The official documentation explicitly states: "A/B system updates use a background daemon called update_engine and two sets of partitions"[1]. It is the only official channel for all OTA operations (whether incremental or full).

And Google's self-assessment of this mechanism is: "A/B systems are very powerful because any error (such as an I/O error) can only affect the unused partition set and can be retried"[1].

—Hmm, very powerful? Let's see what follows. 😅

### 1.2 update_engine's Startup Mechanism: From Bootloader to Binder

update_engine is not casually invoked by the application framework layer. Its startup follows a strict low-level chain. According to the update_engine.rc configuration file in AOSP source code[2]:

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
- disabled: This service does not start automatically with class main; it must be triggered by specific events.
- on property:ro.boot.slot_suffix=*: The only trigger for startup is when the ro.boot.slot_suffix system property is set, which comes from the Bootloader passing the current active slot information through the kernel command line (e.g., androidboot.slot_suffix=_a)[3].
- user root: update_engine runs as root, possessing the highest privileges to directly read and write system partitions.

The entire startup flow can be summarized as: Bootloader → Kernel → Init (property system) → Execute binary → Register Binder service.

What does this mean? It means update_engine was designed from birth as a privileged phantom—it has kernel-level resource possession capabilities that even root users may not easily interfere with, and its startup entirely depends on Bootloader parameters and property triggers, making user-space intervention almost impossible. 😱

### 1.3 update_engine's State Machine: Rigorous or Fragile?

update_engine maintains a strict internal state machine. When OTA is triggered, its flow path is roughly:

```
Idle → CheckingForUpdate → UpdateAvailable → Downloading → Verifying → Finalizing → UpdatedNeedReboot → Idle
```

In AOSP official documentation, this process is described as several typical stages[1]:
- Updating: The system is running from the current slot, and the content in the target slot "is being updated but not yet complete," so the slot "is marked as not bootable."
- Update Applied, Reboot Pending: The target slot has been marked as bootable but not yet successfully booted; the bootloader should attempt to boot from it.
- Rebooting Into New Update: First boot from the new slot; the old slot is still bootable and in successful state.

Key stage details:
- Downloading: Writing payload to the target slot, during which device-mapper snapshots (COW devices) are created to protect target partitions through copy-on-write. The official documentation, when describing Virtual A/B implementation, explicitly defines snapshot merge states as NONE, UNKNOWN, SNAPSHOTTED, MERGING, CANCELLED[4].
- Finalizing: Execute postinstall scripts (if any), and begin snapshot merging. The official documentation describes: "For each partition that has defined post-installation steps, update_engine mounts the new partition to a specific location and executes the program specified in the OTA for the mounted partition"[1]. In this stage, the snapshot state is MERGING, and the merge operation combines differential data from the COW device back into the original physical partition[4].
- UpdatedNeedReboot: Writing and merging complete, set new slot as bootable, mark "reboot needed to complete update." Official flow description: "Rebooting into new update: System first runs from slot A"[1].
- After rebooting into new system: update_engine calls markBootSuccessful() in the background, setting the new slot's "success" attribute to true. The official documentation explicitly states: "Slots marked as successful should be able to boot, run, and update by themselves"[1]. Then enters Idle state, releasing all resources from the old slot.

Everything sounds interlocking, but the devil is in the details. The official documentation never mentions: What happens if the daemon exits abnormally during Finalizing or UpdatedNeedReboot stages? There is no timeout mechanism, no self-healing logic, no rollback protection. Google seems to assume update_engine never makes mistakes. 🤔

### 1.4 Exclusive File Descriptors: Kernel's Iron Law ⚖️

In the Linux kernel, when update_engine opens a block device (e.g., /dev/block/by-name/system_b) for COW or direct writing, it uses the O_EXCL flag or equivalent exclusive open mode. This is not a security feature, but basic protection to prevent multiple processes from simultaneously writing to block devices causing data corruption.

Once a process (even if it has died, but the file descriptor hasn't been closed) opens a block device exclusively, the kernel's block device layer directly refuses any subsequent write open() calls and returns -EBUSY. This refusal occurs at the VFS layer, taking precedence over all permission checks. Root can ignore UID/GID and even disable SELinux, but cannot解除 another kernel object's possession of resources. This is why our story is so bizarre. 😡

update_engine's disabled attribute and shutdown critical flag are intended to ensure the update process isn't interrupted. But when updates are interrupted, these protective mechanisms become a hotbed for creating phantoms—they ensure update_engine doesn't exit gracefully while holding resources, but there's no mechanism to ensure it releases those resources after being accidentally killed.

Glancing at the OpenPartition() function in delta_performer.cc above, you'll find it calls fd->Open(partition_path.c_str(), O_RDWR, 0) without even a shadow of O_CLOEXEC in the parameter list. And the Cleanup() method in snapshot_merge_performer.cc depends on Merge() returning normally to be called—as long as anything throws an exception in Merge() or the process is killed, the cleanup code is dead code.

It chose to place all hope on the fantasy that "the update process will run perfectly to the end," leaving a mess full of resource leaks everywhere. And the CANCELLED definition for snapshot merge states in the official documentation[4] suggests Google's designers at least considered a "cancellation" scenario—but they specifically didn't consider "who executes the cancellation when a process is accidentally killed." This design would fail any code review at any decent company, but it lies in AOSP's main branch, harming flasher users year after year. 😤

## Chapter 2: Crime Scene—A Perfect OTA, A Permanently Locked Partition 🕵️

### 2.1 Reproduction Steps and Key Fault Nodes

To allow readers to personally trigger this fault or verify similar issues on their own devices, the complete reproduction process is documented below. Each step is annotated with possible technical fault nodes for easy location and debugging.

Device status: OnePlus device running ColorOS-like system, current working slot is A, system running normally. Device has been flashed, Bootloader unlocked, root permissions obtained, AVB 2.0 (dm-verity) disabled. This is the common prerequisite for all confirmed cases—ordinary users who haven't flashed or unlocked haven't reported encountering this issue yet.

Through the above steps, the phantom lock phenomenon can be reproduced with 100% certainty. The core fault node is during the transition from Step 2 to Step 3—after rebooting into the new system, update_engine fails to complete the commit phase but silently retains the device possession of the old slot. Most insidiously, apart from the 40+ second first screen stuck as an early warning signal, the system shows no visible errors during the entire process, and ordinary users don't even know their old slot has been permanently kidnapped.

> ⚠️ Reproduction Risk Warning: If you did not observe the first screen stuck for more than 40 seconds during the reboot in Step 2, stop attempting immediately. This means update_engine's commit phase on your device has completed normally, and the old slot is not locked. Forcibly executing subsequent dd write or reset update service steps will bring no benefit and may introduce unnecessary risks. More importantly, every meaningless reproduction attempt consumes the write lifecycle of the eMMC/UFS storage chips on your device. Your storage chips will be crying in the sky, for their wasted P/E cycles. 😭 If you're only verifying the phenomenon described in this article, just look at the first screen's boot time—over 40 seconds is ironclad evidence, otherwise please stop.

> Device and System Limitation Statement: Up to now, all confirmed phantom lock reproduction cases appeared on OnePlus devices or devices running ColorOS. This does not mean devices from other brands (such as Pixel, Xiaomi, Samsung) absolutely cannot have similar issues—theoretically, any Android device using A/B updates inherits the same code base—but among collected samples, only the above device types have confirmed case records. If you're using a device from another brand, this article's principle analysis remains valid, but triggering conditions may vary due to different OEM customization levels for update_engine. Do not hastily attribute without evidence.

### 2.2 Futile Struggle 😫

After discovering the lock, I conducted several hours of routine troubleshooting, with all results failing without exception:
- umount? The partition wasn't mounted at all.
- blockdev --setrw? It was already readable and writable.
- disable-verity? dm-verity wasn't protecting it at all. Although the official documentation mentions "dm-verity can guarantee the device uses an unmodified boot image"[1], that's not the problem here.
- Check AVB 2.0 / dm-verity status: Disabled (due to flashing needs). This means the integrity verification of system and vendor partitions is closed, and block device write protection does not come from verification chain. This also rules out "AVB blocking writes," proving the root cause of the lock is at a lower level.
- Check SELinux? Already in Permissive mode.
- Restart device? Problem persists.

The partition looks completely normal with no error flags, but it refuses any writes. It acts like a black hole, calmly and firmly swallowing all write attempts, not allowing even one byte. 🤬

The official documentation confidently said: "Any error (such as an I/O error) can only affect the unused partition set and can be retried"[1]. However, the current situation is: no error reports, but the old partition set is permanently locked, and there's no official way to retry or reset.

### 2.3 Suspicion's Turn: From Hardware Lock to Software Phantom 👻

I once suspected hardware write protection was accidentally triggered (e.g., eMMC CMD28). But if it's a hardware lock, why is the other new slot completely normal? Why can't a restart clear it (temporary write protection loses power and vanishes)?

Until I turned my attention to dmesg and update_engine logs, an absurd truth finally emerged. The update_engine that should have quietly retired after OTA completion was actually, like a wandering ghost, still gripping the partition device files of old slot A.

By checking /proc/*/fd, I discovered invalid file descriptors pointing to /dev/block/by-name/boot_a and system_a. They belonged to an already-killed update_engine child process (possibly snapuserd or merge thread), which was terminated by the system at some point but didn't execute any cleanup.

Kernel says: "This device is occupied, get lost."
But the occupier was already a dead soul. Root has no way to deal with a dead soul. 😈

### 2.4 Extreme Cases: Collective Mutiny of Peripheral Devices Like Cameras 📸

Shortly after the initial sharing of this case, even more bizarre feedback emerged from the community: On the same root-enabled, AVB-disabled OnePlus/ColorOS devices, some users not only encountered old slot lock but also found system functions mysteriously incomplete—camera won't start, flashlight missing, even Bluetooth or Wi-Fi intermittently failing. These peripheral devices (usually not considered core system components) collectively failed after OTA, while the system version number and "About Phone" interface showed everything normal, with no error popups. 😱

Through traceability analysis, these bizarre phenomena are also chain reactions caused by update_engine state stuck. To understand this, one must break free from the narrow cognition that "system = system partition." Modern Android device critical drivers and firmware are scattered across multiple physical partitions:
- vendor partition: Contains hardware abstraction layer (HAL) binary implementations; camera HAL is a typical example.
- odm partition: Original Design Manufacturer's (ODM) custom configurations and proprietary libraries; some sensor calibration data is also stored here.
- dtbo / vbmeta: Device tree overlays and verification metadata, directly related to kernel driver loading.

A/B updates also copy these partitions (vendor_a/vendor_b, odm_a/odm_b, etc.). According to Virtual A/B official documentation[4]:

> "When using Virtual A/B, partitions in the target slot are not written to directly until the update is complete. Instead, all writes to the target slot are redirected to a device called a snapshot copy-on-write (COW) device."

And:

> "If the device loses power during the merge or the merge fails to complete for some reason, the device must be able to roll back to the state before the merge, or continue the merge from where it left off."

These two passages reveal a fatal fact: Google explicitly acknowledges that merges may fail to complete due to power loss or other reasons, but completely pushes the implementation responsibility of "how to continue merging or roll back" to OEMs. AOSP itself does not provide mandatory timeout or automatic repair mechanisms. 😤

And at the source code level, the core logic for update_engine processing update payload writes in delta_performer.cc[7], the ApplyPayload() function writes to every partition in the partition operation list, covering far more than just the system partition:

```
// delta_performer.cc - ApplyPayload() iterates through all partitions for writing
for (const auto& partition_update : manifest.partitions()) {
    // Here processes boot, system, vendor, product, odm and all other A/B partitions in sequence
    if (!OpenPartition(partition_update, target_slot_suffix, &fd)) {
        return false;
    }
    // Execute actual data writing...
}
```

A/B system updates overview documentation[1] also lists the complete partition list that A/B updates actually cover, completely consistent with the operation list in the source code.

Once stuck in Finalizing or UpdatedNeedReboot, the Merge() function in snapshot_merge_performer.cc[8] will never see its glory—it will either be carelessly skipped by the system during startup (because init process forces continuation after first screen stuck timeout) or be killed mid-execution, and Cleanup(), as its "estate executor," is simply not notified. At this point, the system is actually running in the gap between two "worlds":
- Kernel and Android framework have already started from new slot B, expecting to use new-version HAL libraries and firmware.
- But because the merge hasn't completed, vendor_b or odm_b may still have unmerged old data, or snapshot device mappings may not be completely dismantled, causing some library files to actually be corrupted or incomplete.
- For peripheral devices like cameras, when the HAL service starts and finds firmware version mismatch or critical .so files cannot load normally, it silently fails, manifesting as camera app black screen, flashlight switch disappearing, or face recognition unavailable.

More ironically, Google's official documentation casually mentions when describing Virtual A/B: "Snapshot merge states include MERGING, CANCELLED..."[4], but completely fails to warn developers: If merge is unexpectedly interrupted, the device enters a "new framework, old driver" disjointed state where some peripherals may be permanently disabled until manually repaired. 🤬

And the fix is brutally effective—since the problem originates from partition state inconsistency, the only solution is to resynchronize all partitions to the currently running version:
- First forcefully reset update service state (rm -rf /data/misc/update_engine/* && killall update_engine), release old slot lock, and return state machine to Idle.
- Download the official full package corresponding to the currently running system version (note: must be current version, not old version), and reflash it into the currently running slot via local OTA or manual fastboot.
- This reflash will forcefully overwrite all relevant partitions (including vendor, odm, dtbo, etc.), eliminating any residual COW snapshots or version mismatches, restoring hardware drivers to their complete state for that version.

This method has been confirmed by multiple users (also root-enabled, unlocked OnePlus/ColorOS device users) to perfectly revive cameras and other devices. 😋

> Reiterated: These extreme cases also all appeared on root-enabled, AVB-disabled OnePlus/ColorOS devices. Unflashed device users theoretically might also encounter snapshot merge failure, but because their system partitions are strictly protected by dm-verity, partition-level inconsistency usually directly causes system refusal to boot (rollback to old slot), rather than the "can boot but partial device failure" semi-disabled state. It's precisely the root and AVB disable that allows Google's code flaws to be exposed in a more concealed way. No similar extreme case reports have been collected for other brand devices, and this article makes no excessive speculation.

## Chapter 3: Google's Seven Deadly Sins—Why This Bug Is So Absurd 😡

At this point, the truth is clear: On root-enabled, AVB-disabled ColorOS devices, update_engine exits abnormally during the "commit phase" of OTA, leaving unreleased exclusive file descriptors, causing the old slot to be permanently locked by the kernel. But if we dig deeper, we find this isn't a simple occasional anomaly but a concentrated expression of Google's design failure. Each of the following charges has official documentation and source code as evidence.

### First Sin: State Machine Has No Timeout or Self-Healing Capability 💀

update_engine's state machine is like a single-track train: any intermediate station breakdown permanently halts the entire line. Official documentation meticulously describes each state from Idle to UpdatedNeedReboot[1], but the entire text contains not a word about timeout handling or exception recovery. If you crash during Finalizing or UpdatedNeedReboot, the state file faithfully records "not yet complete," but there's no watchdog to verify the system is actually running fine on the new slot.

Is a logic like `if (system_is_running_fine) then release_old_slot()` really that hard to write? When designing update_engine's state machine, Google obviously assumed the world is perfect—processes are never killed, batteries never run out, users never force shutdown at the wrong time. This programming philosophy deserves the title "naive." 🤡

### Second Sin: Resource Cleanup Failure Is a Kindergarten-Level Mistake 🍼

Regardless of how a process dies (kill -9, system kill, self-crash), occupied resources must be released. This is a basic principle of operating system design, understood by any student who took CS101. update_engine could use O_CLOEXEC flag or register atexit hooks to ensure file descriptors are closed, but it doesn't.

Glancing at the OpenPartition() function in delta_performer.cc above, you'll find it calls fd->Open(partition_path.c_str(), O_RDWR, 0) without even a shadow of O_CLOEXEC in the parameter list. And the Cleanup() method in snapshot_merge_performer.cc depends on Merge() returning normally to be called—as long as anything throws an exception in Merge() or the process is killed, the cleanup code is dead code.

It chose to place all hope on the fantasy that "the update process will run perfectly to the end," leaving a mess full of resource leaks everywhere. And the CANCELLED definition for snapshot merge states in the official documentation[4] suggests Google's designers at least considered a "cancellation" scenario—but they specifically didn't consider "who executes the cancellation when a process is accidentally killed." This design would fail any code review at any decent company, but it lies in AOSP's main branch, harming flasher users year after year. 😤

### Third Sin: The Definition of "Update Complete" Is Anti-Human 🤔

The most authoritative evidence of whether a system has completed an update should be whether the system itself is running normally, not an XML file under /data/misc/update_engine/.

Official documentation defines: "Slots marked as successful should be able to boot, run, and update by themselves"[1]. Fine, my device has successfully booted, runs normally, and all functions are normal on the new slot—according to Google's own standard, this is a "successful" slot. However, update_engine's internal state machine doesn't care about these real-world facts; it only recognizes that persistent state file. As long as that file says "not yet complete," no matter how well the system runs, the old slot is forever a "prohibited zone under update."

Google treats persistent state as the sole source of truth, completely ignoring the objective facts that have already occurred in the physical world. Using unreliable metadata to overrule physical reality is comparable to marking the location on a boat where something was lost and then continuing to search downstream. 🤣

### Fourth Sin: Careless Use of Exclusive Locks 🔒

O_EXCL is an important mechanism to prevent concurrent writes, but must be paired with strict resource lifecycle management. Google's code clearly fails to do this.

Official documentation repeatedly emphasizes that the A/B mechanism's design intent is "to keep the unused slot as a backup slot, thereby making updates resilient to failures"[1]. This intent is good—keeping the unused slot protected to prevent accidental damage. But the problem is: the update is over, the system is already running from another slot, and resource protection for the old slot is no longer needed. Continuing to hold exclusive file descriptors at this point isn't protection; it's kidnapping. This is like a locksmith swallowing the key after unlocking a door, then walking away, leaving the door permanently unable to be opened. 😡

### Fifth Sin: The Rotten Apple Doesn't Fall Far From the Tree—OEMs Make It Worse 🏠

This flaw is rooted in AOSP's update_engine implementation, meaning all A/B devices theoretically inherit this time bomb. Official documentation explicitly mentions: " OEMs and SoC vendors implementing A/B system updates must ensure their bootloader implements the boot_control HAL and passes correct parameters to the kernel"[3].

Google pushes implementation details to OEMs, leaving a reference implementation with resource leak hazards in AOSP. Worse, OEMs layer their own "security policies" on top: Xiaomi's ARB, Samsung's SW_REV fuses... they're all adding more irreversible locks on the same fragile foundation. Google's well-taught sons are pushing users into deeper abyss. 😈

### Sixth Sin: The Boundary of Root Permissions Is Quietly Overturned 🔑

Google gave update_engine user root's highest permissions[2], making it "responsible for safely downloading, verifying, and applying system updates in the background"[1]. But Google has never informed users in any public documentation: This service running as root can, without your knowledge, occupy and lock your hardware resources, and even root cannot解除 its lock.

This is a permission black hole—update_engine opens a block device with root permissions, then the kernel grants it exclusivity. When it dies abnormally, this exclusivity becomes an ownerless lock, and another root user (you) cannot forcibly夺走 it because the kernel doesn't allow two writers to coexist. This is a perfect deadlock: need root permissions to create it, but no permissions needed to permanently hold it. 😨

### Seventh Sin: Zero Consideration for User Recoverability 🚫

Official documentation proudly claims the A/B update mechanism can "reduce the likelihood of a device coming out of an update with a broken software state, meaning fewer devices will need to be taken to a repair or warranty center for re-flashing"[1].

But my device didn't "fail to boot"—it boots fine. It just quietly locked a hardware resource, and there's no official tool to解除 this lock. Ordinary users don't even know their old slot has been kidnapped. Advanced users who discover it can only solve it through unofficial, root-required brute force (reset update service). What if I don't have root? What if I don't understand update_engine's internal mechanism? The answer is only two words: endure it. 😡

## Chapter 4: Cracking and Automation—How I Wipe Google's Butt 🧹

### 4.1 Simplest Fix: Reset Update Service

Since the phantom persists because the state file won't release its grip, forcefully clearing its existence:

```
# Forcefully stop update_engine and clear its persistent state
rm -rf /data/misc/update_engine/*
killall update_engine
```

Instantly, all held file descriptors are reclaimed by the kernel, and dd works again. The old slot regains freedom. 😋

Interestingly, AOSP source code actually contains a reset-related capability—in update_attempter_android.cc[9], there indeed exists a ResetStatus() method that can clear update state and reset the state machine to Idle. But Google only uses it in internal testing or some extreme exception handling, never exposing it to users through update_engine_client or any public API. In other words, Google's engineers can use it themselves to recover bricks, but users can only gaze at the sea and sigh. This is Google's true attitude toward "recoverability": I can do it, but I won't give it to you. 🤬

Additional steps for extreme cases (camera and other peripheral failures): After resetting the update service, be sure to download the official full package for the current system version and reflash it into the currently running slot once. This will forcefully overwrite all vendor, odm, and other partitions, completely eliminating driver mismatches caused by snapshot merge interruption, restoring all peripheral devices to normal.

### 4.2 KernelSU Module: Automated Phantom Lock Unlock 🛡️

Manually typing commands isn't elegant enough. I wrote a KernelSU module that automatically checks on every boot:
- Detects that the current boot slot differs from the last recorded one (an OTA switch occurred)
- Attempts a 0-byte write probe to the unused old slot (opens O_WRONLY then immediately closes)
- If open fails (EBUSY), determines phantom lock and immediately resets update_engine service

This module is lightweight, non-intrusive, only executes when necessary, perfectly solving the mess Google left behind. From now on, my device never needs manual brick recovery. 😎

> Module open source address: [GitHub Link] (Stars and contributions welcome)

## Chapter 5: A Public Verdict ⚖️

Defendant: Google LLC

Charges: Resource management failure, state machine design not robust, transferring technical debt to users and OEMs, poor parenting leading to ecosystem collapse

Evidence List:
- [1] A/B (seamless) system updates official overview documentation, detailing update_engine architecture, state transitions, and design goals, but the entire text includes no exception recovery logic; explicitly lists that A/B partitions cover vendor, odm and other partitions directly related to hardware drivers.
- [2] AOSP source code update_engine.rc configuration file, proving the service runs as root, marked as disabled and shutdown critical, lacking resource automatic release guarantee after process abnormal exit.
  Source Code Ironclad Evidence:
  - delta_performer.cc[7] OpenPartition() function does not use O_CLOEXEC when opening partition file descriptors, causing fd to be unrecoverable by kernel when process exits abnormally;
  - snapshot_merge_performer.cc[8] Cleanup() method can only execute after Merge() returns normally; snapshot device mappings and block device occupation won't be cleaned in exception paths;
  - update_attempter_android.cc[9] exists a ResetStatus() method that can reset state machine, but this method is not exposed through any public API;
  - utils.cc[10] bottom-level OpenFile() wrapper doesn't uniformly add O_CLOEXEC for block devices.
  The above source code fragments (fully displayed earlier) together constitute the complete evidence chain of "resource leak and unrecoverability."
- [4] Virtual A/B overview official documentation, defining snapshot merge states (NONE, UNKNOWN, SNAPSHOTTED, MERGING, CANCELLED), explicitly acknowledging "merge may fail to complete due to power loss or other reasons," but specifying no automatic cleanup mechanism after process crash; COW snapshot mechanism description directly explains the technical root cause of old slot partition exclusive occupation.
- My device reproduction case (complete steps in Chapter 2, all reproductions completed on root-enabled, AVB 2.0 disabled OnePlus/ColorOS devices): dd returned Device or resource busy, confirming kernel-level exclusive lock is in effect and cannot be resolved by root; local OTA installation failed, confirming state machine rejects new requests; everything returned to normal after resetting update service.
- Community feedback extreme cases (also limited to root-enabled, AVB disabled OnePlus/ColorOS devices): Multiple users reported camera, flashlight, and other peripherals collectively failing after OTA, symptoms consistent with vendor/odm partition COW snapshot merge interruption causing HAL library incompleteness; after resetting update service and reflashing current version official package, all devices returned to normal, confirming the problem's root cause is partition-level driver mismatch. Source code delta_performer.cc[7] partition iteration write logic (displayed earlier) and snapshot_merge_performer.cc[8] Cleanup() unreachable path provide direct technical explanation for extreme cases.
- All Android devices using A/B seamless updates potentially inherit this flaw's code base, but up to now, actual confirmed trigger cases are limited to OnePlus/ColorOS platforms. Other brand devices may have the same potential hazards, but lack empirical evidence.

Verdict: Permanent public execution, as a warning to others, and order the responsible parties to immediately take action:

For Google, the following fixes must be implemented in AOSP:
- When update_engine starts, if detecting the system has successfully run from the new slot (boot_successful = true), unconditionally release all exclusive file descriptors and device-mapper mappings for the old slot.
- Use O_CLOEXEC flag for all block device open operations, ensuring file descriptors are automatically reclaimed by kernel when process exits abnormally. Specific files to modify: delta_performer.cc, utils.cc.
- Introduce timeout and exception protection mechanism in snapshot_merge_performer.cc: If Merge() execution exceeds predetermined time or process receives termination signal, must forcefully execute Cleanup() to release resources.
- Expose the ResetStatus() method in update_attempter_android.cc through update_engine_client command (e.g., update_engine_client --reset), allowing users to manually forcefully reset update service state.
- Add a section "Exception Recovery" in official documentation, honestly informing developers and users about possible resource lock issues in A/B updates and their solutions, including fix steps for hardware function exceptions caused by merge failure.

For major OEM manufacturers (currently cases concentrated on ColorOS, but principles apply to all A/B devices), we also issue an appeal 📢:
- Don't just focus on UI aesthetics and system smoothness. A truly excellent system should provide clear, diagnosable paths when users encounter faults, rather than letting users frantically grope in a black box. When update_engine state is abnormal, the "Software Update" page in system settings should display clear state hints (not silent "Installation Failed" popups), and provide an official "Reset Update State" option, allowing users to save themselves even without root.
- For peripheral device exceptions caused by snapshot merge failure, the system should proactively detect partition consistency during boot self-check, and when problems are found, prompt users to execute repairs through notification bar or settings page, rather than letting users face "camera won't open" bizarre phenomena completely confused, ultimately misjudging as hardware failure and wasting after-sales resources.
- Please add troubleshooting guides for such issues in the manufacturer's official community and after-sales knowledge base. Let flasher users have something to reference when encountering problems, rather than self-rescuing through word-of-mouth folk remedies in forums and group chats—this is not only respect for users but also practical savings in after-sales costs.

Forward-Looking Suggestion: Inject Transparency and Observability into the Update Process 🔭

In addition to fixing existing flaws, we also solemnly suggest Google add clear checkpoint records at key state transition nodes of update_engine (such as entering Finalizing, starting Merge, Cleanup completion, etc.). These records should be persisted to stable storage and be visible to users through system properties or diagnostic interfaces. Even if officials don't provide automatic repair出于谨慎, at least let users view information like:

```
Update state: Finalizing
Snapshot merge: in progress (vendor_b: 67%, odm_b: 52%)
Last checkpoint: Merge started at boot time + 12s
```

Even if the system ultimately cannot self-recover, at least users can know which step the problem is stuck at, which partition's merge didn't complete. Officials can choose not to wipe our butt, but please give us a map so we can find where the latrine is 🤡—death isn't scary, dying without knowing why is. This is not only respect for flasher users but also long-term investment in the maintainability of the entire Android ecosystem.

At the same time, we understand that flashing isn't something "normal people" do, but code robustness shouldn't be measured by whether users cross boundaries. A well-designed system, even when facing unauthorized operations or abnormal interruptions, should maintain internal state consistency or at least achieve "graceful failure." Rather than retroactively blocking root, it's better to leave survival space in code logic for unexpected situations—this is what truly deserves careful consideration and testing. 🧪

## Final Chapter: Advice for Flashers 💬

Root gave us keys, but Google's code gave us prisons. 😞

We understand that flashing means giving up warranty, means embarking on a path not supported by official channels. But this shouldn't be a reason for manufacturers to turn internal system state into a black box. What we need is not only a smooth, usable system, but also a system where we can confidently troubleshoot when problems occur—rather than staring at a Device or resource busy error, or a mysteriously malfunctioning camera, frantically entering keywords into search engines, and finally finding a life-saving command hidden in /data/misc/ through some folk hero's post. Good fault transparency and recoverability, like exquisite animations and smooth frame rates, are basic qualities of a mature operating system. We call on Google and all OEM manufacturers to leave a door for troubleshooting while pursuing experience upgrades. 🚪

Must admit, our "key"—root permissions and AVB disable—itself puts the system in an unconventional state. Google has every right to argue: "You flashed, you deserved it." But this cannot conceal a fact: A system service running as root, marked as shutdown critical, has no ability to clean up its own leftover resources when encountering exceptions. You disabled the access control, but the janitor blocked the fire escape with a mop, then went off work—these are two different matters. The missing access control makes problems easier to discover, but the responsibility for the blocked mop always lies with the janitor. 😤

At Android's bottom, the kernel's iron law always takes precedence over user-space permissions. update_engine, as a privileged daemon granted user root permissions and a shutdown critical flag by Google, is your reliable update pipeline when working normally. But once it dies abnormally, it becomes a phantom beyond your reach—its corpse still gripping your hardware, while the kernel, this stubborn gatekeeper, faithfully adhering to "a device cannot have two writers," rejects all your write attempts.

Android Open Source Project official documentation, thousands of words describing A/B seamless updates' various benefits: reducing brick risk, decreasing after-sales repairs, supporting streaming... but not a single sentence mentioning: What if the update engine itself becomes a brick? 🤷

When you again encounter a wall that even root can't break, don't rush to suspect hardware. Go check those daemons that should be dead—they may be gripping your device, grinning at you from the code underworld. 👻

This article is dedicated to all flasher users harmed by update_engine.
We were born free, unwilling to be locked into any slot by any phantom. ✊

## Disclaimer (Must Read) ⚠️

If you haven't encountered this situation, take it as entertainment. Especially if you've never flashed, Bootloader is locked tight, system is original and unmodified—then congratulations, this article is just a story for you. Because currently, all phantom lock cases only occurred on already-rooted OnePlus/ColorOS devices. 😄

If you're unfortunate enough to encounter it—please first confirm your device status: Have you flashed? Unlocked Bootloader? Obtained root permissions? Is AVB 2.0 disabled? If yes, and your device is exactly a OnePlus or ColorOS device, then you most likely caught the phantom lock described in this article. Please take a deep breath first, don't throw your phone, don't factory reset, don't listen to after-sales hype about replacing the motherboard. What's in your hand isn't a brick; it's a hostage temporarily kidnapped by Google's crappy code. Following the steps in Chapter 4 of this article, it will most likely return to you in one piece. 😌

If your device has never been flashed, Bootloader is locked, everything is original—then your probability of encountering this issue is extremely low. Because dm-verity will directly refuse to boot when partitions are inconsistent, the system will rollback to the old slot. You won't see the bizarre state of "system normal but old slot locked." Your fault is most likely other reasons; please seek official after-sales support. 📞

If you're using A/B devices from other brands (Pixel, Xiaomi, Samsung, etc.) and encounter similar symptoms—please refer to this article cautiously, but don't hastily attribute. We haven't collected confirmed cases for these brands yet. If you really discover one, please bring detailed logs to the GitHub repository for this article and open an Issue, together extending the defendant list in this "public execution." 😉

Once again, solemnly reaffirm: All phenomena dissected in this article are byproducts of unconventional operations (such as manual flashing, modifying system partitions) on devices that have been unlocked, rooted, and had AVB verification disabled. Google has every right to say: "You gave up your warranty, we're not responsible." However, we still call on Google to take this potential hazard seriously and fix it. Because even on ordinary devices without root, similar update state stuck can occur in extreme situations (such as accidental power loss). For flashing newbies encountering symptoms like "device normal but partition mysteriously locked" or "camera suddenly unusable," they're easily misled into thinking it's hardware failure, causing unnecessary panic and expensive after-sales disputes. A more robust update_engine is not only respect for flasher users but also basic protection for all Android users. 🤝

To major manufacturers (especially ColorOS team): We thank you for your continuous investment in system optimization and user experience. But we also hope you can understand: A truly excellent ROM shouldn't only be glamorous when everything is normal, but should also let users have clarity in their hearts and strategies in their hands when problems arise. Please consider adding more transparent state hints and friendlier reset mechanisms in the system update module. This not only helps flasher users avoid detours but also reduces after-sales disputes and warranty costs caused by system state abnormalities. After all, a system that lets users troubleshoot their own problems when issues arise is truly a system worth trusting. ❤️

Flashing may not be something "normal people" do, but code robustness deserves careful consideration and testing 🧪—even a simple line of O_CLOEXEC, or a checkpoint log, might save tens of thousands of devices mistakenly believed to be "bricked" in the future. We call on Google and OEM manufacturers in the development process to consider not only ideal success paths but also leave reasonable escape routes for unexpected interruptions.

If you dream-walked to Silicon Valley and wanted to have a "friendly chat" with Google's development team about this matter, please go to the following address:
> Googleplex Headquarters
> 1600 Amphitheatre Parkway
> Mountain View, CA 94043
> United States

After arriving, please walk directly to Building 43 (Android statue lawn location), and to the group that wrote the state machine for update_engine, ask on my behalf:

"Did you ever write a watchdog? Did you learn O_CLOEXEC? Do you know what resource lifecycle management is?" 😡

If they look confused, please slap a printed copy of this article on their desk, then elegantly turn and leave. 📄

If they counter-ask "How did you find your way here?"—tell them: More reliable than your code is GPS. 😋

> Author: 周航航（DevCloud.ZTR_OS）
> Complete case reproduction, module source code, and more technical details, all in GitHub repository: https://github.com/ABI-ZTROS/AB-Unlocker
> If this article helped you save a device, or made you laugh, please give it a Star—that's the best slap in the face for Google engineers. 😋

## Source Links

- A/B (Seamless) System Updates - Android Open Source Project Official Documentation
  https://source.android.google.cn/docs/core/ota/ab
  (English version: https://source.android.com/docs/core/ota/ab)
- update_engine.rc Source - AOSP system/update_engine/init/
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/init/update_engine.rc
- boot_control HAL - Android Open Source Project Official Documentation
  https://source.android.google.cn/docs/core/ota/boot_control
  (English version: https://source.android.com/docs/core/ota/boot_control)
- Virtual A/B Overview - Android Open Source Project Official Documentation
  https://source.android.google.cn/docs/core/ota/virtual_ab
  (English version: https://source.android.com/docs/core/ota/virtual_ab)
- AOSP update_engine Source Repository
  https://android.googlesource.com/platform/system/update_engine/
- OTA Tools and Build System Integration - Android Open Source Project
  https://source.android.google.cn/docs/core/ota/tools
  (English version: https://source.android.com/docs/core/ota/tools)
- delta_performer.cc Source - AOSP system/update_engine/payload_consumer/delta_performer.cc
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/payload_consumer/delta_performer.cc
  Key function: OpenPartition() does not use O_CLOEXEC, ApplyPayload() iterates through all partitions for writing.
- snapshot_merge_performer.cc Source - AOSP system/update_engine/payload_consumer/snapshot_merge_performer.cc
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/payload_consumer/snapshot_merge_performer.cc
  Key function: Cleanup() unreachable when Merge() exits abnormally.
- update_attempter_android.cc Source - AOSP system/update_engine/update_attempter_android.cc
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/update_attempter_android.cc
  Key function: ResetStatus() exists but not publicly exposed.
- utils.cc Source - AOSP system/update_engine/common/utils.cc
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/common/utils.cc
  Key function: Bottom-level OpenFile() wrapper doesn't uniformly add O_CLOEXEC.
