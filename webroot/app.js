// ========================================
// A/B Partition Ghost Lock Unlocker - WebUI JavaScript
// 核心逻辑和交互处理（增强版）
// ========================================

// 全局状态管理
const AppState = {
    isChecking: false,
    isUnlocking: false,
    isDiagnosing: false,
    usageConfirmed: false,
    deviceInfo: {},
    partitionStatus: [],
    warnings: [],
    logs: []
};

// ========================================
// 使用条件检查相关函数
// ========================================

// 初始化使用条件检查
function initializeUsageCheck() {
    const checkboxes = [
        'check-ota',
        'check-root',
        'check-bootloop',
        'check-camera'
    ];

    checkboxes.forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.addEventListener('change', validateUsageConditions);
        }
    });

    addLog('使用条件检查已初始化', 'info');
}

// 验证使用条件
function validateUsageConditions() {
    const conditions = [
        document.getElementById('check-ota')?.checked,
        document.getElementById('check-root')?.checked,
        document.getElementById('check-bootloop')?.checked,
        document.getElementById('check-camera')?.checked
    ];

    const allChecked = conditions.every(cond => cond === true);
    const confirmBtn = document.getElementById('confirm-use-btn');

    if (confirmBtn) {
        confirmBtn.disabled = !allChecked;
    }

    return allChecked;
}

// 确认使用条件
async function confirmUsage() {
    if (!validateUsageConditions()) {
        showToast('请勾选所有使用条件', 'warning');
        return;
    }

    try {
        AppState.usageConfirmed = true;
        addLog('用户已确认符合使用条件', 'success');
        showToast('已确认，开始诊断...', 'success');

        // 显示功能区域
        showFunctionalSections();

        // 初始化设备信息加载
        await loadDeviceInfo();

        // 开始诊断
        await performDiagnosis();

    } catch (error) {
        addLog(`确认失败: ${error.message}`, 'error');
        showToast('操作失败', 'error');
    }
}

// 显示功能区域
function showFunctionalSections() {
    const sections = [
        'device-info',
        'diagnosis-section',
        'status-check',
        'warnings-section',
        'fix-section',
        'log-section'
    ];

    sections.forEach(id => {
        const section = document.getElementById(id);
        if (section) {
            section.style.display = 'block';
        }
    });

    // 隐藏重要提示卡片
    const noticeCard = document.getElementById('important-notice');
    if (noticeCard) {
        noticeCard.style.display = 'none';
    }

    addLog('功能界面已显示', 'info');
}

// 切换提示显示/隐藏
function toggleNotice() {
    const content = document.getElementById('notice-content');
    const toggleText = document.getElementById('notice-toggle-text');

    if (content) {
        if (content.style.display === 'none') {
            content.style.display = 'block';
            if (toggleText) toggleText.textContent = '收起';
        } else {
            content.style.display = 'none';
            if (toggleText) toggleText.textContent = '展开';
        }
    }
}

// ========================================
// 系统诊断相关函数
// ========================================

// 执行系统诊断
async function performDiagnosis() {
    if (AppState.isDiagnosing) {
        showToast('诊断正在进行中...', 'warning');
        return;
    }

    try {
        AppState.isDiagnosing = true;
        AppState.warnings = [];

        const diagnosisList = document.getElementById('diagnosis-list');
        const diagnosisBadge = document.getElementById('diagnosis-badge');

        if (diagnosisList) {
            diagnosisList.innerHTML = '<div class="diagnosis-item loading">正在诊断系统状态...</div>';
        }
        if (diagnosisBadge) {
            diagnosisBadge.textContent = '诊断中';
            diagnosisBadge.className = 'status-badge warning';
        }

        addLog('开始系统诊断...', 'info');

        // 诊断项目
        const diagnoses = await Promise.all([
            diagnoseOTAStatus(),
            diagnoseUpdateEngine(),
            diagnosePartitionLock(),
            diagnoseHardwareIssues()
        ]);

        // 显示诊断结果
        displayDiagnosisResults(diagnoses);

        // 生成警告
        generateWarnings(diagnoses);

        // 更新状态
        if (diagnosisBadge) {
            const hasWarnings = AppState.warnings.length > 0;
            diagnosisBadge.textContent = hasWarnings ? '发现异常' : '正常';
            diagnosisBadge.className = hasWarnings ? 'status-badge warning' : 'status-badge success';
        }

        addLog('系统诊断完成', 'success');

    } catch (error) {
        addLog(`诊断失败: ${error.message}`, 'error');
        showToast('诊断失败', 'error');
    } finally {
        AppState.isDiagnosing = false;
    }
}

// 诊断OTA状态
async function diagnoseOTAStatus() {
    const item = {
        name: 'OTA更新状态',
        status: 'loading',
        result: null,
        description: ''
    };

    try {
        addLog('诊断: OTA更新状态', 'info');

        // 检查是否存在OTA状态文件
        const result = await safeExec('ls -la /data/misc/update_engine/ 2>/dev/null');

        if (result.success && result.stdout) {
            const hasStateFile = result.stdout.includes('状态') || result.stdout.includes('state');
            const hasPendingUpdate = result.stdout.includes('UpdatedNeedReboot') ||
                                    result.stdout.includes('Finalizing');

            if (hasPendingUpdate) {
                item.status = 'warning';
                item.description = '检测到未完成的OTA更新状态';
                addLog('警告: 未完成的OTA更新状态', 'warning');
            } else if (hasStateFile) {
                item.status = 'success';
                item.description = 'OTA状态文件存在，但无异常';
                addLog('OTA状态正常', 'success');
            } else {
                item.status = 'success';
                item.description = '未检测到OTA更新';
                addLog('未检测到OTA更新', 'info');
            }
        } else {
            item.status = 'success';
            item.description = '无OTA更新状态记录';
        }

    } catch (error) {
        item.status = 'error';
        item.description = '诊断失败';
        addLog(`OTA状态诊断失败: ${error.message}`, 'error');
    }

    item.result = item;
    return item;
}

// 诊断Update Engine服务
async function diagnoseUpdateEngine() {
    const item = {
        name: 'Update Engine服务',
        status: 'loading',
        result: null,
        description: ''
    };

    try {
        addLog('诊断: Update Engine服务', 'info');

        // 检查服务是否运行
        const result = await safeExec('ps -A | grep update_engine');

        if (result.success && result.stdout.trim()) {
            item.status = 'warning';
            item.description = 'Update Engine服务仍在运行';
            addLog('警告: Update Engine服务仍在运行', 'warning');
        } else {
            item.status = 'success';
            item.description = 'Update Engine服务已停止';
            addLog('Update Engine服务已停止', 'success');
        }

    } catch (error) {
        item.status = 'error';
        item.description = '诊断失败';
        addLog(`Update Engine诊断失败: ${error.message}`, 'error');
    }

    item.result = item;
    return item;
}

// 诊断分区锁死
async function diagnosePartitionLock() {
    const item = {
        name: '分区锁死检测',
        status: 'loading',
        result: null,
        description: ''
    };

    try {
        addLog('诊断: 分区锁死检测', 'info');

        // 获取当前槽位
        const currentSlot = await getCurrentSlot();
        const oldSlot = currentSlot === '_a' ? '_b' : (currentSlot === '_b' ? '_a' : '');

        if (!oldSlot) {
            item.status = 'warning';
            item.description = '无法确定旧槽位';
            addLog('警告: 无法确定旧槽位', 'warning');
            return item;
        }

        // 检测旧槽位分区
        const partitionPath = `/dev/block/by-name/boot${oldSlot}`;
        const existResult = await safeExec(`test -e ${partitionPath}`);

        if (!existResult.success) {
            item.status = 'success';
            item.description = '旧槽位分区不存在（可能已被清理）';
            addLog('旧槽位分区不存在', 'info');
            return item;
        }

        // 尝试O_EXCL探测
        const lockResult = await detectPartitionLock(`boot${oldSlot}`);

        if (lockResult === 'LOCKED') {
            item.status = 'error';
            item.description = '检测到分区被锁死！';
            addLog('错误: 分区被锁死', 'error');
        } else if (lockResult === 'UNLOCKED') {
            item.status = 'success';
            item.description = '分区未锁死';
            addLog('分区未锁死', 'success');
        } else {
            item.status = 'warning';
            item.description = '分区状态未知';
            addLog('分区状态未知', 'warning');
        }

    } catch (error) {
        item.status = 'error';
        item.description = '诊断失败';
        addLog(`分区锁死诊断失败: ${error.message}`, 'error');
    }

    item.result = item;
    return item;
}

// 诊断硬件问题
async function diagnoseHardwareIssues() {
    const item = {
        name: '硬件可用性检测',
        status: 'loading',
        result: null,
        description: '',
        subChecks: []
    };

    try {
        addLog('诊断: 硬件可用性检测', 'info');

        // 检测相机
        const cameraResult = await safeExec('ls /dev/video* 2>/dev/null | head -1');
        const hasCamera = cameraResult.success && cameraResult.stdout.trim();

        item.subChecks.push({
            name: '相机',
            status: hasCamera ? 'success' : 'warning',
            description: hasCamera ? '可用' : '不可用'
        });

        // 检测闪光灯
        const flashResult = await safeExec('ls /sys/class/leds/ 2>/dev/null | head -5');
        const hasFlash = flashResult.success && flashResult.stdout.trim();

        item.subChecks.push({
            name: '闪光灯',
            status: hasFlash ? 'success' : 'warning',
            description: hasFlash ? '可用' : '不可用'
        });

        // 综合判断
        const allSuccess = item.subChecks.every(check => check.status === 'success');
        const hasWarning = item.subChecks.some(check => check.status === 'warning');

        if (!allSuccess && hasWarning) {
            item.status = 'warning';
            item.description = '检测到部分硬件异常';
            addLog('警告: 部分硬件异常', 'warning');
        } else {
            item.status = 'success';
            item.description = '硬件检测正常';
            addLog('硬件检测正常', 'success');
        }

    } catch (error) {
        item.status = 'error';
        item.description = '诊断失败';
        addLog(`硬件诊断失败: ${error.message}`, 'error');
    }

    item.result = item;
    return item;
}

// 显示诊断结果
function displayDiagnosisResults(diagnoses) {
    const diagnosisList = document.getElementById('diagnosis-list');
    if (!diagnosisList) return;

    const html = diagnoses.map(diag => {
        const statusClass = diag.status === 'success' ? 'success' :
                          diag.status === 'warning' ? 'warning' : 'error';
        const statusText = diag.status === 'success' ? '✅ 正常' :
                         diag.status === 'warning' ? '⚠️ 警告' : '❌ 异常';

        let subChecksHtml = '';
        if (diag.subChecks && diag.subChecks.length > 0) {
            subChecksHtml = '<div class="sub-checks" style="margin-top:8px;padding-left:20px;">' +
                diag.subChecks.map(sub => {
                    const subStatusClass = sub.status === 'success' ? 'success' : 'warning';
                    const subStatusText = sub.status === 'success' ? '✅' : '⚠️';
                    return `<div style="font-size:12px;color:#666;margin:4px 0;">
                        ${subStatusText} ${sub.name}: ${sub.description}
                    </div>`;
                }).join('') +
                '</div>';
        }

        return `
            <div class="diagnosis-item ${statusClass}">
                <span class="diagnosis-name">${diag.name}</span>
                <span class="diagnosis-status ${statusClass}">${statusText}</span>
            </div>
            <div style="font-size:12px;color:#666;padding:8px 12px;background:#fafafa;margin:-8px 0 8px 0;">
                ${diag.description}
                ${subChecksHtml}
            </div>
        `;
    }).join('');

    diagnosisList.innerHTML = html;
}

// 生成警告
function generateWarnings(diagnoses) {
    AppState.warnings = [];

    diagnoses.forEach(diag => {
        if (diag.status === 'warning' || diag.status === 'error') {
            AppState.warnings.push({
                title: diag.name,
                severity: diag.status === 'error' ? 'high' : 'medium',
                description: diag.description,
                suggestion: getWarningSuggestion(diag.name)
            });
        }

        // 检查子项目
        if (diag.subChecks) {
            diag.subChecks.forEach(sub => {
                if (sub.status === 'warning') {
                    AppState.warnings.push({
                        title: `${sub.name}异常`,
                        severity: 'medium',
                        description: sub.description,
                        suggestion: getHardwareSuggestion(sub.name)
                    });
                }
            });
        }
    });

    // 显示警告列表
    displayWarnings();
}

// 获取警告建议
function getWarningSuggestion(itemName) {
    const suggestions = {
        'OTA更新状态': '建议重启设备后重试，或清除OTA缓存',
        'Update Engine服务': '建议手动停止服务后再尝试解锁',
        '分区锁死检测': '确认符合使用条件后可执行解锁',
        '硬件可用性检测': '建议重启设备或清除相关应用缓存'
    };
    return suggestions[itemName] || '建议重启设备后重试';
}

// 获取硬件建议
function getHardwareSuggestion(hardwareName) {
    const suggestions = {
        '相机': '尝试清除相机应用缓存，或重启设备',
        '闪光灯': '尝试重启设备，或检查系统设置'
    };
    return suggestions[hardwareName] || '建议重启设备后重试';
}

// 显示警告列表
function displayWarnings() {
    const warningsSection = document.getElementById('warnings-section');
    const warningsList = document.getElementById('warnings-list');
    const warningCount = document.getElementById('warning-count');

    if (!warningsSection || !warningsList) return;

    if (AppState.warnings.length === 0) {
        warningsSection.style.display = 'none';
        return;
    }

    warningsSection.style.display = 'block';

    if (warningCount) {
        warningCount.textContent = AppState.warnings.length;
    }

    const html = AppState.warnings.map(warning => {
        const severityClass = warning.severity === 'high' ? 'high' :
                            warning.severity === 'medium' ? 'medium' : 'low';
        const severityText = warning.severity === 'high' ? '高' :
                            warning.severity === 'medium' ? '中' : '低';

        return `
            <div class="warning-item">
                <div class="warning-item-header">
                    <span class="warning-item-title">
                        ⚠️ ${escapeHtml(warning.title)}
                    </span>
                    <span class="warning-item-severity ${severityClass}">
                        ${severityText}
                    </span>
                </div>
                <div class="warning-item-description">
                    ${escapeHtml(warning.description)}
                </div>
                <div class="warning-item-suggestion">
                    💡 ${escapeHtml(warning.suggestion)}
                </div>
            </div>
        `;
    }).join('');

    warningsList.innerHTML = html;

    // 显示警告横幅
    showWarningBanner(`检测到 ${AppState.warnings.length} 个异常，建议仔细阅读后再操作`);
}

// 显示警告横幅
function showWarningBanner(message) {
    const banner = document.getElementById('warning-banner');
    const text = document.getElementById('warning-text');

    if (banner && text) {
        text.textContent = message;
        banner.style.display = 'block';
    }
}

// 隐藏警告横幅
function hideWarningBanner() {
    const banner = document.getElementById('warning-banner');
    if (banner) {
        banner.style.display = 'none';
    }
}

// ========================================
// 工具函数（复用之前的代码）
// ========================================

async function safeExec(command, options = {}) {
    try {
        const { exec } = window.kernelsu || {};
        if (!exec) {
            throw new Error('KernelSU API不可用');
        }

        const result = await exec(command, {
            cwd: options.cwd || '/data/local/tmp',
            ...options
        });

        return {
            success: result.errno === 0,
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            errno: result.errno
        };
    } catch (error) {
        console.error('Exec error:', error);
        return {
            success: false,
            stdout: '',
            stderr: error.message || String(error),
            errno: -1
        };
    }
}

function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }, duration);
}

function formatTimestamp() {
    const now = new Date();
    return now.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function addLog(message, type = 'info') {
    const timestamp = formatTimestamp();
    const logEntry = `[${timestamp}] [${type.toUpperCase()}] ${message}`;

    AppState.logs.push({
        timestamp,
        message,
        type
    });

    updateLogDisplay();
}

function updateLogDisplay() {
    const logContent = document.getElementById('log-content');
    if (!logContent) return;

    const logHtml = AppState.logs
        .map(log => {
            const typeClass = log.type === 'error' ? 'error' :
                             log.type === 'success' ? 'success' :
                             log.type === 'warning' ? 'warning' : 'info';
            return `<span class="${typeClass}">${escapeHtml(log.message)}</span>`;
        })
        .join('\n');

    logContent.innerHTML = logHtml;

    const container = document.getElementById('log-container');
    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateButtonState(buttonId, disabled, text, icon) {
    const button = document.getElementById(buttonId);
    if (!button) return;

    button.disabled = disabled;

    const iconSpan = button.querySelector('.btn-icon');
    const textSpan = button.querySelector('.btn-text');

    if (iconSpan) iconSpan.textContent = icon || '⏳';
    if (textSpan) textSpan.textContent = text || '处理中...';
}

function updateProgress(percent, text) {
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');

    if (progressFill) {
        progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    }

    if (progressText) {
        progressText.textContent = text || '';
    }
}

// ========================================
// 设备信息相关函数
// ========================================

async function loadDeviceInfo() {
    try {
        addLog('开始获取设备信息...', 'info');

        const [modelResult, versionResult, colorosResult, slotResult] = await Promise.all([
            safeExec('getprop ro.product.model'),
            safeExec('getprop ro.build.version.release'),
            safeExec('getprop ro.build.version.opporom'),
            getCurrentSlot()
        ]);

        const deviceInfo = {
            model: modelResult.success ? modelResult.stdout.trim() : '未知',
            version: versionResult.success ? versionResult.stdout.trim() : '未知',
            coloros: colorosResult.success ? colorosResult.stdout.trim() : '未检测到',
            slot: slotResult
        };

        AppState.deviceInfo = deviceInfo;
        updateDeviceInfoUI(deviceInfo);

        addLog('设备信息获取成功', 'success');

        return deviceInfo;
    } catch (error) {
        addLog(`获取设备信息失败: ${error.message}`, 'error');
        showToast('获取设备信息失败', 'error');
        return null;
    }
}

async function getCurrentSlot() {
    try {
        let result = await safeExec('cat /d/slot_info 2>/dev/null | grep -i current_slot | awk \'{print $2}\'');
        if (result.success && result.stdout.trim()) {
            return result.stdout.trim();
        }

        result = await safeExec('cat /proc/cmdline 2>/dev/null | grep -o \'androidboot.slot_suffix=[^ ]*\' | cut -d= -f2');
        if (result.success && result.stdout.trim()) {
            return result.stdout.trim();
        }

        result = await safeExec('getprop ro.boot.slot_suffix');
        if (result.success && result.stdout.trim()) {
            return result.stdout.trim();
        }

        return '未知';
    } catch (error) {
        addLog(`获取槽位信息失败: ${error.message}`, 'warning');
        return '未知';
    }
}

function updateDeviceInfoUI(info) {
    const modelEl = document.getElementById('device-model');
    const versionEl = document.getElementById('android-version');
    const colorosEl = document.getElementById('coloros-version');
    const slotEl = document.getElementById('current-slot');

    if (modelEl) modelEl.textContent = info.model;
    if (versionEl) versionEl.textContent = `Android ${info.version}`;
    if (colorosEl) colorosEl.textContent = info.coloros || '未检测到';

    if (slotEl) {
        slotEl.textContent = info.slot;
        slotEl.className = 'slot-indicator';
    }
}

async function refreshDeviceInfo() {
    const refreshIcon = document.querySelector('.refresh-icon');
    if (refreshIcon) {
        refreshIcon.classList.add('spinning');
    }

    try {
        await loadDeviceInfo();
        showToast('刷新成功', 'success');
    } catch (error) {
        showToast('刷新失败', 'error');
    } finally {
        if (refreshIcon) {
            setTimeout(() => {
                refreshIcon.classList.remove('spinning');
            }, 1000);
        }
    }
}

// ========================================
// 分区状态检测相关函数
// ========================================

async function checkPartitionStatus() {
    if (AppState.isChecking) {
        showToast('正在检测中，请稍候...', 'warning');
        return;
    }

    try {
        AppState.isChecking = true;
        updateButtonState('check-btn', true, '检测中...', '⏳');

        addLog('开始检测分区状态...', 'info');
        showToast('正在检测分区状态', 'info');

        const currentSlot = await getCurrentSlot();
        const oldSlot = currentSlot === '_a' ? '_b' : (currentSlot === '_b' ? '_a' : '');

        if (!oldSlot) {
            addLog('无法确定旧槽位', 'error');
            showToast('无法确定旧槽位', 'error');
            return;
        }

        addLog(`当前槽位: ${currentSlot}, 旧槽位: ${oldSlot}`, 'info');

        const partitions = ['boot', 'system', 'vendor', 'odm'];
        const results = [];

        for (const partition of partitions) {
            const partitionName = `${partition}${oldSlot}`;
            addLog(`检测分区: ${partitionName}`, 'info');

            const result = await detectPartitionLock(partitionName);
            results.push({
                name: partitionName,
                status: result
            });

            await new Promise(resolve => setTimeout(resolve, 500));
        }

        AppState.partitionStatus = results;
        updatePartitionListUI(results);

        const hasLocked = results.some(r => r.status === 'LOCKED');
        const statusBadge = document.getElementById('status-badge');
        const fixBtn = document.getElementById('fix-btn');

        if (hasLocked) {
            addLog('检测到分区被锁死！', 'warning');
            showToast('检测到分区被锁死', 'warning');

            if (statusBadge) {
                statusBadge.textContent = '需要解锁';
                statusBadge.className = 'status-badge danger';
            }

            if (fixBtn) {
                fixBtn.disabled = false;
            }

            // 添加到警告列表
            AppState.warnings.push({
                title: '分区锁死',
                severity: 'high',
                description: '检测到分区被锁死，需要执行解锁',
                suggestion: '点击"执行解锁"按钮进行解锁'
            });
            displayWarnings();

        } else {
            addLog('所有分区状态正常', 'success');
            showToast('分区状态正常', 'success');

            if (statusBadge) {
                statusBadge.textContent = '正常';
                statusBadge.className = 'status-badge success';
            }

            if (fixBtn) {
                fixBtn.disabled = true;
            }
        }

    } catch (error) {
        addLog(`检测失败: ${error.message}`, 'error');
        showToast('检测失败', 'error');
    } finally {
        AppState.isChecking = false;
        updateButtonState('check-btn', false, '检测分区状态', '🔍');
    }
}

async function detectPartitionLock(partitionName) {
    try {
        const partitionPath = `/dev/block/by-name/${partitionName}`;

        const existResult = await safeExec(`test -e ${partitionPath}`);
        if (!existResult.success) {
            addLog(`分区不存在: ${partitionPath}`, 'warning');
            return 'NOT_EXIST';
        }

        const pythonScript = `
import os
import sys
partition = "${partitionPath}"
try:
    fd = os.open(partition, os.O_RDWR | os.O_EXCL | os.O_NOCTTY | os.O_NOFOLLOW)
    os.close(fd)
    print("UNLOCKED")
    sys.exit(0)
except OSError as e:
    if e.errno == 16:
        print("LOCKED")
        sys.exit(1)
    elif e.errno == 13:
        print("NO_PERM")
        sys.exit(2)
    else:
        print(f"ERROR_{e.errno}")
        sys.exit(3)
except Exception as e:
    print("ERROR_UNKNOWN")
    sys.exit(4)
        `;

        const result = await safeExec(`python3 - << 'PYEOF'\n${pythonScript}\nPYEOF`);

        if (result.success) {
            const status = result.stdout.trim();
            addLog(`分区 ${partitionName} 状态: ${status}`, status === 'LOCKED' ? 'warning' : 'info');
            return status;
        } else {
            addLog(`检测分区失败: ${result.stderr}`, 'error');
            return 'ERROR';
        }
    } catch (error) {
        addLog(`检测异常: ${error.message}`, 'error');
        return 'ERROR';
    }
}

function updatePartitionListUI(results) {
    const listContainer = document.getElementById('partition-list');
    if (!listContainer) return;

    const html = results.map(partition => {
        const statusClass = partition.status === 'UNLOCKED' ? 'unlocked' :
                          partition.status === 'LOCKED' ? 'locked' : 'unknown';
        const statusText = partition.status === 'UNLOCKED' ? '✅ 未锁死' :
                          partition.status === 'LOCKED' ? '🔒 已锁死' :
                          partition.status === 'NOT_EXIST' ? '❌ 不存在' : '⚠️ 未知';

        return `
            <div class="partition-item">
                <span class="partition-name">${escapeHtml(partition.name)}</span>
                <span class="partition-status ${statusClass}">${statusText}</span>
            </div>
        `;
    }).join('');

    listContainer.innerHTML = html;
}

// ========================================
// 解锁相关函数
// ========================================

async function triggerUnlock() {
    if (AppState.isUnlocking) {
        showToast('正在解锁中，请稍候...', 'warning');
        return;
    }

    // 显示确认对话框
    showConfirmModal(
        '确认解锁',
        '确定要执行解锁操作吗？这将停止update_engine服务并清除其状态。',
        async () => {
            await performUnlock();
        }
    );
}

async function performUnlock() {
    try {
        AppState.isUnlocking = true;

        const progressSection = document.getElementById('fix-progress');
        if (progressSection) {
            progressSection.style.display = 'block';
        }

        updateButtonState('fix-btn', true, '解锁中...', '⏳');

        addLog('开始解锁流程...', 'warning');
        showToast('开始解锁，请稍候...', 'info');

        updateProgress(10, '步骤 1/4: 停止服务...');

        const stopServices = [
            'stop update_engine',
            'stop update_engine_client',
            'stop update_verifier',
            'stop ota_service'
        ];

        for (const service of stopServices) {
            addLog(`停止服务: ${service}`, 'info');
            await safeExec(service);
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        await new Promise(resolve => setTimeout(resolve, 1000));

        updateProgress(35, '步骤 2/4: 终止进程...');

        const killProcesses = [
            'killall -9 update_engine',
            'killall -9 update_engine_client',
            'killall -9 update_verifier'
        ];

        for (const process of killProcesses) {
            addLog(`终止进程: ${process}`, 'info');
            await safeExec(process);
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        await new Promise(resolve => setTimeout(resolve, 1000));

        updateProgress(60, '步骤 3/4: 清除状态...');

        const clearPaths = [
            'rm -rf /data/misc/update_engine/*',
            'rm -rf /data/misc/ce/0/update_engine/*',
            'rm -rf /data/misc/apexdata/com.android.updater/*'
        ];

        for (const path of clearPaths) {
            addLog(`清除状态: ${path}`, 'info');
            await safeExec(path);
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        await new Promise(resolve => setTimeout(resolve, 1500));

        updateProgress(85, '步骤 4/4: 验证结果...');

        await new Promise(resolve => setTimeout(resolve, 1000));

        addLog('解锁流程完成', 'success');
        updateProgress(100, '完成！');

        showToast('解锁成功！', 'success');
        addLog('✅ 解锁成功！分区已可写入', 'success');

        setTimeout(() => {
            if (progressSection) {
                progressSection.style.display = 'none';
            }
            updateProgress(0, '');
        }, 2000);

        setTimeout(async () => {
            await checkPartitionStatus();
        }, 2500);

    } catch (error) {
        addLog(`解锁失败: ${error.message}`, 'error');
        showToast('解锁失败', 'error');

        if (progressSection) {
            progressSection.style.display = 'none';
        }
    } finally {
        AppState.isUnlocking = false;
        updateButtonState('fix-btn', false, '执行解锁', '🔧');
    }
}

// ========================================
// 日志相关函数
// ========================================

async function refreshLogs() {
    try {
        const result = await safeExec('cat /data/local/tmp/ab_unlocker.log 2>/dev/null | tail -100');

        if (result.success && result.stdout) {
            const lines = result.stdout.trim().split('\n').slice(-50);
            AppState.logs = lines.map(line => {
                const type = line.includes('ERROR') ? 'error' :
                            line.includes('SUCCESS') || line.includes('✅') ? 'success' :
                            line.includes('WARNING') || line.includes('⚠️') ? 'warning' : 'info';
                return {
                    timestamp: new Date().toLocaleString(),
                    message: line,
                    type
                };
            });

            updateLogDisplay();
            showToast('日志已刷新', 'success');
        } else {
            addLog('暂无日志记录', 'info');
        }
    } catch (error) {
        addLog('刷新日志失败', 'error');
    }
}

function clearLogs() {
    showConfirmModal(
        '确认清除',
        '确定要清除所有日志吗？',
        async () => {
            try {
                await safeExec('rm -f /data/local/tmp/ab_unlocker.log');
                AppState.logs = [];
                updateLogDisplay();
                showToast('日志已清除', 'success');
            } catch (error) {
                showToast('清除日志失败', 'error');
            }
        }
    );
}

// ========================================
// Modal对话框相关函数
// ========================================

let modalCallback = null;

function showConfirmModal(title, message, callback) {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('modal-title');
    const messageEl = document.getElementById('modal-message');

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;

    if (modal) {
        modal.style.display = 'flex';
        modalCallback = callback;
    }
}

function closeModal() {
    const modal = document.getElementById('confirm-modal');
    if (modal) {
        modal.style.display = 'none';
    }
    modalCallback = null;
}

function confirmModalAction() {
    closeModal();
    if (modalCallback && typeof modalCallback === 'function') {
        modalCallback();
    }
}

// ========================================
// 其他功能函数
// ========================================

function showFullGuide() {
    const guideContent = `
详细使用指南：

【使用条件】必须同时满足以下所有条件：
1. ✅ 已完成OTA系统更新
2. ✅ 更新过程中保留了Root权限
3. ✅ 开机第一屏卡顿超过30秒
4. ✅ 进入系统后发现相机无法使用

【禁止使用的情况】
- ❌ 正常使用无异常
- ❌ 未进行OTA更新
- ❌ 开机正常，无卡顿
- ❌ 相机等外设正常工作
- ❌ 其他非A/B锁死问题

【问题症状自查】
执行以下命令确认是否为A/B锁死问题：
dd if=/dev/zero of=/dev/block/by-name/boot_b bs=1 count=1

如果返回 "Device or resource busy"，则确认是分区锁死问题

【工作原理】
本模块通过停止update_engine服务、终止相关进程、清除OTA状态文件来解除分区锁。

【注意事项】
- 仅支持ColorOS/OnePlus/Realme设备
- 解锁操作会中断OTA更新流程
- 如遇问题，请查看日志获取详情
- 误用可能导致系统异常
    `.trim();

    alert(guideContent);
}

async function exitUI() {
    try {
        const { exit } = window.kernelsu || {};
        if (exit && typeof exit === 'function') {
            exit();
        }
    } catch (error) {
        console.error('Exit error:', error);
        showToast('无法退出，请手动返回', 'warning');
    }
}

// ========================================
// 初始化
// ========================================

async function initialize() {
    try {
        addLog('A/B分区解锁器 WebUI 初始化...', 'info');

        // 初始化使用条件检查
        initializeUsageCheck();

        // 检查KernelSU API
        if (!window.kernelsu) {
            showToast('警告: KernelSU API不可用', 'warning');
            addLog('警告: KernelSU API不可用', 'warning');
        }

        addLog('初始化完成', 'success');

    } catch (error) {
        addLog(`初始化失败: ${error.message}`, 'error');
        showToast('初始化失败', 'error');
    }
}

// DOM加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    initialize();

    const modal = document.getElementById('confirm-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });
    }
});

// 错误处理
window.addEventListener('error', (event) => {
    console.error('Global error:', event.error);
    addLog(`JavaScript错误: ${event.error?.message || event.message}`, 'error');
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    addLog(`Promise错误: ${event.reason}`, 'error');
});
