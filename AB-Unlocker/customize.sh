#!/system/bin/sh

# ========================================
# customize.sh - 自定义安装脚本
# 设备兼容性检查和初始化配置
# ========================================

# 检查函数
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
# 设备兼容性检查
# ========================================

check_compatibility() {
    ui_print ""
    ui_print "正在检查设备兼容性..."
    ui_print "=================================="
    
    # 获取设备基本信息
    ui_print "设备信息:"
    ui_print "  - 型号: $(getprop ro.product.model 2>/dev/null)"
    ui_print "  - 制造商: $(getprop ro.product.manufacturer 2>/dev/null)"
    ui_print "  - 品牌: $(getprop ro.product.brand 2>/dev/null)"
    
    # 获取系统版本
    ui_print ""
    ui_print "系统版本:"
    check_prop "ro.build.version.release"
    check_prop "ro.build.version.sdk"
    
    # 检查ColorOS/Realme UI标识
    ui_print ""
    ui_print "检测系统类型:"
    local coloros_detected=0
    local device_type=""
    
    # OPPO/一加/Realme检测
    local manufacturer=$(getprop ro.product.manufacturer 2>/dev/null | tr '[:upper:]' '[:lower:]')
    local brand=$(getprop ro.product.brand 2>/dev/null | tr '[:upper:]' '[:lower:]')
    
    if [ "$manufacturer" = "oppo" ] || [ "$brand" = "oppo" ]; then
        coloros_detected=1
        device_type="OPPO"
        ui_print "  ✅ 检测到OPPO设备"
    fi
    
    if [ "$manufacturer" = "oneplus" ] || [ "$brand" = "oneplus" ]; then
        coloros_detected=1
        device_type="OnePlus"
        ui_print "  ✅ 检测到OnePlus设备"
    fi
    
    if [ "$manufacturer" = "realme" ] || [ "$brand" = "realme" ]; then
        coloros_detected=1
        device_type="Realme"
        ui_print "  ✅ 检测到Realme设备"
    fi
    
    # ColorOS版本检测
    local coloros_ver=$(getprop ro.build.version.opporom 2>/dev/null)
    if [ -n "$coloros_ver" ]; then
        coloros_detected=1
        device_type="ColorOS"
        ui_print "  ✅ 检测到ColorOS: $coloros_ver"
    fi
    
    # Realme UI版本检测
    local realme_ui=$(getprop ro.build.version.realme 2>/dev/null)
    if [ -n "$realme_ui" ]; then
        coloros_detected=1
        device_type="Realme UI"
        ui_print "  ✅ 检测到Realme UI: $realme_ui"
    fi
    
    # OxygenOS检测（基于ColorOS）
    local oxygenos=$(getprop ro.build.version.oxygen 2>/dev/null)
    if [ -n "$oxygenos" ]; then
        coloros_detected=1
        device_type="OxygenOS/ColorOS"
        ui_print "  ✅ 检测到OxygenOS: $oxygenos"
    fi
    
    ui_print ""
    ui_print "=================================="
    
    # 兼容性判定
    if [ $coloros_detected -eq 0 ]; then
        ui_print ""
        ui_print "❌ 错误：设备不兼容！"
        ui_print ""
        ui_print "此模块专为ColorOS/OxygenOS/Realme UI设备设计"
        ui_print ""
        ui_print "支持的设备："
        ui_print "  ✅ OPPO ColorOS 设备"
        ui_print "  ✅ OnePlus ColorOS/OxygenOS 设备"
        ui_print "  ✅ Realme UI 设备"
        ui_print ""
        ui_print "不支持："
        ui_print "  ❌ 小米/Redmi/POCO (MIUI/HyperOS)"
        ui_print "  ❌ Samsung (OneUI)"
        ui_print "  ❌ 其他Android设备"
        ui_print ""
        ui_print "=================================="
        ui_print "安装已取消"
        ui_print "=================================="
        abort "设备不兼容"
    fi
    
    ui_print ""
    ui_print "✅ 设备兼容性检查通过"
    ui_print "支持的设备类型: $device_type"
    ui_print "=================================="
    ui_print ""
}

# ========================================
# 文件权限设置
# ========================================

set_permissions() {
    ui_print "设置文件权限..."
    
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
    ui_print "创建必要目录..."
    
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
# Android版本检查
# ========================================

check_android_version() {
    local api_level=$(getprop ro.build.version.sdk 2>/dev/null)
    
    if [ -z "$api_level" ]; then
        ui_print "⚠️ 无法获取Android API级别"
        return 0
    fi
    
    ui_print "Android API级别: $api_level"
    
    # 最低支持Android 11 (API 30)
    if [ "$api_level" -lt 30 ]; then
        ui_print "⚠️ 警告: 模块针对Android 11+优化"
        ui_print "  低于Android 11的版本可能无法正常工作"
    fi
    
    ui_print ""
}

# ========================================
# SELinux状态检查
# ========================================

check_selinux() {
    local selinux_status=$(getenforce 2>/dev/null)
    
    if [ -n "$selinux_status" ]; then
        ui_print "SELinux状态: $selinux_status"
        
        if [ "$selinux_status" = "Enforcing" ]; then
            ui_print "ℹ️ SELinux处于强制模式"
            ui_print "  模块可能需要额外的SELinux策略"
        fi
    fi
    ui_print ""
}

# ========================================
# 主程序入口
# ========================================

main() {
    ui_print "=================================="
    ui_print " A/B Partition Ghost Lock Unlocker"
    ui_print " 安装向导 v1.0.0"
    ui_print "=================================="
    ui_print ""
    
    # 步骤1: 设备兼容性检查
    check_compatibility
    
    # 步骤2: Android版本检查
    check_android_version
    
    # 步骤3: SELinux检查
    check_selinux
    
    # 步骤4: 创建必要目录
    create_directories
    
    # 步骤5: 设置文件权限
    set_permissions
    
    ui_print "=================================="
    ui_print "✅ 模块安装完成！"
    ui_print "=================================="
    ui_print ""
    ui_print "重启设备后模块将自动生效"
    ui_print ""
    ui_print "日志文件位置:"
    ui_print "/data/local/tmp/ab_unlocker.log"
    ui_print ""
    ui_print "如遇问题，请查看日志获取详细信息"
    ui_print "=================================="
}

# 执行主程序
main
