# A/B 分区幽灵锁解锁器 - v1.1.0 发布说明

## 📦 下载

- [AB-Unlocker-v1.1.0.zip](AB-Unlocker-v1.1.0.zip) (推荐)
- [AB-Unlocker-v1.0.0.zip](AB-Unlocker-v1.0.0.zip) (旧版本)

---

## ✨ 新功能 (What's New)

### 1. 🎵 音量键确认安装
- 安装时支持通过音量键确认安装
- 音量+键：确认安装
- 音量-键：取消安装
- 30秒超时自动取消（安全措施）

### 2. 📜 用户协议与免责声明
- 完整的用户协议显示
- 明确标注本模块为**实验性质软件**
- 提醒用户遇到问题请先**深呼吸** 😊
- 提供寻求帮助或心理安慰的指引

### 3. ⏱️ 强制阅读倒计时
- 安装前强制阅读用户协议 40 秒
- 用户不可见倒计时（静默等待）
- 确保用户在继续前仔细阅读协议

### 4. 🔍 优化机型识别
- 更智能的设备兼容性检测
- 支持多个品牌识别：
  - OnePlus/oplus (一加)
  - OPPO
  - Realme (真我)
- 支持多个属性来源检测
- 自动识别具体机型系列（如 ACE 系列）
- 兼容性检查更严格和可靠

### 5. 🤖 WebUI 自动化/手动模式选择
- 新增操作模式选择界面
- 自动化模式（推荐新手）：
  - 自动检测和修复
  - 简化操作流程
- 手动模式（适合高级用户）：
  - 手动控制每一步操作
  - 更精细的控制权限

### 6. 🎨 全新水蓝色主题
- WebUI 采用清爽的水蓝色主题
- 现代化的 UI 设计
- 响应式布局适配各种屏幕尺寸
- 更流畅的动画和交互效果

---

## 🛠️ 改进与修复 (Improvements & Fixes)

### 改进内容：
- 重新设计 WebUI 界面，提升用户体验
- 优化 [customize.sh](AB-Unlocker/customize.sh) 安装脚本
- 优化 [module.prop](AB-Unlocker/module.prop) 描述信息
- 更新 [app.js](AB-Unlocker/webroot/app.js) 添加模式选择逻辑
- 重写 [style.css](AB-Unlocker/webroot/style.css) 采用新主题
- 更新 [index.html](AB-Unlocker/webroot/index.html) 新增功能卡片
- 完整的中英文文档（[README.md](README.md) / [README_EN.md](README_EN.md)）
- 深度技术分析论文（[PAPER.md](PAPER.md) / [PAPER_EN.md](PAPER_EN.md)）

---

## 📋 更新内容一览

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| [customize.sh](AB-Unlocker/customize.sh) | 🔄 重写 | 添加用户协议、强制阅读、音量键确认、优化机型识别 |
| [module.prop](AB-Unlocker/module.prop) | ✏️ 更新 | 版本升至 v1.1.0，更新描述 |
| [webroot/app.js](AB-Unlocker/webroot/app.js) | 🔄 重写 | 添加自动化/手动模式选择逻辑 |
| [webroot/style.css](AB-Unlocker/webroot/style.css) | 🔄 重写 | 全新水蓝色主题设计 |
| [webroot/index.html](AB-Unlocker/webroot/index.html) | ✏️ 更新 | 添加模式选择卡片 |
| [README.md](README.md) | ✏️ 更新 | 完整中文文档 |
| [README_EN.md](README_EN.md) | 🆕 添加 | 完整英文文档 |
| [PAPER.md](PAPER.md) | 🆕 添加 | 深度技术分析论文（中文） |
| [PAPER_EN.md](PAPER_EN.md) | 🆕 添加 | 深度技术分析论文（英文） |

---

## 🎯 适用设备

### 支持机型：
- ✅ OnePlus (一加) 系列设备
- ✅ OPPO ColorOS 设备
- ✅ Realme (真我) UI 设备

### 要求：
- 📱 已获取 Root 权限
- 🔓 已解锁 Bootloader
- 🚫 AVB 2.0 / dm-verity 已禁用（推荐）
- 📊 Android 11+（推荐）

---

## 🔧 使用说明

### 安装步骤：
1. 在 Magisk/KernelSU 中刷入模块
2. 阅读用户协议（强制 40 秒）
3. 通过音量键确认安装
4. 等待安装完成
5. 重启设备

### WebUI 使用：
1. 访问模块 WebUI
2. 确认使用条件（如已完成 OTA、保留 Root 等）
3. 选择操作模式（自动化/手动）
4. 按照界面提示进行操作

---

## ⚠️ 重要声明

> **本模块属于【实验性质】软件**
> - 使用前请仔细阅读完整用户协议
> - 遇到问题请先**深呼吸** 🤹
> - 查看日志：`/data/local/tmp/ab_unlocker.log`
> - 联系开发者寻求帮助
> - 或者寻求心理安慰 😊

> **免责声明**
> - 作者不对使用本模块造成的任何损失负责
> - 使用前请备份重要数据
> - 刷机有风险，操作需谨慎

---

## 📝 版本信息

| 属性 | 值 |
|------|-----|
| 版本号 | v1.1.0 |
| 版本代码 | 11 |
| 作者 | 周航航 (DevCloud.ZTR_OS) |
| 发布日期 | 2026-05-20 |

---

## 📚 相关文档

- [中文 README](README.md) - 完整中文使用说明
- [English README](README_EN.md) - Complete English documentation
- [技术分析论文 (中文)](PAPER.md) - 深入的源代码分析
- [Technical Paper (English)](PAPER_EN.md) - In-depth source code analysis

---

## 🐛 问题反馈

如有问题，请：
1. 查看日志文件：`/data/local/tmp/ab_unlocker.log`
2. 深呼吸保持冷静 🤹
3. 联系开发者或社区寻求帮助

---

## 🙏 致谢

感谢社区的反馈和贡献！
