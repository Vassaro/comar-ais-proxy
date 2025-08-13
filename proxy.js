const axios = require('axios');
const WebSocket = require('ws');

// Comar AIS unit IP and URL's etc.
const AIS_HOST = '192.168.1.168';
const POLL_URL = `http://${AIS_HOST}/socket/?EIO=4&transport=polling&t=`;
const WS_BASE = `ws://${AIS_HOST}/socket/?EIO=4&transport=websocket&sid=`;
const LOCAL_PORT = 8080;
// How often should we try to reconnect after disconnect from Comar unit?
const RECONNECT_DELAY_MS = 5000;

// Verbose logging, if you need to see the whole received message received on the console.
const VERBOSE = false;

let attemptCount = 0;
let sourceWS = null;
const clients = new Set();
let wssStarted = false;

// Logging helper
function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${msg}`);
  }

// Step 1: Fetch SID via polling handshake
async function getSID() {
  const pollUrlWithTime = POLL_URL + Date.now();
  log(`📡 Attempting SID request via polling...`);
  const res = await axios.get(pollUrlWithTime, {
    headers: {
      'Accept': '*/*',
      'User-Agent': 'NodeProxy/1.0',
      'Referer': `http://${AIS_HOST}/admin/dashboard`,
    }
  });

  const data = res.data;
  if (typeof data === 'string' && data.startsWith('0{')) {
    const json = JSON.parse(data.slice(1));
    log(`✅ Received SID: ${json.sid}`);
    return json.sid;
  } else {
    throw new Error('Unexpected polling response: ' + data);
  }
}

// Step 2: Send Socket.IO connect packet
async function sendConnectPacket(sid) {
  const postUrl = `http://${AIS_HOST}/socket/?EIO=4&transport=polling&sid=${sid}`;
  await axios.post(postUrl, '40', {
    headers: {
      'Content-Type': 'text/plain',
      'User-Agent': 'NodeProxy/1.0',
    }
  });
  log('✅ Sent Socket.IO "40" connect packet');
}

// Step 3: Setup source WebSocket and handle events
function setupSourceWebSocket(sid) {
  const wsURL = WS_BASE + sid;
  log(`🔌 Connecting to Comar WebSocket: ${wsURL}`);
  sourceWS = new WebSocket(wsURL);

  sourceWS.on('open', () => {
    log(`✅ WebSocket connected to AIS unit`);
    sourceWS.send('2probe');
    log('↔️ Sent probe (2probe)');
  });

  sourceWS.on('message', (data) => handleAISMessage(data.toString()));

  sourceWS.on('close', () => {
    log(`⚠️ Source WebSocket closed. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    reconnectWithDelay();
  });

  sourceWS.on('error', (err) => {
    log(`❌ WebSocket error: ${err.message}. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    sourceWS.close();
    reconnectWithDelay();
  });
}

// Step 4: AIS message handler
function handleAISMessage(message) {
  if (VERBOSE) {
    log(`📥 AIS Raw Message: ${message}`);
  }
  if (message === '3probe') {
    sourceWS.send('5');
    log('↔️ Sent upgrade confirmation (5)');
    return;
  }

  if (message === '2') {
    sourceWS.send('3');
    return;
  }

  if (message === '6') return;

  if (message.startsWith('42')) {
    try {
      const jsonStr = message.slice(2);
      const eventData = JSON.parse(jsonStr);

      if (Array.isArray(eventData)) {
        const eventType = eventData[0];
        // Only log unexpected or important messages
        const quietEvents = ['vesselPositions-update', 'realtimeStats-counters', 'realtimeStats-vesselTypePie'];

        if (!quietEvents.includes(eventType)) {
          log(`📥 AIS Event: ${eventType}`);
        }

        if (eventType === 'vesselPositions-update' || eventType === 'vesselPositions-init') {
          for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(message);
            }
          }
        }
      }
    } catch (err) {
      log(`❌ JSON parse error: ${err.message}`);
    }
  } else {
    log(`📥 AIS Non-event Message: ${message}`);
  }
}

// Step 5: Local WebSocket proxy (start once)
function startLocalProxyServer() {
  if (wssStarted) return;

  const wss = new WebSocket.Server({ port: LOCAL_PORT }, () => {
    log(`🚀 Local WebSocket proxy running on ws://localhost:${LOCAL_PORT}`);
  });

  wss.on('connection', (client) => {
    log('🔗 Local client connected');
    clients.add(client);

    client.on('close', () => {
      clients.delete(client);
      log('🔌 Local client disconnected');
    });
  });

  wssStarted = true;
}

// Reconnection logic
function reconnectWithDelay() {
  setTimeout(() => {
    attemptCount++;
    log(`🔄 Reconnection attempt #${attemptCount}`);
    connectAndStartProxy();
  }, RECONNECT_DELAY_MS);
}

// Main connect-and-proxy function
async function connectAndStartProxy() {
  try {
    startLocalProxyServer(); // Safe to call repeatedly
    const sid = await getSID();
    await sendConnectPacket(sid);
    setupSourceWebSocket(sid);
  } catch (err) {
    log(`💥 Setup failed: ${err.message}. Retrying in ${RECONNECT_DELAY_MS / 1000}s...`);
    reconnectWithDelay();
  }
}

// Start it off
connectAndStartProxy();
