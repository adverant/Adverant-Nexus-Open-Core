# 🧪 WebSocket Architecture Simulation - BEFORE ANY CHANGES

**Date**: November 20, 2024
**Purpose**: Simulate and verify WebSocket flow will work BEFORE deployment
**Status**: ANALYSIS ONLY - NO CHANGES MADE YET

---

## 🎯 SIMULATION OBJECTIVE

Trace the complete data flow from:
1. Frontend Socket.IO client connection
2. Through Kubernetes/Istio routing
3. To MageAgent backend Socket.IO server
4. TaskManager events → WebSocket broadcasts
5. Back to frontend event handlers

**CRITICAL**: Identify any mismatches or missing pieces BEFORE deploying.

---

## 📊 CURRENT ARCHITECTURE ANALYSIS

### 1. Frontend Client (`/src/lib/mageagent-client.ts`)

**Socket.IO Client Events (Lines 918-1040)**:

#### Events Frontend LISTENS FOR:
```typescript
socket.on('agent:spawned', (data) => { ... })      // Line 1006
socket.on('agent:progress', (data) => { ... })     // Line 1018
socket.on('agent:complete', (data) => { ... })     // Line 1023
socket.on('tool:executing', (data) => { ... })     // Line 1029
socket.on('tool:complete', (data) => { ... })      // Line 1034
socket.on('task:start', (data) => { ... })         // Line 990
socket.on('task:complete', (data) => { ... })      // Line 995
socket.on('task:failed', (data) => { ... })        // Line 1000
socket.on('memory:recalled', (data) => { ... })    // Line 1040
```

#### Events Frontend EMITS:
```typescript
socket.emit('subscribe', { room: `task:${taskId}` })     // Line 925, 967
socket.emit('unsubscribe', { room: `task:${taskId}` })   // Line 1117
```

**Connection URL**: Expects `NEXT_PUBLIC_MAGEAGENT_WS_URL` env variable

---

### 2. Backend WebSocketManager (`/src/websocket/websocket-manager.ts`)

**Socket.IO Server Methods**:

#### Methods for Broadcasting:
```typescript
streamAgentOutput(agentId, message)              // Lines 198-224
  - Emits 'agent_stream' to subscribers of agentId

broadcastOrchestrationUpdate(update)             // Lines 244-252
  - Emits 'orchestration_update' to ALL clients

broadcastCompetitionResult(competitionId, results) // Lines 227-241
  - Emits 'competition_result' to ALL clients

streamSynthesisProgress(synthesisId, progress)   // Lines 255-264
  - Emits 'synthesis_progress' to ALL clients
```

#### Client Event Handlers:
```typescript
socket.on('subscribe', ...)    // Lines 90-122 - Client subscribes to agent
socket.on('unsubscribe', ...)  // Lines 124-152 - Client unsubscribes
socket.on('start_agent_task', ...) // Lines 154-173
socket.on('stop_agent', ...)   // Lines 175-195
```

---

### 3. Backend TaskManager Events (Unknown - Need to Check)

**What events does TaskManager emit?**
Based on my code changes in index.ts (lines 998-1040):
```typescript
taskManager.on('task:progress', ...)
taskManager.on('agent:started', ...)
taskManager.on('agent:completed', ...)
taskManager.on('agent:progress', ...)
```

❓ **CRITICAL QUESTION**: Does TaskManager actually emit these events?

---

## 🔍 GAP ANALYSIS - POTENTIAL MISMATCHES

### ❌ MISMATCH 1: Event Name Discrepancy

**Frontend expects**:
- `agent:spawned` (line 1006)
- `agent:complete` (line 1023)
- `tool:executing` (line 1029)
- `tool:complete` (line 1034)

**My code emits** (via `streamAgentOutput`):
- `agent_stream` (generic - not specific event names!)

**Backend method emits**:
```typescript
session.socket.emit('agent_stream', streamData);  // Line 215
```

**❌ PROBLEM**: Frontend listens for `agent:spawned`, but backend only emits `agent_stream`.

---

### ❌ MISMATCH 2: Subscription Pattern

**Frontend behavior**:
```typescript
socket.emit('subscribe', { room: `task:${taskId}` })  // Subscribes to TASK
```

**Backend WebSocketManager**:
```typescript
// Line 108: session.subscriptions.add(agentId)  // Subscribes to AGENT, not task!
```

**❌ PROBLEM**: Frontend subscribes to `task:123`, but backend only supports subscribing to `agentId`.

---

### ❌ MISMATCH 3: Event Data Structure

**Frontend expects** (line 1006):
```typescript
socket.on('agent:spawned', (data) => {
  // Expects: { agentId, name, model, status, ...}
})
```

**My code sends**:
```typescript
{
  type: 'agent_stream',
  agentId: event.agentId,
  content: `Agent ${event.agentId} started`,  // String content, not structured data!
  metadata: event,
  timestamp: new Date().toISOString()
}
```

**❌ PROBLEM**: Frontend expects structured fields, my code sends string `content`.

---

### ❓ UNKNOWN 1: TaskManager Event Existence

**Assumption**: TaskManager emits events like `task:progress`, `agent:started`, etc.

**Reality**: UNKNOWN - Need to verify TaskManager actually has these events!

**Risk**: If TaskManager doesn't emit these events, nothing will be broadcast to WebSocket.

---

### ❓ UNKNOWN 2: Socket.IO Path Configuration

**WebSocketManager constructor** (line 28):
```typescript
new SocketIOServer(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});
```

**❓ MISSING**: No `path` configuration!

**VirtualService expects**: `/mageagent/socket.io/`

**Socket.IO default path**: `/socket.io/`

**❌ PROBLEM**: VirtualService routes `/mageagent/socket.io/` but Socket.IO listens on `/socket.io/`

---

## ✅ WHAT IS CORRECT

### ✅ Socket.IO Infrastructure
- Socket.IO dependency exists (v4.7.4)
- WebSocketManager class fully implemented
- VirtualService routing configured

### ✅ Connection Handling
- WebSocketManager properly initializes Socket.IO server
- Connection/disconnection handlers exist
- CORS configured

---

## 🚨 CRITICAL FIXES NEEDED BEFORE DEPLOYMENT

### FIX 1: Configure Socket.IO Custom Path ⚠️ CRITICAL

**In WebSocketManager constructor** (line 27-36):
```typescript
// BEFORE:
this.io = new SocketIOServer(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// AFTER:
this.io = new SocketIOServer(server, {
  path: '/mageagent/socket.io',  // ← ADD THIS!
  cors: {
    origin: ["https://adverant.ai", "https://www.adverant.ai"],  // ← Tighten security
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});
```

### FIX 2: Emit Correct Event Names ⚠️ CRITICAL

**In index.ts** (lines 1006-1040):
```typescript
// BEFORE:
taskManager.on('agent:started', (event: any) => {
  wsManager.streamAgentOutput(event.agentId, {
    type: 'agent_stream',  // ← Wrong event type
    agentId: event.agentId,
    content: `Agent ${event.agentId} started`,
    ...
  });
});

// AFTER - Option A: Emit directly with correct event name
taskManager.on('agent:started', (event: any) => {
  wsManager.io.emit('agent:spawned', {  // ← Correct event name!
    agentId: event.agentId,
    name: event.name,
    model: event.model,
    status: 'spawned',
    ...event
  });
});

// AFTER - Option B: Add new method to WebSocketManager
// Add to WebSocketManager class:
async emitAgentSpawned(data: any): Promise<void> {
  this.io.emit('agent:spawned', {
    agentId: data.agentId,
    name: data.name,
    model: data.model,
    status: 'spawned',
    timestamp: new Date().toISOString(),
    ...data
  });
}
```

### FIX 3: Verify TaskManager Events Exist ⚠️ CRITICAL

**BEFORE deploying, must check**:
```bash
# Search TaskManager for event emissions
grep -n "emit.*agent:started\|emit.*task:progress" src/orchestration/task-manager.ts
```

**If events don't exist**, we need to:
1. Find where orchestration actually happens
2. Hook into correct event emitters
3. OR add event emissions to TaskManager

### FIX 4: Handle Task-Based Subscriptions (Optional)

Frontend subscribes to `task:${taskId}`, but WebSocketManager only supports agent subscriptions.

**Options**:
A. **Add task subscription support to WebSocketManager**
B. **Broadcast to all clients** (simpler, works for single-user scenario)
C. **Ignore** - if using broadcast methods, subscriptions don't matter

---

## 🎯 RECOMMENDED APPROACH

### Phase 1: Minimal Working Solution

1. **Add custom Socket.IO path** in WebSocketManager constructor
2. **Emit directly with correct event names** (bypass WebSocketManager methods)
3. **Use broadcast to all clients** (io.emit) - simpler, no subscription logic needed
4. **Verify TaskManager events exist** - if not, find correct event source

### Phase 2: Verify Before Building

1. Check TaskManager actually emits events we're listening for
2. Check event data structure matches frontend expectations
3. Test Socket.IO path routing with curl

### Phase 3: Deploy and Test

1. Deploy backend with fixes
2. Update frontend WebSocket URL
3. Test connection in browser console
4. Verify events arriving at frontend

---

## 📋 PRE-DEPLOYMENT CHECKLIST

Before making ANY changes:

- [ ] Verify TaskManager event names (`grep` TaskManager source)
- [ ] Verify TaskManager event data structure
- [ ] Check if orchestrator emits events (alternative to TaskManager)
- [ ] Confirm VirtualService path matches Socket.IO path
- [ ] Verify frontend event handler expectations
- [ ] Map ALL frontend events to backend emissions
- [ ] Test Socket.IO custom path configuration

---

## 🚦 SIMULATION VERDICT

**🔴 CURRENT STATUS**: **WILL NOT WORK AS-IS**

**Critical Issues**:
1. ❌ Socket.IO path mismatch (`/socket.io/` vs `/mageagent/socket.io/`)
2. ❌ Event name mismatch (`agent_stream` vs `agent:spawned`)
3. ❌ Event data structure mismatch (string vs structured)
4. ❓ TaskManager events may not exist

**Recommendation**: **STOP - DO NOT DEPLOY YET**

**Next Steps**:
1. Investigate TaskManager source code
2. Fix Socket.IO path configuration
3. Fix event naming and data structure
4. Re-simulate with fixes
5. Then deploy

---

**Status**: Simulation complete - Critical issues identified
**Action**: HOLD deployment until fixes applied
