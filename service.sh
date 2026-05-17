#!/system/bin/sh

# ========================================
# service.sh - A/B分区幽灵锁解锁器
# 核心服务脚本 - 增强健壮性版本
# ========================================

# 基础路径定义
MODDIR=${0%/*}
LOG_FILE="/data/local/tmp/ab_unlocker.log"
LAST_SLOT_FILE="/data/local/tmp/ab_unlocker_last_slot"
LOCK_FILE="/data/local/tmp/ab_unlocker.lock"
PID_FILE="/data/local/tmp/ab_unlocker.pid"

# 配置参数
MAX_RETRY=3
RETRY_DELAY=2
TIMEOUT_SECONDS=60
BOOT_TIMEOUT=120

# ========================================
# 错误处理和工具函数
# ========================================

# 日志函数
log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $1" >> "$LOG_FILE" 2>/dev/null
}

# 错误日志
log_error() {
    log "❌ ERROR: $1"
}

# 警告日志
log_warn() {
    log "⚠️  WARNING: $1"
}

# 成功日志
log_success() {
    log "✅ $1"
}

# 检查文件是否存在
check_file_exists() {
    [ -f "$1" ] && return 0 || return 1
}

# 检查目录是否存在
check_dir_exists() {
    [ -d "$1" ] && return 0 || return 1
}

# 检查进程是否运行
check_process_running() {
    local proc_name=$1
    pgrep -x "$proc_name" > /dev/null 2>&1
    return $?
}

# 等待进程结束
wait_for_process() {
    local proc_name=$1
    local max_wait=${2:-10}
    local waited=0
    
    while check_process_running "$proc_name"; do
        if [ $waited -ge $max_wait ]; then
            log_warn "进程 $proc_name 在${max_wait}秒后仍在运行"
            return 1
        fi
        sleep 1
        waited=$((waited + 1))
    done
    return 0
}

# 安全删除文件
safe_rm() {
    if check_file_exists "$1"; then
        rm -f "$1" 2>/dev/null
        [ $? -eq 0 ] && return 0 || return 1
    fi
    return 0
}

# 创建锁文件防止重复运行
acquire_lock() {
    if check_file_exists "$LOCK_FILE"; then
        local old_pid=$(cat "$LOCK_FILE" 2>/dev/null)
        if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
            log_warn "检测到旧进程仍在运行 (PID: $old_pid)，跳过本次执行"
            exit 0
        else
            log_warn "清理过期的锁文件"
            safe_rm "$LOCK_FILE"
        fi
    fi
    
    echo $$ > "$LOCK_FILE"
    [ $? -ne 0 ] && log_error "无法创建锁文件" && return 1
    return 0
}

# 释放锁文件
release_lock() {
    safe_rm "$LOCK_FILE"
}

# 超时执行函数
timeout_wrapper() {
    local timeout=$1
    local command=$2
    shift 2
    local args="$@"
    
    ( $command $args ) &
    local pid=$!
    
    ( sleep $timeout && kill -9 $pid 2>/dev/null ) &
    local timer=$!
    
    wait $pid 2>/dev/null
    local result=$?
    
    kill -9 $timer 2>/dev/null
    wait $timer 2>/dev/null
    
    return $result
}

# ========================================
# 槽位检测函数（多级Fallback）
# ========================================

get_current_slot() {
    local slot=""
    
    # 方法1：从内核调试接口读取
    if [ -r /d/slot_info ]; then
        slot=$(timeout_wrapper 5 cat /d/slot_info 2>/dev/null | grep -i "current_slot" | awk '{print $2}' | head -n1)
        if [ -n "$slot" ]; then
            log "槽位检测（/d/slot_info）: $slot"
            echo "$slot"
            return 0
        fi
    fi
    
    # 方法2：从内核命令行参数读取
    if [ -r /proc/cmdline ]; then
        local cmdline=$(timeout_wrapper 5 cat /proc/cmdline 2>/dev/null)
        slot=$(echo "$cmdline" | grep -o 'androidboot\.slot_suffix=[^ ]*' | cut -d '=' -f2 | head -n1)
        if [ -n "$slot" ]; then
            log "槽位检测（/proc/cmdline）: $slot"
            echo "$slot"
            return 0
        fi
    fi
    
    # 方法3：从系统属性读取
    slot=$(getprop ro.boot.slot_suffix 2>/dev/null)
    if [ -n "$slot" ]; then
        log "槽位检测（getprop）: $slot"
        echo "$slot"
        return 0
    fi
    
    log_error "无法获取当前槽位"
    return 1
}

# ========================================
# 分区锁死探测（原生系统调用）
# ========================================

detect_partition_lock() {
    local partition="$1"
    
    # 检查分区是否存在
    if [ ! -e "$partition" ]; then
        log_warn "分区不存在: $partition"
        echo "NOT_EXIST"
        return 2
    fi
    
    log "探测分区锁死: $partition"
    
    # 使用Python进行精确探测
    timeout_wrapper 10 python3 - 2>/dev/null << 'PYTHON_EOF'
import os
import sys
import errno

partition = sys.argv[1]
try:
    fd = os.open(partition, os.O_RDWR | os.O_EXCL | os.O_NOCTTY | os.O_NOFOLLOW)
    os.close(fd)
    print("UNLOCKED")
    sys.exit(0)
except OSError as e:
    if e.errno == errno.EBUSY:
        print("LOCKED_EBUSY")
        sys.exit(1)
    elif e.errno == errno.EACCES:
        print("LOCKED_EACCES")
        sys.exit(2)
    elif e.errno == errno.ENOENT:
        print("NOT_EXIST")
        sys.exit(3)
    else:
        print(f"ERROR_{e.errno}")
        sys.exit(4)
except Exception as e:
    print(f"ERROR_UNKNOWN")
    sys.exit(5)
PYTHON_EOF
    
    return $?
}

# ========================================
# 分区路径解析
# ========================================

resolve_partition_path() {
    local part_type=$1
    local slot=$2
    
    # 尝试多种命名方式
    local paths="/dev/block/by-name/${part_type}${slot}
                /dev/block/by-name/${part_type}_${slot}
                /dev/block/by-name/${part_type}
                /dev/block/${part_type}${slot}
                /dev/block/${part_type}_${slot}"
    
    for path in $paths; do
        if [ -e "$path" ]; then
            echo "$path"
            return 0
        fi
    done
    
    return 1
}

# ========================================
# 服务控制函数
# ========================================

safe_stop_service() {
    local service_name=$1
    local max_wait=${2:-5}
    
    if check_process_running "$service_name"; then
        log "尝试停止服务: $service_name"
        stop "$service_name" 2>/dev/null
        
        if wait_for_process "$service_name" $max_wait; then
            log_success "服务已停止: $service_name"
            return 0
        else
            log_warn "强制终止服务: $service_name"
            pkill -9 "$service_name" 2>/dev/null
            sleep 1
        fi
    fi
    
    return 0
}

safe_kill_process() {
    local proc_pattern=$1
    local max_wait=${2:-3}
    
    if pgrep -x "$proc_pattern" > /dev/null 2>&1; then
        log "终止进程: $proc_pattern"
        pkill -9 "$proc_pattern" 2>/dev/null
        sleep 1
        
        if pgrep -x "$proc_pattern" > /dev/null 2>&1; then
            log_warn "进程仍在运行: $proc_pattern"
            return 1
        fi
    fi
    
    return 0
}

# ========================================
# 解锁执行函数
# ========================================

trigger_unlock() {
    log "⚠️ 开始解锁流程..."
    local unlock_success=0
    local retry=0
    
    while [ $retry -lt $MAX_RETRY ]; do
        log "解锁尝试 ($((retry + 1))/$MAX_RETRY)"
        
        # 步骤1：停止update_engine服务
        log "1/4: 停止update_engine服务..."
        safe_stop_service "update_engine"
        safe_stop_service "update_engine_client"
        safe_stop_service "update_verifier"
        safe_stop_service "ota_service"
        safe_stop_service "android.hardware.update-api-1-0"
        
        # 步骤2：终止进程
        log "2/4: 终止update_engine进程..."
        safe_kill_process "update_engine"
        safe_kill_process "update_engine_client"
        safe_kill_process "update_verifier"
        
        # 等待资源释放
        sleep $RETRY_DELAY
        
        # 步骤3：清除状态文件
        log "3/4: 清除update_engine状态..."
        rm -rf /data/misc/update_engine/* 2>/dev/null
        rm -rf /data/misc/ce/0/update_engine/* 2>/dev/null
        rm -rf /data/misc/apexdata/com.android.updater/* 2>/dev/null
        
        # 等待清除完成
        sleep $RETRY_DELAY
        
        # 步骤4：验证解锁
        log "4/4: 验证解锁结果..."
        
        local verify_result=$(detect_partition_lock "$PARTITION")
        case "$verify_result" in
            "UNLOCKED")
                log_success "解锁成功！分区已可写入"
                unlock_success=1
                break
                ;;
            "NOT_EXIST")
                log_warn "分区不存在，跳过验证"
                unlock_success=1
                break
                ;;
            *)
                log_warn "解锁失败，结果: $verify_result"
                retry=$((retry + 1))
                if [ $retry -lt $MAX_RETRY ]; then
                    log "等待${RETRY_DELAY}秒后重试..."
                    sleep $RETRY_DELAY
                fi
                ;;
        esac
    done
    
    if [ $unlock_success -eq 0 ]; then
        log_error "解锁失败，建议手动重启设备"
        return 1
    fi
    
    return 0
}

# ========================================
# 信号处理
# ========================================

cleanup() {
    log "收到终止信号，正在清理..."
    release_lock
    exit 0
}

trap cleanup SIGTERM SIGINT SIGHUP

# ========================================
# 主程序入口
# ========================================

main() {
    # 获取锁
    acquire_lock || exit 1
    
    # 检查系统是否完全启动
    local boot_completed=$(getprop sys.boot_completed 2>/dev/null)
    if [ "$boot_completed" != "1" ]; then
        log "系统尚未完全启动，等待..."
        local waited=0
        while [ "$boot_completed" != "1" ] && [ $waited -lt $BOOT_TIMEOUT ]; do
            sleep 5
            waited=$((waited + 5))
            boot_completed=$(getprop sys.boot_completed 2>/dev/null)
        done
        
        if [ "$boot_completed" != "1" ]; then
            log_warn "系统启动超时，但继续执行"
        fi
    fi
    
    log "=== A/B Partition Ghost Lock Unlocker 启动 ==="
    
    # 获取当前槽位
    CURRENT_SLOT=$(get_current_slot)
    if [ $? -ne 0 ] || [ -z "$CURRENT_SLOT" ]; then
        log_error "无法确定当前槽位"
        release_lock
        exit 1
    fi
    
    log "当前激活槽位: $CURRENT_SLOT"
    
    # 检查是否为有效的槽位
    case "$CURRENT_SLOT" in
        "_a"|"_b")
            log "槽位标识有效"
            ;;
        *)
            log_error "无法识别的槽位标识: $CURRENT_SLOT"
            release_lock
            exit 1
            ;;
    esac
    
    # 读取上次记录的槽位
    if check_file_exists "$LAST_SLOT_FILE"; then
        LAST_SLOT=$(cat "$LAST_SLOT_FILE" 2>/dev/null)
        log "上次记录槽位: $LAST_SLOT"
    else
        log "首次运行，记录当前槽位"
        echo "$CURRENT_SLOT" > "$LAST_SLOT_FILE" 2>/dev/null
        release_lock
        exit 0
    fi
    
    # 检查是否发生槽位切换
    if [ "$CURRENT_SLOT" = "$LAST_SLOT" ]; then
        log "槽位未发生变化，无需检测"
        release_lock
        exit 0
    fi
    
    log "检测到槽位切换！开始检测旧槽状态..."
    
    # 确定旧槽位
    if [ "$CURRENT_SLOT" = "_a" ]; then
        OLD_SLOT="_b"
    else
        OLD_SLOT="_a"
    fi
    
    log "旧槽位: $OLD_SLOT"
    
    # 探测分区列表
    local PARTITION_TYPES="boot system vendor odm"
    local detected_lock=0
    
    for part_type in $PARTITION_TYPES; do
        PARTITION=$(resolve_partition_path "$part_type" "$OLD_SLOT")
        
        if [ $? -eq 0 ] && [ -n "$PARTITION" ]; then
            local result=$(detect_partition_lock "$PARTITION")
            
            case "$result" in
                "UNLOCKED")
                    log "分区 $PARTITION 未被锁死"
                    ;;
                "LOCKED_EBUSY")
                    log "⚠️ 检测到分区锁死（EBUSY）: $PARTITION"
                    detected_lock=1
                    trigger_unlock
                    break
                    ;;
                "LOCKED_EACCES")
                    log "⚠️ 权限不足: $PARTITION"
                    detected_lock=1
                    ;;
                "NOT_EXIST")
                    log "分区不存在: $PARTITION，跳过"
                    ;;
                *)
                    log_warn "探测出错: $result"
                    ;;
            esac
        fi
    done
    
    # 更新槽位记录
    echo "$CURRENT_SLOT" > "$LAST_SLOT_FILE" 2>/dev/null
    [ $? -ne 0 ] && log_error "无法更新槽位记录"
    
    log "更新槽位记录完成"
    log "=== 检测流程结束 ==="
    
    release_lock
    exit 0
}

# 执行主程序
main
