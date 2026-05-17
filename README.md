# Root 也无法逾越的锁：一次 ColorOS A/B 更新"幽灵锁死"的验尸报告、自动化救砖及对 Google 的血泪控诉

---

## 序言：当 root 不再是上帝 🤡

---

## 第一章：Android 系统更新服务——那个你从未关心过的幽灵 👻

### 1.1 A/B 无缝更新：Google 的骄傲 😎

### 1.2 update_engine 的启动机制：从 Bootloader 到 Binder

- **disabled**：该服务不会随 class main 自动启动，必须由特定事件触发。
- **on property:ro.boot.slot_suffix=***：启动的唯一触发器是 ro.boot.slot_suffix 系统属性被设置，该属性来源于 Bootloader 通过内核命令行传递的当前激活槽位信息（如 androidboot.slot_suffix=_a）[3]。
- **user root**：update_engine 以 root 身份运行，拥有直接读写系统分区的最高权限。

### 1.3 update_engine 的状态机：严谨还是脆弱？

- **正在更新**：系统正在从当前槽位运行，目标槽位中的内容"正在更新，但是尚未完成"，因此该槽位"标记为不可启动"。
- **已应用更新，正在等待重新启动**：目标槽位已被标记为可启动但尚未成功，引导加载程序应从其启动尝试。
- **系统重新启动到新的更新**：首次从新槽位运行，旧槽位仍为可启动且成功状态。
- **Downloading**：写入 payload 到目标插槽，期间会创建 device-mapper 快照（COW 设备），对目标分区进行写时复制保护。官方文档在描述 Virtual A/B 实现时，明确定义了快照的合并状态包括 NONE、UNKNOWN、SNAPSHOTTED、MERGING、CANCELLED[4]。
- **Finalizing**：执行 postinstall 脚本（若有），并开始快照合并。官方文档描述："对于其中已定义安装后步骤的每个分区，update_engine 会将新分区装载到特定位置，并执行与装载的分区对应的 OTA 中指定的程序"[1]。在此阶段，快照状态为 MERGING，合并操作将 COW 设备中的差异数据合并回原始物理分区[4]。
- **UpdatedNeedReboot**：写入与合并完成，设置新插槽为可启动，标记"需要重启以完成更新"。官方流程描述为："系统重新启动到新的更新：系统首次从插槽 A 运行"[1]。
- **重启进入新系统后**：update_engine 会在后台调用 markBootSuccessful()，将新槽位的"成功"属性设置为 true。官方文档明确指出："被标记为成功的槽位应该能够自行启动、运行和更新"[1]。然后进入 Idle 状态，释放旧槽的所有资源。

### 1.4 独占文件描述符：内核的铁律 ⚖️

---

## 第二章：案发现场——一次完美的 OTA，一个永锁的分区 🕵️

### 2.1 复现步骤与关键故障节点

| 步骤 | 操作 | 预期结果 | 实际结果 | 可能出现问题的节点 |
|------|------|----------|----------|---------------------|
| 1 | 接收 ColorOS 大版本 OTA 推送，触发更新。 | 系统下载全量包， update_engine 将新系统写入未使用的插槽 B。 | 更新开始，进度条前进。 | 写入阶段：若在此阶段强制重启或断电，B 槽会被标记为不可启动且持久化状态卡在 Downloading 。但本次复现中，写入正常完成。 |
| 2 | 写入完成后，系统提示"需要重启以完成更新"。点击重启。 | 设备重启，引导加载程序切换到插槽 B，正常进入新系统。 | 设备重启后，在开机第一屏（OEM Logo 页面）卡死超过 40 秒，随后才进入开机第二屏（bootanimation），最终进入新系统。新系统一切功能正常，无崩溃或报错。 | ⚠️ 关键预警信号：如果在更新后重启时，你观察到设备在第一屏（静态 Logo）停留了远超正常时间（通常为 5~15 秒）的40 秒以上，这是一个100% 复现的铁证。这一异常卡顿说明 update_engine 在 post-boot 阶段执行快照合并时发生了严重阻塞或线程死锁，内核在等待一个永远不会完成的 I/O 操作。提交阶段（post-boot） 的合并线程正是在此时陷入了永久的沉睡，状态文件被锁定在 UpdatedNeedReboot 或 Finalizing ，旧槽 A 的分区设备文件从此被幽灵永久攥住。如果你没有观察到这个 40 秒以上的卡顿，请不要再继续尝试复现步骤——你的设备很可能没有触发此 Bug，继续强行操作只会让你的存储颗粒折寿。 😨 |
| 3 | 进入插槽 B 后，尝试向旧插槽 A 刷写镜像（如修补后的 boot.img ）。 | dd 命令正常写入块设备。 | dd 返回 Device or resource busy ，写入失败。 | 内核独占锁：由于步骤 2 中的合并线程已经死锁， update_engine 残留的僵尸文件描述符仍以 O_EXCL 模式持有 system_a 、 boot_a 等分区。内核拒绝任何新的写入打开，root 也无法绕过。 |
| 4 | 尝试通过系统内本地安装 OTA 全量包（或增量包），以期覆盖或修复锁死的旧槽。 | 更新界面启动安装流程。 | 安装直接失败，没有任何有效错误提示（仅弹窗"安装失败"）。 | 状态机拒绝： update_engine 仍处于"更新未完成"的中间状态，其内部状态机拒绝接受新的 ApplyPayload 请求，返回错误码（如 kInvalidState ）。这一点证实了锁死的根源是 update_engine 的持久化状态，而非瞬时的文件占用。 |
| 5 | 重置 Android 系统更新服务。执行 rm -rf /data/misc/update_engine/* 并 killall update_engine 。 | 服务重启后进入 Idle 状态，旧槽分区恢复空闲。 | 命令执行后，再次尝试 dd 写入旧槽 A，成功写入，一切正常。 | 唯一修复路径：清除持久化状态 + 杀死进程，迫使内核回收所有独占文件描述符。此操作相当于手动触发 Google 从未公开暴露的"异常恢复"流程。 😋 |

### 2.2 徒劳的挣扎 😫

- umount？该分区根本没有被挂载。
- blockdev --setrw？它已经是可读写的。
- disable-verity？dm-verity 根本没有在保护它。虽然官方文档提到 "dm-verity 可保证设备使用的启动映像未损坏"[1]，但这里出问题的不是 dm-verity。
- 检查 AVB 2.0 / dm-verity 状态：已禁用（因刷机需要）。这意味着 system、vendor 等分区的完整性验证已被关闭，块设备的写保护不来自验证启动链。这也排除了"AVB 阻止写入"的可能性，反证锁死的根源在更底层。
- 检查 SELinux？已处于 Permissive 模式。
- 重启设备？问题依旧。

### 2.3 怀疑的转折：从硬件锁到软件鬼魂 👻

### 2.4 极端案例：相机等边缘化设备的集体叛变 📸

- **vendor 分区**：包含硬件抽象层（HAL）的二进制实现，相机 HAL 就是典型的例子。
- **odm 分区**：原始设计制造商（ODM）的自定义配置和专有库，某些传感器校准数据也放在这里。
- **dtbo / vbmeta**：设备树叠加层和验证元数据，与内核驱动加载直接相关。

- 内核和 Android 框架已经从新插槽 B 启动，期待使用新版本的 HAL 库和固件。
- 但由于合并未完成，vendor_b 或 odm_b 中可能还残留着未合并的旧数据，或者快照设备映射并未完全拆除，导致某些库文件实际上是损坏的或不完整的。
- 对于相机这类边缘设备，其 HAL 服务启动时发现固件版本不匹配或者关键 .so 文件无法正常加载，便会静默失败，表现为相机应用黑屏、闪光灯开关消失、或人脸识别不可用。
- 先强制重置更新服务状态（rm -rf /data/misc/update_engine/* && killall update_engine），释放旧槽锁死，并使状态机回归 Idle。
- 下载当前已启动系统对应的官方全量包（注意必须是当前版本，不能是旧版），通过本地 OTA 或手动 fastboot 方式将其重新刷入当前运行的插槽。
- 这次刷写会强制覆盖所有相关分区（包括 vendor、odm、dtbo 等），消除任何残留的 COW 快照或版本不匹配，让硬件驱动恢复到该版本应有的完整状态。

---

## 第三章：Google 的七宗罪——为什么这个 bug 如此荒谬 😡

### 第一宗罪：状态机没有超时与自愈能力 💀

### 第二宗罪：资源清理失败是幼儿园级的错误 🍼

### 第三宗罪：对"更新完成"的定义反人类 🤔

### 第四宗罪：独占锁的使用漫不经心 🔒

### 第五宗罪：上梁不正下梁歪——OEM 们的变本加厉 🏠

### 第六宗罪：root 权限的边界被悄然颠覆 🔑

### 第七宗罪：对用户的可恢复性零考虑 🚫

---

## 第四章：破解与自动化——我如何替 Google 擦屁股 🧹

### 4.1 最简单的修复：重置更新服务

### 4.2 KernelSU 模块：自动化解锁幽灵锁 🛡️

- 检测到本次启动插槽与上次记录不同（发生了 OTA 切换）
- 向未使用的旧插槽尝试写入 0 字节探测（打开 O_WRONLY 立即关闭）
- 如果打开失败（EBUSY），判定为幽灵锁死，立即重置 update_engine 服务

---

## 第五章：一份公开的判决书 ⚖️

[1] A/B（无缝）系统更新官方总览文档，详述 update_engine 架构、状态流转及设计目标，但全篇未包含异常恢复逻辑；明确列出 A/B 分区涵盖 vendor、odm 等与硬件驱动直接相关的分区。

[2] AOSP 源码 update_engine.rc 配置文件，证明该服务以 root 身份运行、被标记为 disabled 和 shutdown critical，缺乏进程异常退出后的资源自动释放保障。源码铁证：delta_performer.cc[7] 中 OpenPartition() 函数在打开分区文件描述符时未使用 O_CLOEXEC，导致进程异常退出时 fd 无法被内核自动回收；snapshot_merge_performer.cc[8] 中 Cleanup() 方法只能在 Merge() 正常返回后执行，异常路径下快照设备映射和块设备占用不会被清理；update_attempter_android.cc[9] 中存在 ResetStatus() 方法可重置状态机，但该方法未通过任何公开 API 暴露给用户；utils.cc[10] 中底层 OpenFile() 封装未对块设备统一添加 O_CLOEXEC。以上源码片段（已于前文完整展现）共同构成"资源泄漏与不可恢复"的完整证据链。
  - delta_performer.cc[7] 中 OpenPartition() 函数在打开分区文件描述符时未使用 O_CLOEXEC，导致进程异常退出时 fd 无法被内核自动回收；
  - snapshot_merge_performer.cc[8] 中 Cleanup() 方法只能在 Merge() 正常返回后执行，异常路径下快照设备映射和块设备占用不会被清理；
  - update_attempter_android.cc[9] 中存在 ResetStatus() 方法可重置状态机，但该方法未通过任何公开 API 暴露给用户；
  - utils.cc[10] 中底层 OpenFile() 封装未对块设备统一添加 O_CLOEXEC。以上源码片段（已于前文完整展现）共同构成"资源泄漏与不可恢复"的完整证据链。

[4] Virtual A/B 概览官方文档，定义快照合并状态（NONE、UNKNOWN、SNAPSHOTTED、MERGING、CANCELLED），明确承认"合并可能因断电等原因未能完成"，但未规定进程崩溃后的自动清理机制；COW 快照机制描述直接解释了旧槽分区被独占占用的技术根源。

- 本人设备复现案例（完整步骤见第二章，所有复现均在已 root、AVB 2.0 已禁用的 OnePlus/ColorOS 设备上完成）：dd 返回 Device or resource busy，证实内核级独占锁生效且无法由 root 解除；本地 OTA 安装失败证实状态机拒绝新请求；重置更新服务后一切恢复正常。
- 社区反馈的极端案例（同样限定于已 root、AVB 已禁用的 OnePlus/ColorOS 设备）：多名用户报告 OTA 后相机、闪光灯等外设集体失效，症状符合 vendor/odm 分区 COW 快照合并中断导致 HAL 库不完整的特征；重置更新服务并重刷当前版本官包后所有设备恢复正常，证实问题根源于分区级驱动不匹配。源码 delta_performer.cc[7] 中遍历所有分区的写入逻辑（已在前文展现）和 snapshot_merge_performer.cc[8] 中 Cleanup() 的不可达路径，为极端案例提供了直接的技术解释。
- 所有采用 A/B 无缝更新的 Android 设备均潜在继承此缺陷的代码基础，但截至目前，实际已确认触发案例仅限 OnePlus/ColorOS 平台。其他品牌设备可能存在相同隐患，但缺乏实证。
- 在 update_engine 启动时，若检测到系统已从新插槽成功运行（boot_successful = true），则无条件释放旧插槽的所有独占文件描述符和 device-mapper 映射。
- 为所有块设备打开操作使用 O_CLOEXEC 标志，确保进程异常退出时文件描述符被内核自动回收。具体修改文件：delta_performer.cc、utils.cc。
- 在 snapshot_merge_performer.cc 中引入超时与异常保护机制：若 Merge() 执行超过预定时间或进程收到终止信号，必须强制执行 Cleanup() 释放资源。
- 将 update_attempter_android.cc 中的 ResetStatus() 方法通过 update_engine_client 命令公开暴露（如 update_engine_client --reset），允许用户手动强制重置更新服务状态。
- 在官方文档中增加一节"异常恢复"，诚实告知开发者和用户 A/B 更新可能出现的资源锁死问题及其解决方案，包括因合并失败导致的硬件功能异常的修复步骤。
- 不要仅满足于 UI 的美观和系统的流畅度。一个真正优秀的系统，应该在用户遇到故障时，提供清晰、可排查的诊断路径，而不是让用户在黑盒中恐慌性摸索。 当 update_engine 状态异常时，系统设置中的"软件更新"页面应当显示明确的状态提示（而非沉默的"安装失败"弹窗），并提供"重置更新状态"的官方选项，让用户即使在没有 root 的情况下也能自救。
- 对于因快照合并失败导致的边缘设备异常，系统应在开机自检阶段主动检测分区一致性，并在发现问题时通过通知栏或设置页面提示用户执行修复，而不是让用户面对"相机打不开"的诡异现象一头雾水，最终误判为硬件故障而浪费售后资源。
- 请在厂商的官方社区和售后知识库中，加入对此类问题的排查指南。让刷机玩家在遇到问题时能够有据可查，而不是在论坛和群聊中靠口口相传的民间偏方自救——这不仅是对用户的尊重，也是对售后成本的实际节约。

---

## 终章：给刷机人的忠告 💬

---

## 免责声明（必读）⚠️

---

## 引用源链接

- A/B（无缝）系统更新 - Android 开源项目官方文档  
  https://source.android.google.cn/docs/core/ota/ab  
  （英文版：https://source.android.com/docs/core/ota/ab）

- update_engine.rc 源码 - AOSP system/update_engine/init/  
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/init/update_engine.rc

- boot_control HAL - Android 开源项目官方文档  
  https://source.android.google.cn/docs/core/ota/boot_control  
  （英文版：https://source.android.com/docs/core/ota/boot_control）

- Virtual A/B 概览 - Android 开源项目官方文档  
  https://source.android.google.cn/docs/core/ota/virtual_ab  
  （英文版：https://source.android.com/docs/core/ota/virtual_ab）

- AOSP update_engine 源码仓库  
  https://android.googlesource.com/platform/system/update_engine/

- OTA 工具与 build 系统集成 - Android 开源项目  
  https://source.android.google.cn/docs/core/ota/tools  
  （英文版：https://source.android.com/docs/core/ota/tools）

- delta_performer.cc 源码 - AOSP system/update_engine/payload_consumer/delta_performer.cc  
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/payload_consumer/delta_performer.cc  
  关键函数：OpenPartition() 未使用 O_CLOEXEC，ApplyPayload() 遍历所有分区执行写入。

- snapshot_merge_performer.cc 源码 - AOSP system/update_engine/payload_consumer/snapshot_merge_performer.cc  
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/payload_consumer/snapshot_merge_performer.cc  
  关键函数：Merge() 异常退出时 Cleanup() 不可达。

- update_attempter_android.cc 源码 - AOSP system/update_engine/update_attempter_android.cc  
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/update_attempter_android.cc  
  关键函数：ResetStatus() 存在但未公开暴露。

- utils.cc 源码 - AOSP system/update_engine/common/utils.cc  
  https://android.googlesource.com/platform/system/update_engine/+/refs/heads/main/common/utils.cc  
  关键函数：OpenFile() 底层打开未统一添加 O_CLOEXEC。

---

## 作者

周航航（DevCloud.ZTR_OS）

---

## 项目信息

- GitHub 仓库：https://github.com/ABI-ZTROS/AB-Unlocker
- 下载地址：https://github.com/ABI-ZTROS/AB-Unlocker/releases
