// ========================================
// A/B Partition Ghost Lock Unlocker - WebUI JavaScript
// 核心逻辑和交互处理（增强版 v1.1.0）
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
    logs: [],
    selectedMode: 'auto' // 'auto' 或 'manual'
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
        showToast('已确认，请选择操作模式', 'success');

        // 显示功能区域
        showFunctionalSections();

        // 显示模式选择
        showModeSelection();

        // 初始化设备信息加载
        await loadDeviceInfo();

    } catch (error) {
        addLog(`确认失败: ${error.message}`, 'error');
        showToast('操作失败', 'error');
    }
}

// 显示功能区域
function showFunctionalSections() {
    const sections = [
        'device-info',
        'mode-selection', // 新增模式选择卡片
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

// 显示模式选择
function showModeSelection() {
    const modeSection = document.getElementById('mode-selection');
    if (modeSection) {
        modeSection.style.display = 'block';
        addLog('模式选择已显示', 'info');
    }

    // 初始化模式选择事件监听
    initializeModeSelection();
}

// 初始化模式选择
function initializeModeSelection() {
    const modeOptions = document.querySelectorAll('input[name="mode"]');
    
    modeOptions.forEach(option => {
        option.addEventListener('change', (e) => {
            AppState.selectedMode = e.target.value;
            addLog(`操作模式已切换为: ${e.target.value === 'auto' ? '自动化模式' : '手动模式'}`, 'info');
        });
    });
}

// 确认模式选择
async function confirmModeSelection() {
    try {
        const selectedMode = document.querySelector('input[name="mode"]:checked')?.value || 'auto';
        AppState.selectedMode = selectedMode;
        
        addLog(`已选择 ${selectedMode === 'auto' ? '自动化模式' : '手动模式'}`, 'success');
        showToast(`已选择 ${selectedMode === 'auto' ? '自动化模式' : '手动模式'}，开始诊断...`, 'success');

        // 在手动模式下，跳过自动诊断
        if (selectedMode === 'manual') {
            addLog('手动模式：用户将手动控制操作步骤', 'info');
            // 显示手动模式的提示
            showManualModeHint();
        } else {
            // 自动模式：开始自动诊断
            await performDiagnosis();
        }

    } catch (error) {
        addLog(`模式确认失败: ${error.message}`, 'error');
        showToast('操作失败', 'error');
    }
}

// 显示手动模式提示
function showManualModeHint() {
    showToast('手动模式已启用，请根据需要手动操作', 'info');
    
    // 启用所有手动操作按钮
    const checkBtn = document.getElementById('check-btn');
    const fixBtn = document.getElementById('fix-btn');
    
    if (checkBtn) {
        checkBtn.disabled = false;
    }
    
    if (fixBtn) {
        fixBtn.disabled = false;
    }
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

        // 在自动模式下，如果发现问题，自动启用修复按钮
        if (AppState.selectedMode === 'auto') {
            const fixBtn = document.getElementById('fix-btn');
            if (fixBtn && AppState.warnings.length > 0) {
                fixBtn.disabled = false;
                addLog('自动模式：检测到异常，已启用修复按钮', 'info');
            }
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

        // 模拟OTA状态检测
        await sleep(500);

        // 检测是否有未完成的更新
        const otaStatus = await sendRequest('/api/diagnosis/ota_status', 'GET');
        
        item.result = otaStatus;
        item.status = otaStatus.has_pending_update ? 'warning' : 'success';
        item.description = otaStatus.has_pending_update 
            ? '检测到未完成的OTA更新' 
            : 'OTA状态正常';

        return item;
    } catch (error) {
        item.status = 'error';
        item.description = 'OTA状态检测失败';
        addLog(`OTA诊断失败: ${error.message}`, 'error');
        return item;
    }
}

// 诊断UpdateEngine状态
async function diagnoseUpdateEngine() {
    const item = {
        name: 'UpdateEngine服务',
        status: 'loading',
        result: null,
        description: ''
    };

    try {
        addLog('诊断: UpdateEngine服务', 'info');

        await sleep(500);

        const ueStatus = await sendRequest('/api/diagnosis/update_engine', 'GET');
        
        item.result = ueStatus;
        
        if (ueStatus.is_running) {
            item.status = ueStatus.has_lock ? 'warning' : 'success';
            item.description = ueStatus.has_lock 
                ? 'UpdateEngine正在运行且检测到分区锁' 
                : 'UpdateEngine状态正常';
        } else {
            item.status = 'success';
            item.description = 'UpdateEngine未运行';
        }

        return item;
    } catch (error) {
        item.status = 'error';
        item.description = 'UpdateEngine检测失败';
        addLog(`UpdateEngine诊断失败: ${error.message}`, 'error');
        return item;
    }
}

// 诊断分区锁状态
async function diagnosePartitionLock() {
    const item = {
        name: '分区锁状态',
        status: 'loading',
        result: null,
        description: ''
    };

    try {
        addLog('诊断: 分区锁状态', 'info');

        await sleep(600);

        const lockStatus = await sendRequest('/api/diagnosis/partition_lock', 'GET');
        
        item.result = lockStatus;
        item.status = lockStatus.is_locked ? 'error' : 'success';
        item.description = lockStatus.is_locked 
            ? `检测到分区锁: ${lockStatus.locked_partitions.join(', ')}` 
            : '未检测到分区锁';

        return item;
    } catch (error) {
        item.status = 'error';
        item.description = '分区锁检测失败';
        addLog(`分区锁诊断失败: ${error.message}`, 'error');
        return item;
    }
}

// 诊断硬件问题
async function diagnoseHardwareIssues() {
    const item = {
        name: '硬件可用性',
        status: 'loading',
        result: null,
        description: ''
    };

    try {
        addLog('诊断: 硬件可用性', 'info');

        await sleep(400);

        const hwStatus = await sendRequest('/api/diagnosis/hardware', 'GET');
        
        item.result = hwStatus;
        
        const hasIssue = hwStatus.camera_issue || hwStatus.flash_issue;
        item.status = hasIssue ? 'warning' : 'success';
        item.description = hasIssue 
            ? `检测到硬件问题: ${[hwStatus.camera_issue && '相机', hwStatus.flash_issue && '闪光灯'].filter(Boolean).join(', ')}` 
            : '硬件状态正常';

        return item;
    } catch (error) {
        item.status = 'error';
        item.description = '硬件检测失败';
        addLog(`硬件诊断失败: ${error.message}`, 'error');
        return item;
    }
}

// 显示诊断结果
function displayDiagnosisResults(diagnoses) {
    const diagnosisList = document.getElementById('diagnosis-list');
    const diagnosisSummary = document.getElementById('diagnosis-summary');
    const summaryContent = document.getElementById('summary-content');

    if (!diagnosisList) return;

    diagnosisList.innerHTML = diagnoses.map(d => `
        <div class="diagnosis-item ${d.status}">
            <span class="diagnosis-name">${d.name}</span>
            <span class="diagnosis-status ${d.status}">
                ${d.status === 'success' ? '✅ 正常' : d.status === 'warning' ? '⚠️ 警告' : d.status === 'error' ? '❌ 错误' : '⏳ 检测中'}
            </span>
        </div>
    `).join('');

    if (diagnosisSummary && summaryContent) {
        const summary = diagnoses.map(d => `${d.name}: ${d.description}`).join('<br>');
        summaryContent.innerHTML = summary;
        diagnosisSummary.style.display = 'block';
    }

    addLog('诊断结果已显示', 'info');
}

// 生成警告
function generateWarnings(diagnoses) {
    AppState.warnings = [];

    diagnoses.forEach(d => {
        if (d.status === 'warning' || d.status === 'error') {
            AppState.warnings.push({
                title: d.name,
                description: d.description,
                severity: d.status === 'error' ? 'high' : 'medium'
            });
        }
    });

    displayWarnings();

    // 在自动模式下，如果检测到问题，自动建议修复
    if (AppState.selectedMode === 'auto' && AppState.warnings.length > 0) {
        addLog('自动模式：建议执行修复操作', 'warning');
        showToast('检测到异常，建议执行修复', 'warning');
    }
}

// 显示警告
function displayWarnings() {
    const warningsList = document.getElementById('warnings-list');
    const warningCount = document.getElementById('warning-count');
    const warningsSection = document.getElementById('warnings-section');

    if (!warningsList) return;

    if (AppState.warnings.length === 0) {
        warningsSection.style.display = 'none';
        return;
    }

    warningsSection.style.display = 'block';

    if (warningCount) {
        warningCount.textContent = AppState.warnings.length;
    }

    warningsList.innerHTML = AppState.warnings.map(w => `
        <div class="warning-item">
            <div class="warning-item-header">
                <span class="warning-item-title">
                    ⚠️ ${w.title}
                    <span class="warning-item-severity ${w.severity}">${w.severity === 'high' ? '严重' : '中等'}</span>
                </span>
            </div>
            <div class="warning-item-description">${w.description}</div>
            <div class="warning-item-suggestion">建议检查并使用模块修复功能</div>
        </div>
    `).join('');

    addLog(`已生成 ${AppState.warnings.length} 条警告`, 'warning');
}

// ========================================
// 分区状态检测相关函数
// ========================================

// 检测分区状态
async function checkPartitionStatus() {
    if (AppState.isChecking) {
        showToast('检测正在进行中...', 'warning');
        return;
    }

    try {
        AppState.isChecking = true;
        AppState.partitionStatus = [];

        const partitionList = document.getElementById('partition-list');
        const statusBadge = document.getElementById('status-badge');

        if (partitionList) {
            partitionList.innerHTML = '<div class="partition-item loading"><span>正在检测分区状态...</span></div>';
        }
        if (statusBadge) {
            statusBadge.textContent = '检测中';
            statusBadge.className = 'status-badge warning';
        }

        addLog('开始检测分区状态...', 'info');

        await sleep(800);

        const response = await sendRequest('/api/partitions', 'GET');
        
        AppState.partitionStatus = response.partitions;

        displayPartitionStatus();

        const lockedCount = AppState.partitionStatus.filter(p => p.status === 'locked').length;
        
        if (statusBadge) {
            statusBadge.textContent = lockedCount > 0 ? '存在锁' : '正常';
            statusBadge.className = lockedCount > 0 ? 'status-badge danger' : 'status-badge success';
        }

        if (lockedCount > 0) {
            addLog(`检测到 ${lockedCount} 个分区被锁定`, 'error');
            showToast(`检测到 ${lockedCount} 个分区被锁定`, 'error');

            // 在手动模式下启用修复按钮
            if (AppState.selectedMode === 'manual') {
                const fixBtn = document.getElementById('fix-btn');
                if (fixBtn) {
                    fixBtn.disabled = false;
                }
            }
        } else {
            addLog('所有分区状态正常', 'success');
            showToast('所有分区状态正常', 'success');
        }

    } catch (error) {
        addLog(`分区检测失败: ${error.message}`, 'error');
        showToast('分区检测失败', 'error');
    } finally {
        AppState.isChecking = false;
    }
}

// 显示分区状态
function displayPartitionStatus() {
    const partitionList = document.getElementById('partition-list');

    if (!partitionList) return;

    if (AppState.partitionStatus.length === 0) {
        partitionList.innerHTML = '<div class="partition-item"><span>未检测到分区</span></div>';
        return;
    }

    partitionList.innerHTML = AppState.partitionStatus.map(p => `
        <div class="partition-item">
            <span class="partition-name">${p.name}</span>
            <span class="partition-status ${p.status}">
                ${p.status === 'unlocked' ? '🔓 已解锁' : p.status === 'locked' ? '🔒 已锁定' : '❓ 未知'}
            </span>
        </div>
    `).join('');

    addLog('分区状态已显示', 'info');
}

// ========================================
// 解锁相关函数
// ========================================

// 触发解锁
async function triggerUnlock() {
    if (AppState.isUnlocking) {
        showToast('解锁正在进行中...', 'warning');
        return;
    }

    try {
        AppState.isUnlocking = true;

        const fixBtn = document.getElementById('fix-btn');
        const fixProgress = document.getElementById('fix-progress');
        const progressFill = document.getElementById('progress-fill');
        const progressText = document.getElementById('progress-text');

        if (fixBtn) fixBtn.disabled = true;
        if (fixProgress) fixProgress.style.display = 'block';

        addLog('开始执行解锁...', 'info');
        showToast('正在执行解锁，请稍候...', 'info');

        // 显示进度
        await updateProgress(progressFill, progressText, 0, '正在停止update_engine服务...');
        await sleep(800);

        await updateProgress(progressFill, progressText, 30, '正在清理状态文件...');
        await sleep(600);

        await updateProgress(progressFill, progressText, 60, '正在重启update_engine...');
        
        const response = await sendRequest('/api/unlock', 'POST');

        if (!response.success) {
            throw new Error(response.message || '解锁失败');
        }

        await updateProgress(progressFill, progressText, 100, '解锁完成！');
        await sleep(500);

        addLog('解锁成功！', 'success');
        showToast('解锁成功！', 'success');

        // 刷新分区状态
        await checkPartitionStatus();

    } catch (error) {
        addLog(`解锁失败: ${error.message}`, 'error');
        showToast(`解锁失败: ${error.message}`, 'error');
    } finally {
        AppState.isUnlocking = false;

        const fixBtn = document.getElementById('fix-btn');
        if (fixBtn) fixBtn.disabled = false;
    }
}

// 更新进度
async function updateProgress(progressFill, progressText, percent, text) {
    if (progressFill) {
        progressFill.style.width = `${percent}%`;
    }
    if (progressText) {
        progressText.textContent = text;
    }
    await sleep(100);
}

// ========================================
// 设备信息相关函数
// ========================================

// 加载设备信息
async function loadDeviceInfo() {
    try {
        addLog('正在加载设备信息...', 'info');

        const response = await sendRequest('/api/device_info', 'GET');
        
        AppState.deviceInfo = response;

        // 更新UI
        updateDeviceInfoDisplay();

        addLog('设备信息加载完成', 'success');
    } catch (error) {
        addLog(`设备信息加载失败: ${error.message}`, 'error');
    }
}

// 更新设备信息显示
function updateDeviceInfoDisplay() {
    const elements = {
        'device-model': AppState.deviceInfo.model || '未知',
        'android-version': AppState.deviceInfo.android_version || '未知',
        'coloros-version': AppState.deviceInfo.coloros_version || '未知',
        'current-slot': AppState.deviceInfo.current_slot || '未知'
    };

    Object.entries(elements).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = value;
        }
    });

    // 更新槽位指示器样式
    const slotEl = document.getElementById('current-slot');
    if (slotEl) {
        slotEl.className = 'slot-indicator';
        if (AppState.deviceInfo.current_slot === '_a') {
            slotEl.classList.add('success');
        } else if (AppState.deviceInfo.current_slot === '_b') {
            slotEl.classList.add('warning');
        }
    }
}

// 刷新设备信息
async function refreshDeviceInfo() {
    const refreshIcon = document.querySelector('.refresh-icon');
    if (refreshIcon) {
        refreshIcon.classList.add('spinning');
    }

    await loadDeviceInfo();

    setTimeout(() => {
        if (refreshIcon) {
            refreshIcon.classList.remove('spinning');
        }
    }, 1000);
}

// ========================================
// 日志相关函数
// ========================================

// 添加日志
function addLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    AppState.logs.push({ timestamp, message, type });

    const logContent = document.getElementById('log-content');
    if (logContent) {
        const logLine = `<span class="${type}">[${timestamp}] ${message}</span>`;
        logContent.innerHTML += logLine + '\n';
        logContent.scrollTop = logContent.scrollHeight;
    }

    // 同步到服务器
    sendRequest('/api/logs', 'POST', { timestamp, message, type }).catch(() => {});
}

// 刷新日志
async function refreshLogs() {
    try {
        const response = await sendRequest('/api/logs', 'GET');
        AppState.logs = response.logs || [];

        const logContent = document.getElementById('log-content');
        if (logContent) {
            logContent.innerHTML = AppState.logs.map(log => 
                `<span class="${log.type}">[${log.timestamp}] ${log.message}</span>`
            ).join('\n');
            logContent.scrollTop = logContent.scrollHeight;
        }

        addLog('日志已刷新', 'info');
    } catch (error) {
        addLog(`日志刷新失败: ${error.message}`, 'error');
    }
}

// 清除日志
function clearLogs() {
    AppState.logs = [];

    const logContent = document.getElementById('log-content');
    if (logContent) {
        logContent.innerHTML = '日志已清除';
    }

    addLog('日志已清除', 'info');
}

// ========================================
// UI辅助函数
// ========================================

// 显示Toast提示
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 3000);
}

// 显示完整指南
function showFullGuide() {
    const noticeCard = document.getElementById('important-notice');
    if (noticeCard) {
        noticeCard.style.display = 'block';
        noticeCard.scrollIntoView({ behavior: 'smooth' });
    }
}

// 退出UI
function exitUI() {
    if (confirm('确定要退出吗？')) {
        window.close();
    }
}

// ========================================
// API请求相关函数
// ========================================

// 发送API请求
async function sendRequest(endpoint, method = 'GET', data = null) {
    try {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        if (data && method !== 'GET') {
            options.body = JSON.stringify(data);
        }

        const response = await fetch(endpoint, options);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        console.error(`API请求失败: ${endpoint}`, error);
        throw error;
    }
}

// 工具函数
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========================================
// 模态框相关函数
// ========================================

let modalCallback = null;

// 显示确认对话框
function showConfirmModal(title, message, callback) {
    const modal = document.getElementById('confirm-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalMessage = document.getElementById('modal-message');

    if (modalTitle) modalTitle.textContent = title;
    if (modalMessage) modalMessage.textContent = message;

    modalCallback = callback;

    if (modal) {
        modal.style.display = 'flex';
    }
}

// 关闭对话框
function closeModal() {
    const modal = document.getElementById('confirm-modal');
    if (modal) {
        modal.style.display = 'none';
    }
    modalCallback = null;
}

// 确认对话框操作
function confirmModalAction() {
    if (modalCallback) {
        modalCallback();
    }
    closeModal();
}

// ========================================
// 初始化
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    initializeUsageCheck();
    addLog('WebUI已初始化', 'success');
    showToast('欢迎使用A/B分区解锁器', 'info');
});
