#!/system/bin/sh

# ========================================
# post-fs-data.sh - 开机早期执行脚本
# 用于系统启动早期的环境准备
# ========================================

MODDIR=${0%/*}
LOG_FILE="/data/local/tmp/ab_unlocker.log"
STARTUP_LOCK="/data/local/tmp/ab_unlocker_startup.lock"

# 日志函数
log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] [post-fs-data] $1" >> "$LOG_FILE" 2>/dev/null
}

log_error() {
    log "❌ ERROR: $1"
}

log_success() {
    log "✅ $1"
}

# 检查文件是否存在
check_file() {
    [ -f "$1" ] && return 0 || return 1
}

# 安全删除
safe_rm() {
    if check_file "$1"; then
        rm -f "$1" 2>/dev/null
        return $?
    fi
    return 0
}

# 获取锁防止重复执行
acquire_lock() {
    if check_file "$STARTUP_LOCK"; then
        local timestamp=$(cat "$STARTUP_LOCK" 2>/dev/null)
        if [ -n "$timestamp" ]; then
            log "检测到已有启动锁，跳过执行"
            return 1
        fi
    fi
    
    echo $(date +%s) > "$STARTUP_LOCK"
    return 0
}

# 信号处理
cleanup() {
    safe_rm "$STARTUP_LOCK"
    exit 0
}

trap cleanup SIGTERM SIGINT SIGHUP

# 主程序
main() {
    if ! acquire_lock; then
        exit 0
    fi
    
    log "开始执行post-fs-data初始化"
    
    # 等待系统基本就绪
    local wait_count=0
    local max_wait=30
    
    while [ $wait_count -lt $max_wait ]; do
        if [ -d /data ]; then
            break
        fi
        sleep 1
        wait_count=$((wait_count + 1))
    done
    
    if [ $wait_count -ge $max_wait ]; then
        log_error "/data目录在${max_wait}秒内未就绪"
        exit 1
    fi
    
    # 创建必要的目录
    local dirs="/data/local/tmp /data/misc/update_engine"
    for dir in $dirs; do
        if [ ! -d "$dir" ]; then
            mkdir -p "$dir" 2>/dev/null
            if [ $? -eq 0 ]; then
                log_success "创建目录: $dir"
            else
                log_error "无法创建目录: $dir"
            fi
        fi
    done
    
    # 设置日志文件权限
    if check_file "$LOG_FILE"; then
        chmod 666 "$LOG_FILE" 2>/dev/null
    fi
    
    # 清理过期的锁文件
    if check_file "/data/local/tmp/ab_unlocker.lock"; then
        local lock_pid=$(cat "/data/local/tmp/ab_unlocker.lock" 2>/dev/null)
        if [ -n "$lock_pid" ]; then
            if ! kill -0 "$lock_pid" 2>/dev/null; then
                log "清理过期的服务锁文件"
                safe_rm "/data/local/tmp/ab_unlocker.lock"
            fi
        fi
    fi
    
    log "post-fs-data初始化完成，准备启动service.sh"
    
    # 启动主服务
    (
        sleep 30
        if [ -x "$MODDIR/service.sh" ]; then
            log "启动主服务..."
            $MODDIR/service.sh &
        else
            log_error "service.sh不可执行或不存在"
        fi
    ) &
    
    exit 0
}

main
