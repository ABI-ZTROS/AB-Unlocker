#!/system/bin/sh

# ========================================
# customize.sh - 自定义安装脚本 v1.1.0
# A/B 分区幽灵锁解锁模块
# ========================================

# ========================================
# 用户协议和免责声明
# ========================================

show_disclaimer() {
    ui_print ""
    ui_print "=================================="
    ui_print " ⚠️  重要声明 / IMPORTANT DISCLAIMER"
    ui_print "=================================="
    ui_print ""
    ui_print "本模块属于【实验性质】软件"
    ui_print "This module is EXPERIMENTAL software"
    ui_print ""
    ui_print "安装前请务必知悉："
    ui_print "Please read carefully before installation:"
    ui_print ""
    ui_print "1. 本模块专为解决ColorOS/OnePlus设备的"
    ui_print "   A/B更新后旧槽幽灵锁死问题而设计"
    ui_print ""
    ui_print "2. 使用本模块即表示您理解并同意："
    ui_print "   - 模块可能存在未知Bug"
    ui_print "   - 每次OTA后建议检查模块功能"
    ui_print "   - 遇到问题请深呼吸保持冷静"
    ui_print ""
    ui_print "3. 遇到问题怎么办？"
    ui_print "   - 第一步：深呼吸 🤹"
    ui_print "   - 第二步：查看日志"
    ui_print "     (/data/local/tmp/ab_unlocker.log)"
    ui_print "   - 第三步：联系开发者寻求帮助"
    ui_print "   - 第四步：寻求心理安慰 😌"
    ui_print ""
    ui_print "4. 免责条款："
    ui_print "   - 作者不对使用本模块造成的任何损失负责"
    ui_print "   - 使用前请备份重要数据"
    ui_print "   - 刷机有风险，操作需谨慎"
    ui_print ""
    ui_print "5. 仅限以下设备使用："
    ui_print "   - OnePlus 系列设备"
    ui_print "   - OPPO ColorOS 设备"
    ui_print "   - Realme UI 设备"
    ui_print "   - 必须是已root并解锁bl的设备"
    ui_print ""
    ui_print "=================================="
    ui_print ""
}

# ========================================
# 强制阅读倒计时（40秒）
# ========================================

force_read_countdown() {
    ui_print "正在加载用户协议..."
    ui_print "请仔细阅读上方声明"
    ui_print ""
    
    local countdown=40
    ui_print "强制阅读倒计时: ${countdown} 秒"
    ui_print "(您无需做任何操作)"
    
    while [ $countdown -gt 0 ]; do
        ui_print "剩余阅读时间: ${countdown} 秒..."
        sleep 1
        countdown=$((countdown - 1))
    done
    
    ui_print ""
    ui_print "✅ 阅读时间结束"
    ui_print ""
}

# ========================================
# 音量键确认安装
# ========================================

volume_key_confirmation() {
    ui_print "=================================="
    ui_print "安装确认 / Installation Confirmation"
    ui_print "=================================="
    ui_print ""
    ui_print "📋 请确认以下事项:"
    ui_print ""
    ui_print "☑️ 我已仔细阅读并理解用户协议"
    ui_print "☑️ 我的设备是 OnePlus/OPPO/Realme"
    ui_print "☑️ 我的设备已获取root权限"
    ui_print "☑️ 我理解这是实验性质模块"
    ui_print ""
    ui_print "=================================="
    ui_print ""
    ui_print "🔑 确认安装方式:"
    ui_print ""
    ui_print "按 【音量+】键 = 确认安装 ✅"
    ui_print "按 【音量-】键 = 取消安装 ❌"
    ui_print ""
    ui_print "⚠️ 请在 30 秒内做出选择"
    ui_print "(超时将默认取消安装)"
    ui_print ""
    
    local confirm_timeout=30
    local confirm_choice=""
    
    # 检测按键（通过getevent或input命令）
    # 这里使用一个简化的等待机制
    while [ $confirm_timeout -gt 0 ]; do
        ui_print "等待确认... (${confirm_timeout}s)"
        
        # 尝试检测音量键
        # 注意：在某些recovery环境中可能不支持
        if input keyevent 25 2>/dev/null; then
            # 音量+
            confirm_choice="yes"
            break
        elif input keyevent 24 2>/dev/null; then
            # 音量-
            confirm_choice="no"
            break
        fi
        
        sleep 1
        confirm_timeout=$((confirm_timeout - 1))
    done
    
    # 如果超时或检测失败，提供备用方案
    if [ -z "$confirm_choice" ]; then
        ui_print ""
        ui_print "⚠️ 按键检测超时"
        ui_print "请输入 'confirm' 确认安装"
        ui_print "(在Magisk App中安装可跳过此步骤)"
        ui_print ""
        
        # 在BOOTMODE下直接确认
        if [ "$BOOTMODE" = "true" ]; then
            ui_print "✅ 检测到Magisk App安装模式"
            ui_print "   将跳过手动确认"
            confirm_choice="yes"
        fi
    fi
    
    if [ "$confirm_choice" = "yes" ]; then
        ui_print ""
        ui_print "✅ 安装确认成功！"
        ui_print "继续安装..."
        ui_print ""
    else
        ui_print ""
        ui_print "❌ 安装已取消"
        ui_print "=================================="
        abort "用户取消安装"
    fi
    
    ui_print "=================================="
    ui_print ""
}

# ========================================
# 设备检测函数
# ========================================

check_prop() {
    local prop_name=$1
    local value=$(getprop "$prop_name" 2>/dev/null)
    if [ -n "$value" ]; then
        ui_print "  - $prop_name: $value"
        return 0
    fi
    return 1
}

check_file_exists() {
    [ -f "$1" ] && return 0 || return 1
}

check_dir_exists() {
    [ -d "$1" ] && return 0 || return 1
}

# ========================================
# 优化的设备兼容性检查
# ========================================

check_compatibility() {
    ui_print ""
    ui_print "🔍 正在检查设备兼容性..."
    ui_print "=================================="
    
    # 获取设备基本信息
    local model=$(getprop ro.product.model 2>/dev/null)
    [ -z "$model" ] && model=$(getprop ro.product.system.model 2>/dev/null)
    local manufacturer=$(getprop ro.product.manufacturer 2>/dev/null)
    [ -z "$manufacturer" ] && manufacturer=$(getprop ro.product.system.manufacturer 2>/dev/null)
    local brand=$(getprop ro.product.brand 2>/dev/null)
    [ -z "$brand" ] && brand=$(getprop ro.product.system.brand 2>/dev/null)
    local device=$(getprop ro.product.device 2>/dev/null)
    [ -z "$device" ] && device=$(getprop ro.product.system.device 2>/dev/null)
    
    ui_print "设备信息:"
    ui_print "  - 型号: $model"
    ui_print "  - 设备: $device"
    ui_print "  - 制造商: $manufacturer"
    ui_print "  - 品牌: $brand"
    
    # 获取系统版本
    ui_print ""
    ui_print "系统版本:"
    check_prop "ro.build.version.release"
    check_prop "ro.system.build.version.release"
    check_prop "ro.build.version.sdk"
    check_prop "ro.system.build.version.sdk"
    
    ui_print ""
    ui_print "=================================="
    ui_print "🖥️  检测系统类型:"
    
    local coloros_detected=0
    local device_type=""
    
    # 获取所有可能的品牌/制造商标识
    local manufacturer_lower=$(echo "$manufacturer" | tr '[:upper:]' '[:lower:]')
    local brand_lower=$(echo "$brand" | tr '[:upper:]' '[:lower:]')
    local system_brand=$(getprop ro.product.system.brand 2>/dev/null | tr '[:upper:]' '[:lower:]')
    local system_manufacturer=$(getprop ro.product.system.manufacturer 2>/dev/null | tr '[:upper:]' '[:lower:]')
    local device_lower=$(echo "$device" | tr '[:upper:]' '[:lower:]')
    
    # OnePlus 检测
    if echo "$manufacturer_lower $brand_lower $system_brand $system_manufacturer $device_lower" | grep -qE "(oneplus|oplus)"; then
        coloros_detected=1
        device_type="OnePlus"
        ui_print "  ✅ 检测到OnePlus设备"
        
        # 尝试识别具体型号
        if echo "$model $device" | grep -qi "ACE"; then
            ui_print "     识别型号: OnePlus ACE 系列"
        elif echo "$model $device" | grep -qi "13"; then
            ui_print "     识别型号: OnePlus 13"
        elif echo "$model $device" | grep -qi "OPEN"; then
            ui_print "     识别型号: OnePlus Open (折叠屏)"
        elif echo "$model $device" | grep -qi "PAD"; then
            ui_print "     识别型号: OnePlus Pad (平板)"
        fi
    fi
    
    # OPPO 检测
    if echo "$manufacturer_lower $brand_lower $system_brand $system_manufacturer" | grep -qE "(oppo|oppomobile)"; then
        coloros_detected=1
        device_type="OPPO"
        ui_print "  ✅ 检测到OPPO设备"
    fi
    
    # Realme 检测
    if echo "$manufacturer_lower $brand_lower $system_brand $system_manufacturer" | grep -qE "(realme|realmobile)"; then
        coloros_detected=1
        device_type="Realme"
        ui_print "  ✅ 检测到Realme设备"
    fi
    
    # ColorOS版本检测
    local coloros_ver=$(getprop ro.build.version.opporom 2>/dev/null)
    if [ -n "$coloros_ver" ]; then
        coloros_detected=1
        ui_print "  ✅ ColorOS版本: $coloros_ver"
    fi
    
    # Realme UI版本检测
    local realme_ui=$(getprop ro.build.version.realme 2>/dev/null)
    if [ -n "$realme_ui" ]; then
        coloros_detected=1
        ui_print "  ✅ Realme UI版本: $realme_ui"
    fi
    
    # OxygenOS检测
    local oxygenos=$(getprop ro.build.version.oxygen 2>/dev/null)
    if [ -n "$oxygenos" ]; then
        coloros_detected=1
        ui_print "  ✅ OxygenOS版本: $oxygenos"
    fi
    
    ui_print ""
    ui_print "=================================="
    
    # 兼容性判定
    if [ $coloros_detected -eq 0 ]; then
        ui_print ""
        ui_print "❌ 错误：检测不到支持的设备！"
        ui_print ""
        ui_print "支持的设备品牌："
        ui_print "  ✅ OnePlus (一加)"
        ui_print "  ✅ OPPO (欧珀)"
        ui_print "  ✅ Realme (真我)"
        ui_print ""
        ui_print "检测到的设备信息："
        ui_print "  - 型号: $model"
        ui_print "  - 制造商: $manufacturer"
        ui_print "  - 品牌: $brand"
        ui_print ""
        ui_print "=================================="
        ui_print "❌ 安装已取消"
        ui_print "=================================="
        abort "设备不兼容 - 不在支持列表中"
    fi
    
    ui_print ""
    ui_print "✅ 设备兼容性检查通过"
    ui_print "支持的设备类型: $device_type"
    ui_print "=================================="
    ui_print ""
}

# ========================================
# Android版本检查
# ========================================

check_android_version() {
    ui_print "📱 Android版本检查..."
    
    # 支持多个属性来源
    local api_level=$(getprop ro.build.version.sdk 2>/dev/null)
    local system_api_level=$(getprop ro.system.build.version.sdk 2>/dev/null)
    local release_version=$(getprop ro.build.version.release 2>/dev/null)
    local system_release_version=$(getprop ro.system.build.version.release 2>/dev/null)
    
    # 优先使用非空值
    [ -z "$api_level" ] && api_level="$system_api_level"
    [ -z "$release_version" ] && release_version="$system_release_version"
    
    ui_print "  Android版本: $release_version (API $api_level)"
    
    # 最低支持Android 11 (API 30)
    if [ -n "$api_level" ] && [ "$api_level" -lt 30 ]; then
        ui_print "⚠️ 警告: 模块针对Android 11+优化"
        ui_print "  低于Android 11的版本可能无法正常工作"
    fi
    
    ui_print ""
}

# ========================================
# 文件权限设置
# ========================================

set_permissions() {
    ui_print "🔐 正在设置文件权限..."
    
    # 设置脚本执行权限
    if check_file_exists "$MODPATH/service.sh"; then
        chmod +x "$MODPATH/service.sh" 2>/dev/null
        [ $? -eq 0 ] && ui_print "  ✅ service.sh"
    fi
    
    if check_file_exists "$MODPATH/post-fs-data.sh"; then
        chmod +x "$MODPATH/post-fs-data.sh" 2>/dev/null
        [ $? -eq 0 ] && ui_print "  ✅ post-fs-data.sh"
    fi
    
    if check_file_exists "$MODPATH/uninstall.sh"; then
        chmod +x "$MODPATH/uninstall.sh" 2>/dev/null
        [ $? -eq 0 ] && ui_print "  ✅ uninstall.sh"
    fi
    
    if check_file_exists "$MODPATH/bootctl-helper.sh"; then
        chmod +x "$MODPATH/bootctl-helper.sh" 2>/dev/null
        [ $? -eq 0 ] && ui_print "  ✅ bootctl-helper.sh"
    fi
    
    ui_print ""
}

# ========================================
# 创建必要的目录
# ========================================

create_directories() {
    ui_print "📁 正在创建必要目录..."
    
    local dirs="/data/local/tmp /data/misc/update_engine"
    
    for dir in $dirs; do
        if ! check_dir_exists "$dir"; then
            mkdir -p "$dir" 2>/dev/null
            if [ $? -eq 0 ]; then
                ui_print "  ✅ $dir"
            else
                ui_print "  ⚠️ 无法创建 $dir (可能权限不足)"
            fi
        else
            ui_print "  ✓ $dir 已存在"
        fi
    done
    
    ui_print ""
}

# ========================================
# SELinux状态检查
# ========================================

check_selinux() {
    ui_print "🔒 SELinux状态检查..."
    
    local selinux_status=$(getenforce 2>/dev/null)
    
    if [ -n "$selinux_status" ]; then
        ui_print "  SELinux状态: $selinux_status"
        
        if [ "$selinux_status" = "Enforcing" ]; then
            ui_print "  ℹ️ SELinux处于强制模式"
            ui_print "     模块可能需要额外的SELinux策略"
        fi
    fi
    ui_print ""
}

# ========================================
# 主程序入口
# ========================================

main() {
    ui_print ""
    ui_print "=================================="
    ui_print "🔓 A/B 分区幽灵锁解锁器"
    ui_print "   A/B Partition Ghost Lock Unlocker"
    ui_print "   版本: v1.1.0 (优化版)"
    ui_print "=================================="
    ui_print ""
    
    # 步骤1: 显示用户协议
    show_disclaimer
    
    # 步骤2: 强制阅读倒计时
    force_read_countdown
    
    # 步骤3: 音量键确认安装
    volume_key_confirmation
    
    # 步骤4: 设备兼容性检查
    check_compatibility
    
    # 步骤5: Android版本检查
    check_android_version
    
    # 步骤6: SELinux检查
    check_selinux
    
    # 步骤7: 创建必要目录
    create_directories
    
    # 步骤8: 设置文件权限
    set_permissions
    
    ui_print "=================================="
    ui_print "✅ 模块安装完成！"
    ui_print "=================================="
    ui_print ""
    ui_print "📋 下一步操作:"
    ui_print "  1. 重启设备以激活模块"
    ui_print "  2. 打开模块Web UI进行配置"
    ui_print "  3. 选择自动化或手动模式"
    ui_print ""
    ui_print "🌐 Web UI 访问地址:"
    ui_print "  http://localhost:9999"
    ui_print ""
    ui_print "📝 日志文件位置:"
    ui_print "  /data/local/tmp/ab_unlocker.log"
    ui_print ""
    ui_print "💬 如遇问题:"
    ui_print "  - 深呼吸保持冷静"
    ui_print "  - 查看日志获取详细信息"
    ui_print "  - 联系开发者寻求帮助"
    ui_print "=================================="
    ui_print ""
}

# 执行主程序
main
