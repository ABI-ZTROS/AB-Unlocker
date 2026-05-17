#!/system/bin/sh

# ========================================
# bootctl-helper.sh - boot_control HAL辅助脚本
# 用于查询槽位状态和诊断信息
# ========================================

LOG_FILE="/data/local/tmp/ab_unlocker.log"

# 超时设置
TIMEOUT_SECONDS=5

# bootctl工具路径
BOOTCTL="/system/bin/bootctl"

# ========================================
# 日志函数
# ========================================

log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] [bootctl] $1" >> "$LOG_FILE" 2>/dev/null
}

log_error() {
    log "❌ ERROR: $1"
}

log_warn() {
    log "⚠️ WARNING: $1"
}

# ========================================
# 超时执行函数
# ========================================

timeout_exec() {
    local timeout=$1
    shift 1
    local cmd="$@"
    
    (
        eval "$cmd" &
        local pid=$!
        
        (
            sleep $timeout
            kill -9 $pid 2>/dev/null
        ) &
        local timer=$!
        
        wait $pid 2>/dev/null
        local result=$?
        
        kill -9 $timer 2>/dev/null
        wait $timer 2>/dev/null
        
        return $result
    )
}

# ========================================
# 检查工具是否存在
# ========================================

check_bootctl() {
    # 检查文件是否存在
    if [ ! -f "$BOOTCTL" ]; then
        log_error "bootctl工具不存在: $BOOTCTL"
        return 1
    fi
    
    # 检查是否可执行
    if [ ! -x "$BOOTCTL" ]; then
        # 尝试添加执行权限
        chmod +x "$BOOTCTL" 2>/dev/null
        if [ ! -x "$BOOTCTL" ]; then
            log_error "bootctl工具不可执行"
            return 1
        fi
    fi
    
    return 0
}

# ========================================
# 检查SELinux权限
# ========================================

check_permissions() {
    # 测试bootctl是否可以执行
    if ! timeout_exec $TIMEOUT_SECONDS "$BOOTCTL dump" > /dev/null 2>&1; then
        log_warn "bootctl执行失败，可能是SELinux权限问题"
        return 1
    fi
    
    return 0
}

# ========================================
# 获取当前槽位
# ========================================

get_current_slot() {
    if ! check_bootctl; then
        log_error "bootctl工具不可用"
        return 1
    fi
    
    if ! check_permissions; then
        return 1
    fi
    
    # 获取当前槽位
    local output=$(timeout_exec $TIMEOUT_SECONDS "$BOOTCTL dump" 2>/dev/null)
    
    if [ -z "$output" ]; then
        log_error "bootctl dump返回空"
        return 1
    fi
    
    # 解析当前槽位
    local current_slot=$(echo "$output" | grep "current slot:" | awk '{print $3}' | tr -d '[]' | head -n1)
    
    if [ -z "$current_slot" ]; then
        log_error "无法解析当前槽位"
        return 1
    fi
    
    log "当前槽位: $current_slot"
    echo "$current_slot"
    return 0
}

# ========================================
# 获取所有槽位信息
# ========================================

get_all_slots_info() {
    if ! check_bootctl; then
        return 1
    fi
    
    if ! check_permissions; then
        return 1
    fi
    
    log "=== boot_control HAL 槽位状态 ==="
    
    local output=$(timeout_exec $TIMEOUT_SECONDS "$BOOTCTL dump" 2>/dev/null)
    
    if [ -z "$output" ]; then
        log_error "bootctl dump返回空"
        return 1
    fi
    
    echo "$output" | while read line; do
        log "  $line"
        echo "  $line"
    done
    
    log "==================================="
    return 0
}

# ========================================
# 检查槽位状态
# ========================================

check_slot_status() {
    local slot_num=$1
    
    if ! check_bootctl || ! check_permissions; then
        return 1
    fi
    
    case "$slot_num" in
        0)
            local result=$(timeout_exec $TIMEOUT_SECONDS "$BOOTCTL dump" 2>/dev/null | grep "slot 0:" | head -n1)
            if echo "$result" | grep -qi "bootable\|successful"; then
                echo "OK"
                return 0
            fi
            ;;
        1)
            local result=$(timeout_exec $TIMEOUT_SECONDS "$BOOTCTL dump" 2>/dev/null | grep "slot 1:" | head -n1)
            if echo "$result" | grep -qi "bootable\|successful"; then
                echo "OK"
                return 0
            fi
            ;;
    esac
    
    echo "UNKNOWN"
    return 1
}

# ========================================
# 工具自检
# ========================================

self_check() {
    log "=== bootctl工具自检 ==="
    
    if check_bootctl; then
        log "✅ bootctl工具存在"
    else
        log "❌ bootctl工具不可用"
        return 1
    fi
    
    if check_permissions; then
        log "✅ bootctl权限正常"
    else
        log "❌ bootctl权限不足"
        return 1
    fi
    
    # 测试dump命令
    if timeout_exec $TIMEOUT_SECONDS "$BOOTCTL dump" > /dev/null 2>&1; then
        log "✅ bootctl dump测试成功"
    else
        log "❌ bootctl dump测试失败"
        return 1
    fi
    
    log "=== 自检完成 ==="
    return 0
}

# ========================================
# 显示帮助信息
# ========================================

show_help() {
    echo "Usage: $0 {current|all|status|check|help}"
    echo ""
    echo "Commands:"
    echo "  current    - 获取当前激活槽位"
    echo "  all        - 获取所有槽位详细信息"
    echo "  status     - 获取所有槽位状态"
    echo "  check      - 执行工具自检"
    echo "  help       - 显示此帮助信息"
    echo ""
    echo "Examples:"
    echo "  $0 current"
    echo "  $0 all"
    echo "  $0 status 0"
}

# ========================================
# 主程序入口
# ========================================

main() {
    # 如果没有参数，显示帮助
    if [ $# -eq 0 ]; then
        show_help
        exit 0
    fi
    
    case "$1" in
        "current")
            get_current_slot
            exit $?
            ;;
        "all")
            get_all_slots_info
            exit $?
            ;;
        "status")
            if [ -n "$2" ]; then
                check_slot_status "$2"
                exit $?
            else
                # 显示所有槽位状态
                echo "槽位0状态: $(check_slot_status 0)"
                echo "槽位1状态: $(check_slot_status 1)"
                exit 0
            fi
            ;;
        "check")
            self_check
            exit $?
            ;;
        "help"|"-h"|"--help")
            show_help
            exit 0
            ;;
        *)
            echo "未知命令: $1"
            show_help
            exit 1
            ;;
    esac
}

# 执行主程序
main "$@"
