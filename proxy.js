const axios = require('axios');
const WebSocket = require('ws');

// Comar AIS unit IP and URL's etc.
const AIS_HOST = '192.168.1.168';


const POLL_URL = `http://${AIS_HOST}/socket/?EIO=4&transport=polling&t=${Date.now()}`;
const WS_BASE = `ws://${AIS_HOST}/socket/?EIO=4&transport=websocket&sid=`;
const LOCAL_PORT = 8080;

// Step 1: Fetch SID via polling handshake
async function getSID() {
  console.log('📡 Requesting SID via polling...');
  const res = await axios.get(POLL_URL, {
    headers: {
      'Accept': '*/*',
      'User-Agent': 'NodeProxy/1.0',
      'Referer': `http://${AIS_HOST}/admin/dashboard`,
    }
  });

  const data = res.data;

  if (typeof data === 'string' && data.startsWith('0{')) {
    const json = JSON.parse(data.slice(1));
    const sid = json.sid;
    console.log(`✅ Got SID: ${sid}`);
    return sid;
  } else {
    throw new Error('Unexpected response from polling: ' + data);
  }
}

// Step 2: Inject the required "40" message before WS upgrade
async function sendConnectPacket(sid) {
  const postUrl = `http://${AIS_HOST}/socket/?EIO=4&transport=polling&sid=${sid}`;

  await axios.post(postUrl, '40', {
    headers: {
      'Content-Type': 'text/plain',
      'User-Agent': 'NodeProxy/1.0',
    }
  });

  console.log('✅ Sent Socket.IO "40" connect packet');
}

// Step 3: Connect to Comar WebSocket with SID
function connectToAISWebSocket(sid) {
  const wsURL = WS_BASE + sid;
  console.log(`🔌 Connecting to Comar WebSocket: ${wsURL}`);
  const sourceWS = new WebSocket(wsURL);

  sourceWS.on('open', () => {
    console.log('✅ WebSocket connected to Comar AIS unit');
    // Step4, initiate the 3-way-handshake required: send 2probe
    sourceWS.send('2probe');
    console.debug('↔️ Sent probe (2probe)');
  });

  sourceWS.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });

  sourceWS.on('close', () => {
    console.warn('⚠️ WebSocket closed by Comar AIS unit');
  });

  return sourceWS;
}

// Step 5: Create local WebSocket proxy server
function startLocalProxy(sourceWS) {
  const clients = new Set();

  const wss = new WebSocket.Server({ port: LOCAL_PORT }, () => {
    console.log(`🚀 Local WebSocket proxy running on ws://localhost:${LOCAL_PORT}`);
  });

  wss.on('connection', (client) => {
    console.log('🔗 Local client connected');
    clients.add(client);

    client.on('close', () => {
      clients.delete(client);
      console.log('🔌 Local client disconnected');
    });
  });

  sourceWS.on('message', (data) => {
    const message = data.toString();

    // Handle Socket.IO upgrade messages and ping-pong
    if (message === '3probe') {
      sourceWS.send('5');
      console.debug('↔️ Sent upgrade confirmation (5)');
      return;
    }

    if (message === '2') {
      sourceWS.send('3');
      console.debug('↔️ Responded with pong (3)');
      return;
    }
    
    if (message === '6') {
      console.debug('↔️ Received noop (6)');
      // No reply needed; just ignore or log for debugging
      return;
    }

    if (message.startsWith('42')) {
      try {
        const jsonStr = message.slice(2);
        const eventData = JSON.parse(jsonStr);

        if (Array.isArray(eventData)) {
          const eventType = eventData[0];

          const ignoredEvents = ['realtimeStats-counters', 'realtimeStats-vesselTypePie'];

          if (!ignoredEvents.includes(eventType)) {
            console.log(`📥 AIS Message: ${message}`);
          }

          // Forward vesselPositions-update and vesselPositions-init only
          if (eventType === 'vesselPositions-update' || eventType === 'vesselPositions-init') {
            for (const client of clients) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(message);
              }
            }
          }
        }
      } catch (err) {
        console.error('❌ Failed to parse Socket.IO event JSON:', err);
      }
    } else {
      // Log all non-42 messages but do NOT forward to clients
      console.log(`📥 AIS Non-event Message: ${message}`);
    }
  });
}

// Main runner
(async () => {
  try {
    const sid = await getSID();
    await sendConnectPacket(sid);
    const sourceWS = connectToAISWebSocket(sid);
    startLocalProxy(sourceWS);
  } catch (err) {
    console.error('💥 Fatal error:', err.message);
  }
})();
