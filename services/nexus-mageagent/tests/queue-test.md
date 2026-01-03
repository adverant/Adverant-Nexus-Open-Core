# Task Queue System Testing Guide

## Overview
This document provides testing instructions for the MageAgent Task Queue implementation.

## API Endpoints

### 1. Queue Management Endpoints

#### Get Queue List
```bash
GET /api/queue/list
```

Returns all tasks in the queue with metrics:
- Queue positions for each task
- Estimated wait times
- Overall queue metrics (total queued, processing, average time)

#### Get Task Queue Status
```bash
GET /api/queue/status/:taskId
```

Returns queue position and wait time for a specific task:
- Queue position (0-indexed, 0 = next to process)
- Estimated wait time in milliseconds
- Task status (queued, processing, completed)

#### Cancel Queued Task
```bash
DELETE /api/queue/cancel/:taskId
```

Cancels a task if it's still in the queue:
- Cannot cancel tasks that are already processing
- Cannot cancel completed tasks
- Updates queue positions for remaining tasks

### 2. Task Submission (Existing)

```bash
POST /api/orchestrate
{
  "task": "Your task description",
  "async": true,
  "options": {
    "timeout": 120000,
    "priority": 0
  }
}
```

Returns:
```json
{
  "taskId": "task_123",
  "statusUrl": "/api/tasks/task_123",
  "message": "Task created successfully"
}
```

## Testing Scenarios

### Test 1: Submit Multiple Tasks and Check Queue

```bash
# Submit Task 1
curl -X POST http://localhost:8080/api/orchestrate \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Analyze the Python ecosystem",
    "async": true
  }'

# Submit Task 2
curl -X POST http://localhost:8080/api/orchestrate \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Research JavaScript frameworks",
    "async": true
  }'

# Submit Task 3
curl -X POST http://localhost:8080/api/orchestrate \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Compare database technologies",
    "async": true
  }'

# Check queue list
curl http://localhost:8080/api/queue/list

# Expected response structure:
{
  "success": true,
  "data": {
    "queue": [
      {
        "taskId": "task_1",
        "status": "processing",
        "queuePosition": null,
        "submittedAt": "2025-01-10T12:00:00Z",
        "startedAt": "2025-01-10T12:00:01Z",
        "estimatedWaitTime": null,
        "type": "orchestrate"
      },
      {
        "taskId": "task_2",
        "status": "pending",
        "queuePosition": 0,
        "submittedAt": "2025-01-10T12:00:02Z",
        "estimatedWaitTime": 45000,
        "type": "orchestrate"
      },
      {
        "taskId": "task_3",
        "status": "pending",
        "queuePosition": 1,
        "submittedAt": "2025-01-10T12:00:03Z",
        "estimatedWaitTime": 90000,
        "type": "orchestrate"
      }
    ],
    "metrics": {
      "totalQueued": 2,
      "totalProcessing": 1,
      "averageProcessingTime": 45000
    }
  }
}
```

### Test 2: Check Individual Task Queue Status

```bash
# Check status of task_2
curl http://localhost:8080/api/queue/status/task_2

# Expected response:
{
  "success": true,
  "data": {
    "taskId": "task_2",
    "status": "pending",
    "queuePosition": 0,
    "estimatedWaitTime": 45000,
    "isQueued": true,
    "isProcessing": false,
    "isCompleted": false,
    "progress": 0,
    "createdAt": "2025-01-10T12:00:02Z"
  }
}
```

### Test 3: Cancel a Queued Task

```bash
# Cancel task_3
curl -X DELETE http://localhost:8080/api/queue/cancel/task_3

# Expected response:
{
  "success": true,
  "data": {
    "taskId": "task_3",
    "cancelled": true,
    "message": "Task successfully cancelled and removed from queue"
  }
}

# Verify queue updated
curl http://localhost:8080/api/queue/list
# Should show task_3 removed and queue positions updated
```

### Test 4: WebSocket Real-time Updates

Connect to WebSocket at `ws://graphrag:8090/graphrag` and subscribe to queue events:

```javascript
const ws = new WebSocket('ws://graphrag:8090/graphrag');

ws.on('open', () => {
  // Subscribe to specific task
  ws.send(JSON.stringify({
    type: 'subscribe',
    channel: 'queue:task_123'
  }));

  // Or subscribe to all queue events
  ws.send(JSON.stringify({
    type: 'subscribe',
    channel: 'queue:*'
  }));
});

ws.on('message', (data) => {
  const event = JSON.parse(data);
  console.log('Queue event:', event);
  // Events:
  // - queue:position-update - Position changed
  // - queue:started - Task started processing
});
```

### Test 5: Stress Test with Concurrent Submissions

```bash
# Submit 10 tasks concurrently
for i in {1..10}; do
  curl -X POST http://localhost:8080/api/orchestrate \
    -H "Content-Type: application/json" \
    -d "{
      \"task\": \"Task number $i\",
      \"async\": true
    }" &
done

# Wait for submissions to complete
wait

# Check queue state
curl http://localhost:8080/api/queue/list
```

## Expected Behaviors

### Queue Processing Order (FIFO)
1. Tasks are processed in the order they were submitted
2. Queue position 0 means "next to process"
3. When a task completes, all waiting tasks move up one position

### Position Updates
1. When a task completes, all waiting tasks receive position update events
2. WebSocket subscribers get real-time notifications
3. Queue positions are recalculated automatically

### Wait Time Estimation
1. Based on average of last 100 completed tasks
2. Default: 45 seconds if no history
3. Formula: `position * averageProcessingTime`

### Task Cancellation
1. Can only cancel tasks with status "pending" or "waiting"
2. Cannot cancel "active", "processing", "completed", or "failed" tasks
3. Cancellation triggers position updates for remaining tasks

## Error Cases to Test

### 1. Cancel Non-existent Task
```bash
curl -X DELETE http://localhost:8080/api/queue/cancel/invalid_task_id
# Expected: 404 Not Found
```

### 2. Cancel Processing Task
```bash
# Try to cancel a task that's currently processing
curl -X DELETE http://localhost:8080/api/queue/cancel/processing_task_id
# Expected: 400 Bad Request - "Cannot cancel processing task"
```

### 3. Cancel Completed Task
```bash
# Try to cancel an already completed task
curl -X DELETE http://localhost:8080/api/queue/cancel/completed_task_id
# Expected: 400 Bad Request - "Cannot cancel completed task"
```

## Integration Points

### Frontend Integration
1. After task submission, poll `/queue/status/:taskId` for position updates
2. Display queue position and estimated wait time to users
3. Subscribe to WebSocket for real-time updates
4. Allow users to cancel queued tasks

### Backend Integration
1. TaskManager handles all queue operations
2. BullMQ manages Redis-based queue
3. GraphRAG forwards WebSocket events
4. Orchestrator processes tasks sequentially

## Monitoring and Metrics

### Key Metrics to Track
- Average queue length
- Average wait time
- Task processing time
- Queue position accuracy
- Cancellation rate
- WebSocket event delivery rate

### Redis Queue Monitoring
```bash
# Check Redis queue status
redis-cli -h redis
> KEYS bull:*
> LLEN bull:mageagent-queue:wait
> LLEN bull:mageagent-queue:active
> LLEN bull:mageagent-queue:completed
```

## Performance Considerations

1. **Queue Scalability**: BullMQ can handle thousands of queued tasks
2. **Position Updates**: O(n) complexity for n waiting tasks
3. **WebSocket Events**: Batched for efficiency
4. **Redis Memory**: Monitor memory usage with large queues
5. **Processing Timeout**: Default 10 minutes, configurable per task

## Troubleshooting

### Task Stuck in Queue
1. Check if worker is running: `docker logs mageagent`
2. Check Redis connectivity: `redis-cli ping`
3. Check for deadlocked tasks in BullMQ
4. Restart worker if necessary

### WebSocket Events Not Received
1. Verify GraphRAG WebSocket server is running
2. Check network connectivity to port 8090
3. Verify subscription channel format
4. Check GraphRAG logs for errors

### Incorrect Queue Positions
1. Check for race conditions in concurrent updates
2. Verify Redis atomic operations
3. Check TaskManager event handling
4. Review position calculation logic

## Success Criteria

✅ Tasks process in FIFO order
✅ Queue positions update correctly
✅ Wait time estimates are reasonable
✅ Cancellation works for queued tasks only
✅ WebSocket events deliver in real-time
✅ System handles 100+ concurrent submissions
✅ No memory leaks with long-running queues
✅ Graceful degradation when Redis unavailable