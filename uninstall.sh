#!/system/bin/sh

# ========================================
# uninstall.sh - 卸载清理脚本
# 安全删除所有模块创建的文件和状态
# ========================================

MODDIR=${0%/*}
LOG_FILE="/data/local/tmp/ab_unlocker.log"

# 要清理的文件和目录列表
CLEANUP_FILES="/data/local/tmp/ab_unlocker.log
/data/local/tmp/ab_unlocker.lock
/data/local/tmp/ab_unlocker.pid
/data/local/tmp/ab_unlocker_last_slot
/data/local/tmp/ab_unlocker_startup.lock"

CLEANUP_DIRS=""

# ========================================
# 日志函数
# ========================================

log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] [uninstall] $1" >> "$LOG_FILE" 2>/dev/null
}

# ========================================
# 安全删除文件
# ========================================

safe_rm_file() {
    local file=$1
    
    if [ -f "$file" ]; then
        # 确保文件存在且可删除
        if rm -f "$file" 2>/dev/null; then
            log "已删除文件: $file"
            return 0
        else
            log "无法删除文件: $file"
            return 1
        fi
    fi
    return 0
}

# ========================================
# 安全删除目录
# ========================================

safe_rm_dir() {
    local dir=$1
    
    if [ -d "$dir" ]; then
        # 检查目录是否为空
        if [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
            # 目录为空，可以安全删除
            if rmdir "$dir" 2>/dev/null; then
                log "已删除空目录: $dir"
                return 0
            fi
        else
            # 目录非空，尝试递归删除
            if rm -rf "$dir" 2>/dev/null; then
                log "已删除目录: $dir"
                return 0
            else
                log "无法删除目录: $dir"
                return 1
            fi
        fi
    fi
    return 0
}

# ========================================
# 停止正在运行的服务
# ========================================

stop_services() {
    log "停止相关服务..."
    
    local services="update_engine update_engine_client update_verifier ota_service"
    
    for service in $services; do
        if pgrep -x "$service" > /dev/null 2>&1; then
            log "停止服务: $service"
            pkill -9 "$service" 2>/dev/null
        fi
    done
}

# ========================================
# 清理update_engine状态
# ========================================

cleanup_update_engine() {
    log "清理update_engine状态..."
    
    local state_dirs="/data/misc/update_engine
                      /data/misc/ce/0/update_engine
                      /data/misc/apexdata/com.android.updater"
    
    for dir in $state_dirs; do
        if [ -d "$dir" ]; then
            # 删除目录内所有文件但保留目录结构
            find "$dir" -type f -delete 2>/dev/null
            find "$dir" -type d -empty -delete 2>/dev/null
            
            if [ $? -eq 0 ]; then
                log "已清理: $dir"
            fi
        fi
    done
}

# ========================================
# 主程序入口
# ========================================

main() {
    log "=== 开始卸载 A/B Partition Ghost Lock Unlocker ==="
    
    # 步骤1: 停止服务
    stop_services
    
    # 等待进程结束
    sleep 2
    
    # 步骤2: 清理update_engine状态
    cleanup_update_engine
    
    # 步骤3: 删除模块文件
    log "删除模块文件..."
    
    if [ -d "$MODDIR" ]; then
        # 删除模块目录下的所有文件
        find "$MODDIR" -type f -delete 2>/dev/null
        
        # 删除空目录
        find "$MODDIR" -type d -empty -delete 2>/dev/null
        
        # 删除模块根目录
        rmdir "$MODDIR" 2>/dev/null
        
        log "模块文件已清理"
    fi
    
    # 步骤4: 删除临时文件
    log "删除临时文件..."
    
    for file in $CLEANUP_FILES; do
        safe_rm_file "$file"
    done
    
    # 步骤5: 删除临时目录
    for dir in $CLEANUP_DIRS; do
        safe_rm_dir "$dir"
    done
    
    log "=== 卸载完成 ==="
    log "所有模块相关文件和状态已清理"
    log "感谢使用 A/B Partition Ghost Lock Unlocker"
    
    exit 0
}

# 执行主程序
main
