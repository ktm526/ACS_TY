const TaskExecutionLog = require('../models/TaskExecutionLog');

// 로그 기록 헬퍼 함수
async function logTaskExecution(data) {
    try {
        const log = await TaskExecutionLog.create(data);
        console.log(`[TASK_LOG] ${data.event_type}: ${data.robot_name} - ${data.details ? JSON.parse(data.details).description || '' : ''}`);
        return log;
    } catch (error) {
        console.error('[TASK_LOG] 로그 기록 오류:', error.message);
        return null;
    }
}

// 버튼 눌림 로그
async function logButtonPressed(robotName, buttonType, location, toLocation = null) {
    return await logTaskExecution({
        robot_name: robotName,
        event_type: 'BUTTON_PRESSED',
        from_location: location,
        to_location: toLocation,
        details: JSON.stringify({
            description: `${buttonType} 버튼 눌림`,
            button_type: buttonType,
            location: location,
            destination: toLocation
        })
    });
}

// 태스크 할당 로그
async function logTaskAssigned(taskId, robotId, robotName, fromLocation, toLocation) {
    return await logTaskExecution({
        task_id: taskId,
        robot_id: robotId,
        robot_name: robotName,
        event_type: 'TASK_ASSIGNED',
        from_location: fromLocation,
        to_location: toLocation,
        details: JSON.stringify({
            description: `태스크 할당됨: ${fromLocation} → ${toLocation}`,
            from: fromLocation,
            to: toLocation
        })
    });
}

// 태스크 시작 로그
async function logTaskStarted(taskId, robotId, robotName) {
    return await logTaskExecution({
        task_id: taskId,
        robot_id: robotId,
        robot_name: robotName,
        event_type: 'TASK_STARTED',
        details: JSON.stringify({
            description: '태스크 실행 시작'
        })
    });
}

// 스텝 시작 로그
async function logStepStarted(taskId, robotId, robotName, stepSeq, stepType, payload, fromLocation = null, toLocation = null) {
    const logData = {
        task_id: taskId,
        robot_id: robotId,
        robot_name: robotName,
        event_type: 'STEP_STARTED',
        step_seq: stepSeq,
        step_type: stepType,
        details: JSON.stringify({
            description: `스텝 ${stepSeq} 시작: ${stepType}`,
            payload: payload,
            from_location: fromLocation,
            to_location: toLocation
        })
    };

    // NAV/NAV_PRE 스텝인 경우 from_location, to_location 필드에도 저장
    if ((stepType === 'NAV' || stepType === 'NAV_PRE') && fromLocation && toLocation) {
        logData.from_location = fromLocation;
        logData.to_location = toLocation;
    }

    return await logTaskExecution(logData);
}

// 스텝 완료 로그
async function logStepCompleted(taskId, robotId, robotName, stepSeq, stepType, startTime, endTime) {
    const duration = endTime ? (endTime.getTime() - startTime.getTime()) : null;
    
    return await logTaskExecution({
        task_id: taskId,
        robot_id: robotId,
        robot_name: robotName,
        event_type: 'STEP_COMPLETED',
        step_seq: stepSeq,
        step_type: stepType,
        duration_ms: duration,
        details: JSON.stringify({
            description: `스텝 ${stepSeq} 완료: ${stepType}`,
            start_time: startTime,
            end_time: endTime,
            duration_ms: duration
        })
    });
}

// 스텝 실패 로그
async function logStepFailed(taskId, robotId, robotName, stepSeq, stepType, errorMessage, startTime, endTime) {
    const duration = endTime ? (endTime.getTime() - startTime.getTime()) : null;
    
    return await logTaskExecution({
        task_id: taskId,
        robot_id: robotId,
        robot_name: robotName,
        event_type: 'STEP_FAILED',
        step_seq: stepSeq,
        step_type: stepType,
        duration_ms: duration,
        error_message: errorMessage,
        details: JSON.stringify({
            description: `스텝 ${stepSeq} 실패: ${stepType}`,
            error: errorMessage,
            start_time: startTime,
            end_time: endTime,
            duration_ms: duration
        })
    });
}

// 태스크 일시정지 로그
async function logTaskPaused(taskId, robotId, robotName, reason) {
    return await logTaskExecution({
        task_id: taskId,
        robot_id: robotId,
        robot_name: robotName,
        event_type: 'TASK_PAUSED',
        details: JSON.stringify({
            description: `태스크 일시정지: ${reason}`,
            reason: reason
        })
    });
}

// 태스크 재개 로그
async function logTaskResumed(taskId, robotId, robotName, method) {
    return await logTaskExecution({
        task_id: taskId,
        robot_id: robotId,
        robot_name: robotName,
        event_type: 'TASK_RESUMED',
        details: JSON.stringify({
            description: `태스크 재개: ${method}`,
            resume_method: method
        })
    });
}

// 태스크 취소 로그
async function logTaskCanceled(taskId, robotId, robotName, reason) {
    return await logTaskExecution({
        task_id: taskId,
        robot_id: robotId,
        robot_name: robotName,
        event_type: 'TASK_CANCELED',
        details: JSON.stringify({
            description: `태스크 취소: ${reason}`,
            reason: reason
        })
    });
}

// 태스크 완료 로그
async function logTaskCompleted(taskId, robotId, robotName, startTime, endTime) {
    const duration = endTime ? (endTime.getTime() - startTime.getTime()) : null;
    
    return await logTaskExecution({
        task_id: taskId,
        robot_id: robotId,
        robot_name: robotName,
        event_type: 'TASK_COMPLETED',
        duration_ms: duration,
        details: JSON.stringify({
            description: '태스크 완료',
            start_time: startTime,
            end_time: endTime,
            duration_ms: duration
        })
    });
}

// 태스크 실패 로그
async function logTaskFailed(taskId, robotId, robotName, errorMessage, startTime, endTime) {
    const duration = endTime ? (endTime.getTime() - startTime.getTime()) : null;
    
    return await logTaskExecution({
        task_id: taskId,
        robot_id: robotId,
        robot_name: robotName,
        event_type: 'TASK_FAILED',
        duration_ms: duration,
        error_message: errorMessage,
        details: JSON.stringify({
            description: `태스크 실패: ${errorMessage}`,
            error: errorMessage,
            start_time: startTime,
            end_time: endTime,
            duration_ms: duration
        })
    });
}

module.exports = {
    logTaskExecution,
    logButtonPressed,
    logTaskAssigned,
    logTaskStarted,
    logStepStarted,
    logStepCompleted,
    logStepFailed,
    logTaskPaused,
    logTaskResumed,
    logTaskCanceled,
    logTaskCompleted,
    logTaskFailed
}; 