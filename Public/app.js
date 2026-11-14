'use strict';

/**
 * ZEROCHAT — Client Application (Improved)
 * - Better reconnect & visibility handling (gallery open no longer kills chat easily)
 * - Multiple file/image/video selection
 * - Smoother connection status
 * - Quick reconnect button
 */

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const CHUNK_SIZE = 16 * 1024; // 16 KB chunks
const WS_PING_INTERVAL = 12000;
const RECONNECT_DELAY_MS = 800;
const MAX_AUTO_RECONNECT = 8;

// UI Elements
const screens = {
  welcome: document.getElementById('screen-welcome'),
  create: document.getElementById('screen-create'),
  join: document.getElementById('screen-join'),
  waiting: document.getElementById('screen-waiting'),
  chat: document.getElementById('screen-chat'),
  error: document.getElementById('screen-error')
};

const els = {
  btnCreate: document.getElementById('btn-create'),
  btnJoinShow: document.getElementById('btn-join-show'),
  createLoader: document.getElementById('create-loader'),
  createResult: document.getElementById('create-result'),
  createError: document.getElementById('create-error'),
  createdRoomId: document.getElementById('created-room-id'),
  btnCopyId: document.getElementById('btn-copy-id'),
  btnEnterCreated: document.getElementById('btn-enter-created'),
  joinForm: document.getElementById('join-form'),
  joinRoomId: document.getElementById('join-room-id'),
  joinError: document.getElementById('join-error'),
  waitingRoomId: document.getElementById('waiting-room-id'),
  waitingStatus: document.getElementById('waiting-status'),
  btnLeaveWaiting: document.getElementById('btn-leave-waiting'),
  messages: document.getElementById('messages'),
  messageInput: document.getElementById('message-input'),
  btnSend: document.getElementById('btn-send'),
  btnAttach: document.getElementById('btn-attach'),
  fileInput: document.getElementById('file-input'),
  fileProgress: document.getElementById('file-progress'),
  progressFill: document.getElementById('progress-fill'),
  progressText: document.getElementById('progress-text'),
  connStatus: document.getElementById('conn-status'),
  connText: document.getElementById('conn-text'),
  btnLeaveChat: document.getElementById('btn-leave-chat'),
  btnReconnect: document.getElementById('btn-reconnect'),
  btnToggleTheme: document.getElementById('btn-toggle-theme'),
  btnShowSafety: document.getElementById('btn-show-safety'),
  safetyModal: document.getElementById('safety-modal'),
  safetyCode: document.getElementById('safety-code'),
  btnCloseSafety: document.getElementById('btn-close-safety'),
  errorTitle: document.getElementById('error-title'),
  errorMessage: document.getElementById('error-message'),
  btnErrorHome: document.getElementById('btn-error-home')
};

// State
let state = {
  roomId: null,
  participantId: null,
  isInitiator: false,
  ws: null,
  pc: null,
  dataChannel: null,
  safetyCode: null,
  reconnectAttempts: 0,
  intentionalLeave: false,
  isSelectingFile: false,      // gallery open protection
  lastStatus: null,
  wsPingTimer: null,
  statusDebounceTimer: null,
  fileQueue: [],               // multiple files
  isSendingFile: false
};

// ICE servers
function getIceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];

  if (window.ZEROCHAT_TURN) {
    servers.push({
      urls: window.ZEROCHAT_TURN.url,
      username: window.ZEROCHAT_TURN.username,
      credential: window.ZEROCHAT_TURN.credential
    });
  }

  return { iceServers: servers, iceCandidatePoolSize: 10 };
}

// ---------- Screen Management ----------
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  if (screens[name]) screens[name].classList.add('active');
}

function showError(title, message) {
  els.errorTitle.textContent = title;
  els.errorMessage.textContent = message;
  showScreen('error');
}

// ---------- Theme ----------
function initTheme() {
  const saved = localStorage.getItem('zerochat-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
}

els.btnToggleTheme.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('zerochat-theme', next);
});

// ---------- Navigation ----------
document.querySelectorAll('[data-back]').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-back');
    if (target === 'welcome') cleanupAndHome();
  });
});

els.btnCreate.addEventListener('click', createRoom);
els.btnJoinShow.addEventListener('click', () => {
  els.joinError.classList.add('hidden');
  els.joinRoomId.value = '';
  showScreen('join');
});

els.btnEnterCreated.addEventListener('click', () => {
  if (state.roomId) enterRoom(state.roomId);
});

els.btnLeaveWaiting.addEventListener('click', () => {
  state.intentionalLeave = true;
  cleanupAndHome();
});

els.btnLeaveChat.addEventListener('click', () => {
  state.intentionalLeave = true;
  cleanupAndHome();
});

els.btnErrorHome.addEventListener('click', cleanupAndHome);

els.btnCopyId.addEventListener('click', async () => {
  const id = els.createdRoomId.textContent;
  try {
    await navigator.clipboard.writeText(id);
    els.btnCopyId.textContent = 'কপি হয়েছে!';
    setTimeout(() => { els.btnCopyId.textContent = 'কপি'; }, 1500);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = id;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    els.btnCopyId.textContent = 'কপি হয়েছে!';
    setTimeout(() => { els.btnCopyId.textContent = 'কপি'; }, 1500);
  }
});

els.btnShowSafety.addEventListener('click', () => {
  els.safetyCode.textContent = state.safetyCode || '----';
  els.safetyModal.classList.remove('hidden');
});

els.btnCloseSafety.addEventListener('click', () => {
  els.safetyModal.classList.add('hidden');
});

// Reconnect button
els.btnReconnect.addEventListener('click', () => {
  if (!state.roomId) return;
  els.btnReconnect.classList.add('hidden');
  addSystemMessage('পুনরায় সংযোগের চেষ্টা করা হচ্ছে...');
  quickReconnect();
});

// ---------- Room Creation ----------
async function createRoom() {
  showScreen('create');
  els.createLoader.classList.remove('hidden');
  els.createResult.classList.add('hidden');
  els.createError.classList.add('hidden');

  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'রুম তৈরি ব্যর্থ');

    state.roomId = data.roomId;
    els.createdRoomId.textContent = data.roomId;
    els.createLoader.classList.add('hidden');
    els.createResult.classList.remove('hidden');
  } catch (err) {
    els.createLoader.classList.add('hidden');
    els.createError.textContent = err.message || 'নেটওয়ার্ক ত্রুটি';
    els.createError.classList.remove('hidden');
  }
}

// ---------- Join ----------
els.joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const roomId = els.joinRoomId.value.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(roomId)) {
    els.joinError.textContent = 'রুম আইডি অবশ্যই ৩২ অক্ষরের হেক্স হতে হবে';
    els.joinError.classList.remove('hidden');
    return;
  }

  els.joinError.classList.add('hidden');
  try {
    const res = await fetch(`/api/rooms/${roomId}`);
    if (res.status === 404) {
      els.joinError.textContent = 'রুম পাওয়া যায়নি বা মেয়াদ শেষ';
      els.joinError.classList.remove('hidden');
      return;
    }
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.error || 'ত্রুটি');
    }
    const info = await res.json();
    if (info.participantCount >= 2) {
      els.joinError.textContent = 'রুম পূর্ণ। সর্বোচ্চ ২ জন।';
      els.joinError.classList.remove('hidden');
      return;
    }
  } catch (err) {
    els.joinError.textContent = err.message || 'নেটওয়ার্ক ত্রুটি';
    els.joinError.classList.remove('hidden');
    return;
  }

  enterRoom(roomId);
});

// ---------- Enter Room & Signaling ----------
function enterRoom(roomId) {
  state.roomId = roomId;
  state.intentionalLeave = false;
  state.reconnectAttempts = 0;
  els.waitingRoomId.textContent = roomId;
  showScreen('waiting');
  connectWebSocket();
}

function getWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function clearWsPing() {
  if (state.wsPingTimer) {
    clearInterval(state.wsPingTimer);
    state.wsPingTimer = null;
  }
}

function startWsPing() {
  clearWsPing();
  state.wsPingTimer = setInterval(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(JSON.stringify({ type: 'ping' }));
      } catch (_) {}
    }
  }, WS_PING_INTERVAL);
}

function connectWebSocket() {
  if (state.ws) {
    try {
      state.ws.onclose = null;
      state.ws.onerror = null;
      state.ws.close();
    } catch (_) {}
  }

  const ws = new WebSocket(getWsUrl());
  state.ws = ws;

  ws.onopen = () => {
    state.reconnectAttempts = 0;
    startWsPing();
    ws.send(JSON.stringify({ type: 'join', roomId: state.roomId }));
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleSignalingMessage(msg);
  };

  ws.onclose = () => {
    clearWsPing();
    if (state.intentionalLeave) return;

    // If user is selecting file from gallery, don't panic immediately
    if (state.isSelectingFile) {
      setTimeout(() => {
        if (!state.intentionalLeave && state.roomId) {
          attemptAutoReconnect();
        }
      }, 1500);
      return;
    }

    // Soft reconnect
    attemptAutoReconnect();
  };

  ws.onerror = () => {
    // close handler will fire
  };
}

function attemptAutoReconnect() {
  if (state.intentionalLeave || !state.roomId) return;
  if (state.reconnectAttempts >= MAX_AUTO_RECONNECT) {
    setConnectionStatus('offline', 'সংযোগ বিচ্ছিন্ন');
    showReconnectButton(true);
    addSystemMessage('অটো রি-কানেক্ট ব্যর্থ। "পুনঃসংযোগ" বাটনে চাপুন।');
    return;
  }

  state.reconnectAttempts++;
  setConnectionStatus('connecting', `পুনঃসংযোগ হচ্ছে... (${state.reconnectAttempts})`);
  showReconnectButton(false);

  setTimeout(() => {
    if (state.intentionalLeave) return;
    connectWebSocket();
  }, RECONNECT_DELAY_MS);
}

function quickReconnect() {
  // Full clean of peer connection then rejoin
  if (state.pc) {
    try { state.pc.close(); } catch (_) {}
    state.pc = null;
  }
  if (state.dataChannel) {
    try { state.dataChannel.close(); } catch (_) {}
    state.dataChannel = null;
  }
  state.reconnectAttempts = 0;
  state.isInitiator = false;
  connectWebSocket();
}

function handleSignalingMessage(msg) {
  switch (msg.type) {
    case 'joined':
      state.participantId = msg.participantId;
      state.isInitiator = msg.isInitiator;
      updateWaitingStatus(msg.participantCount);
      if (msg.participantCount === 2) {
        // Small delay helps when both reconnect at same time
        setTimeout(() => startWebRTC(), 300);
      }
      break;

    case 'peer-joined':
      updateWaitingStatus(msg.participantCount);
      if (msg.participantCount === 2) {
        setTimeout(() => startWebRTC(), 300);
      }
      break;

    case 'peer-left':
      if (screens.chat.classList.contains('active')) {
        addSystemMessage('অন্য পক্ষ সাময়িকভাবে বিচ্ছিন্ন হয়েছে');
        setConnectionStatus('connecting', 'অপেক্ষা করা হচ্ছে...');
        // Don't destroy everything — wait for them to come back
        if (state.pc) {
          try { state.pc.close(); } catch (_) {}
          state.pc = null;
        }
        state.dataChannel = null;
        showReconnectButton(true);
      } else {
        updateWaitingStatus(msg.participantCount);
      }
      break;

    case 'signal':
      handleRemoteSignal(msg.signal);
      break;

    case 'error':
      if (msg.message && msg.message.includes('পূর্ণ')) {
        showError('রুম পূর্ণ', msg.message);
        cleanup();
      } else if (!state.isSelectingFile) {
        setConnectionStatus('offline', msg.message || 'ত্রুটি');
        showReconnectButton(true);
      }
      break;

    case 'pong':
      break;
  }
}

function updateWaitingStatus(count) {
  if (count === 1) {
    els.waitingStatus.innerHTML = `রুম আইডি: <code>${state.roomId}</code><br>অন্য ব্যক্তির জন্য অপেক্ষা করছি...`;
  } else {
    els.waitingStatus.innerHTML = `রুম আইডি: <code>${state.roomId}</code><br>পিয়ার পাওয়া গেছে। কানেক্ট হচ্ছে...`;
  }
}

// ---------- WebRTC ----------
function startWebRTC() {
  // Prevent duplicate PC
  if (state.pc && state.pc.connectionState !== 'closed' && state.pc.connectionState !== 'failed') {
    return;
  }

  // Clean old one
  if (state.pc) {
    try { state.pc.close(); } catch (_) {}
  }

  setConnectionStatus('connecting', 'সংযোগ স্থাপন হচ্ছে...');
  showReconnectButton(false);

  const pc = new RTCPeerConnection(getIceServers());
  state.pc = pc;

  pc.onicecandidate = (ev) => {
    if (ev.candidate && state.ws && state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(JSON.stringify({
          type: 'signal',
          signal: { type: 'ice-candidate', candidate: ev.candidate }
        }));
      } catch (_) {}
    }
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === 'connected' || s === 'completed') {
      setConnectionStatus('online', 'সংযুক্ত (P2P)');
      showReconnectButton(false);
    } else if (s === 'disconnected') {
      // Temporary — give it a chance
      setConnectionStatus('connecting', 'সাময়িক বিচ্ছিন্ন...');
    } else if (s === 'failed') {
      setConnectionStatus('offline', 'কানেকশন ব্যর্থ');
      showReconnectButton(true);
      addSystemMessage('WebRTC ব্যর্থ। পুনঃসংযোগ চেষ্টা করুন। (মোবাইল ডাটায় TURN সার্ভার সাহায্য করতে পারে)');
    } else if (s === 'checking') {
      setConnectionStatus('connecting', 'পরীক্ষা করা হচ্ছে...');
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      if (!state.intentionalLeave) {
        showReconnectButton(true);
      }
    }
  };

  pc.ondatachannel = (ev) => {
    setupDataChannel(ev.channel);
  };

  if (state.isInitiator) {
    const dc = pc.createDataChannel('zerochat', {
      ordered: true,
      maxRetransmits: 15
    });
    setupDataChannel(dc);

    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({
            type: 'signal',
            signal: { type: 'offer', sdp: pc.localDescription }
          }));
        }
      })
      .catch(err => {
        console.error('Offer error', err);
        setConnectionStatus('offline', 'অফার তৈরি ব্যর্থ');
        showReconnectButton(true);
      });
  }
}

async function handleRemoteSignal(signal) {
  if (!state.pc || state.pc.connectionState === 'closed' || state.pc.connectionState === 'failed') {
    startWebRTC();
  }

  const pc = state.pc;
  if (!pc) return;

  try {
    if (signal.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
          type: 'signal',
          signal: { type: 'answer', sdp: pc.localDescription }
        }));
      }
    } else if (signal.type === 'answer') {
      if (pc.signalingState !== 'stable') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      }
    } else if (signal.type === 'ice-candidate' && signal.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      } catch (_) {}
    }
  } catch (err) {
    console.error('Signal handling error', err);
  }
}

function setupDataChannel(dc) {
  state.dataChannel = dc;
  dc.binaryType = 'arraybuffer';

  dc.onopen = () => {
    setConnectionStatus('online', 'সংযুক্ত (P2P)');
    showReconnectButton(false);
    showScreen('chat');
    // Don't clear messages on reconnect — keep history of this session
    if (els.messages.children.length === 0) {
      addSystemMessage('নিরাপদ চ্যানেল খোলা হয়েছে। চ্যাট শুরু করুন।');
    } else {
      addSystemMessage('পুনরায় সংযুক্ত হয়েছে ✓');
    }
    generateSafetyCode();
  };

  dc.onclose = () => {
    if (state.intentionalLeave) return;
    setConnectionStatus('connecting', 'চ্যানেল বন্ধ — পুনঃসংযোগ...');
    showReconnectButton(true);
    // Auto try after short delay
    setTimeout(() => {
      if (!state.intentionalLeave && state.roomId && (!state.dataChannel || state.dataChannel.readyState !== 'open')) {
        quickReconnect();
      }
    }, 1200);
  };

  dc.onerror = () => {};

  dc.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      handleTextMessage(ev.data);
    } else {
      handleBinaryChunk(ev.data);
    }
  };
}

function generateSafetyCode() {
  const base = (state.roomId || '') + (state.participantId || '');
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = ((hash << 5) - hash) + base.charCodeAt(i);
    hash |= 0;
  }
  const code = Math.abs(hash).toString(16).toUpperCase().padStart(6, '0').slice(0, 6);
  state.safetyCode = code.match(/.{1,2}/g).join('-');
}

// ---------- Status UI ----------
function setConnectionStatus(status, text) {
  // Debounce rapid changes
  if (state.statusDebounceTimer) clearTimeout(state.statusDebounceTimer);

  state.statusDebounceTimer = setTimeout(() => {
    if (state.lastStatus === status + text) return;
    state.lastStatus = status + text;
    els.connStatus.className = 'status-dot ' + status;
    els.connText.textContent = text;
  }, 180);
}

function showReconnectButton(show) {
  if (show) {
    els.btnReconnect.classList.remove('hidden');
  } else {
    els.btnReconnect.classList.add('hidden');
  }
}

// ---------- Messaging ----------
function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'message system';
  div.textContent = text;
  els.messages.appendChild(div);
  scrollMessages();
}

function addChatMessage(text, isMine, time) {
  const div = document.createElement('div');
  div.className = 'message ' + (isMine ? 'mine' : 'theirs');
  const timeStr = time || formatTime(new Date());
  div.innerHTML = escapeHtml(text) + `<span class="time">${timeStr}</span>`;
  els.messages.appendChild(div);
  scrollMessages();
}

function addFileMessage(fileName, size, url, isMine, time) {
  const div = document.createElement('div');
  div.className = 'message file ' + (isMine ? 'mine' : 'theirs');
  const sizeStr = formatSize(size);
  const timeStr = time || formatTime(new Date());
  const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(fileName);
  const isVideo = /\.(mp4|webm|mov)$/i.test(fileName);

  let preview = '';
  if (isImage) {
    preview = `<img src="${url}" alt="" style="max-width:100%;border-radius:10px;margin-top:4px;max-height:200px;">`;
  } else if (isVideo) {
    preview = `<video src="${url}" controls style="max-width:100%;border-radius:10px;margin-top:4px;max-height:200px;"></video>`;
  }

  div.innerHTML = `
    <strong>📎 ${escapeHtml(fileName)}</strong>
    <span>(${sizeStr})</span>
    ${preview}
    <a href="${url}" download="${escapeHtml(fileName)}">ডাউনলোড করুন</a>
    <span class="time">${timeStr}</span>
  `;
  els.messages.appendChild(div);
  scrollMessages();
}

function scrollMessages() {
  requestAnimationFrame(() => {
    els.messages.scrollTop = els.messages.scrollHeight;
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatTime(d) {
  return d.toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Send text
els.btnSend.addEventListener('click', sendText);
els.messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
});

els.messageInput.addEventListener('input', () => {
  els.messageInput.style.height = 'auto';
  els.messageInput.style.height = Math.min(els.messageInput.scrollHeight, 120) + 'px';
});

function sendText() {
  const text = els.messageInput.value.trim();
  if (!text) return;

  if (!state.dataChannel || state.dataChannel.readyState !== 'open') {
    addSystemMessage('এখনো সংযুক্ত নয়। পুনঃসংযোগ করুন।');
    showReconnectButton(true);
    return;
  }

  const payload = JSON.stringify({
    t: 'text',
    c: text,
    ts: Date.now()
  });

  try {
    state.dataChannel.send(payload);
    addChatMessage(text, true);
    els.messageInput.value = '';
    els.messageInput.style.height = 'auto';
  } catch (err) {
    addSystemMessage('মেসেজ পাঠাতে ব্যর্থ');
    showReconnectButton(true);
  }
}

function handleTextMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    if (msg.t === 'text' && typeof msg.c === 'string') {
      addChatMessage(msg.c, false, msg.ts ? formatTime(new Date(msg.ts)) : undefined);
    } else if (msg.t === 'file-meta') {
      incomingFile = {
        name: msg.name,
        size: msg.size,
        type: msg.mime || 'application/octet-stream',
        chunks: [],
        received: 0
      };
      showFileProgress(0, `রিসিভ হচ্ছে: ${msg.name}`);
    } else if (msg.t === 'file-end') {
      finishIncomingFile();
    }
  } catch (_) {}
}

// ---------- File Transfer (Multiple support) ----------
let incomingFile = null;

els.btnAttach.addEventListener('click', () => {
  // Mark that we are opening gallery — protect connection
  state.isSelectingFile = true;
  // Keep-alive ping right before opening picker
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try { state.ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
  }
  els.fileInput.click();

  // Safety timeout: if user cancels picker, clear flag
  setTimeout(() => {
    state.isSelectingFile = false;
  }, 120000); // 2 min max
});

els.fileInput.addEventListener('change', () => {
  const files = Array.from(els.fileInput.files || []);
  els.fileInput.value = '';
  state.isSelectingFile = false;

  if (files.length === 0) return;

  // Check connection after returning from gallery
  if (!state.dataChannel || state.dataChannel.readyState !== 'open') {
    addSystemMessage('গ্যালারি থেকে ফিরে এসে সংযোগ পাওয়া যায়নি। পুনঃসংযোগ করা হচ্ছে...');
    showReconnectButton(true);
    // Try auto reconnect then queue the files
    state.fileQueue = files;
    quickReconnect();
    // After a moment, try sending if channel opens
    const checkInterval = setInterval(() => {
      if (state.dataChannel && state.dataChannel.readyState === 'open') {
        clearInterval(checkInterval);
        processFileQueue();
      }
    }, 600);
    setTimeout(() => clearInterval(checkInterval), 10000);
    return;
  }

  // Queue all selected files
  state.fileQueue.push(...files);
  processFileQueue();
});

function processFileQueue() {
  if (state.isSendingFile || state.fileQueue.length === 0) return;
  if (!state.dataChannel || state.dataChannel.readyState !== 'open') {
    showReconnectButton(true);
    return;
  }

  const file = state.fileQueue.shift();
  sendFile(file);
}

async function sendFile(file) {
  if (!state.dataChannel || state.dataChannel.readyState !== 'open') {
    state.fileQueue.unshift(file); // put back
    addSystemMessage('চ্যানেল খোলা নেই');
    showReconnectButton(true);
    return;
  }

  if (file.size > MAX_FILE_SIZE) {
    addSystemMessage(`"${file.name}" খুব বড়। সর্বোচ্চ ${formatSize(MAX_FILE_SIZE)}`);
    processFileQueue(); // next
    return;
  }

  const allowed = /^(image\/|video\/|application\/pdf|text\/|application\/zip|application\/x-rar|application\/msword|application\/vnd\.)/;
  if (file.type && !allowed.test(file.type) && !/\.(jpg|jpeg|png|gif|webp|mp4|webm|mov|pdf|txt|zip|rar|doc|docx)$/i.test(file.name)) {
    addSystemMessage(`"${file.name}" এই ধরনের ফাইল অনুমোদিত নয়`);
    processFileQueue();
    return;
  }

  state.isSendingFile = true;

  // Metadata
  const meta = JSON.stringify({
    t: 'file-meta',
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream'
  });

  try {
    state.dataChannel.send(meta);
  } catch (err) {
    state.isSendingFile = false;
    addSystemMessage('ফাইল মেটা পাঠাতে ব্যর্থ');
    showReconnectButton(true);
    return;
  }

  showFileProgress(0, `পাঠানো হচ্ছে: ${file.name}`);

  const buffer = await file.arrayBuffer();
  const total = buffer.byteLength;
  let offset = 0;

  function sendNextChunk() {
    if (!state.dataChannel || state.dataChannel.readyState !== 'open') {
      state.isSendingFile = false;
      hideFileProgress();
      addSystemMessage('পাঠানোর সময় সংযোগ বিচ্ছিন্ন');
      showReconnectButton(true);
      return;
    }

    if (offset >= total) {
      try {
        state.dataChannel.send(JSON.stringify({ t: 'file-end' }));
      } catch (_) {}
      hideFileProgress();
      const blob = new Blob([buffer], { type: file.type });
      const url = URL.createObjectURL(blob);
      addFileMessage(file.name, file.size, url, true);
      state.isSendingFile = false;
      // Continue with next file in queue
      setTimeout(processFileQueue, 300);
      return;
    }

    const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
    try {
      if (state.dataChannel.bufferedAmount > 512 * 1024) {
        setTimeout(sendNextChunk, 40);
        return;
      }
      state.dataChannel.send(chunk);
      offset += chunk.byteLength;
      const pct = Math.round((offset / total) * 100);
      showFileProgress(pct, `পাঠানো হচ্ছে: ${file.name} (${pct}%)`);
      setTimeout(sendNextChunk, 0);
    } catch (err) {
      state.isSendingFile = false;
      hideFileProgress();
      addSystemMessage('ফাইল পাঠাতে ব্যর্থ');
      showReconnectButton(true);
    }
  }

  sendNextChunk();
}

function handleBinaryChunk(data) {
  if (!incomingFile) return;
  incomingFile.chunks.push(data);
  incomingFile.received += data.byteLength;
  const pct = Math.round((incomingFile.received / incomingFile.size) * 100);
  showFileProgress(pct, `রিসিভ হচ্ছে: ${incomingFile.name} (${pct}%)`);
}

function finishIncomingFile() {
  if (!incomingFile) return;
  const blob = new Blob(incomingFile.chunks, { type: incomingFile.type });
  const url = URL.createObjectURL(blob);
  addFileMessage(incomingFile.name, incomingFile.size, url, false);
  hideFileProgress();
  incomingFile = null;
}

function showFileProgress(pct, text) {
  els.fileProgress.classList.remove('hidden');
  els.progressFill.style.width = pct + '%';
  els.progressText.textContent = text;
}

function hideFileProgress() {
  els.fileProgress.classList.add('hidden');
  els.progressFill.style.width = '0%';
}

// ---------- Visibility / Page lifecycle (important for mobile gallery) ----------
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.roomId && !state.intentionalLeave) {
    // User came back from gallery / another app
    state.isSelectingFile = false;

    // Ping / check connection
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      try { state.ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
    }

    // If datachannel is dead, try quick reconnect
    if (screens.chat.classList.contains('active')) {
      if (!state.dataChannel || state.dataChannel.readyState !== 'open') {
        setConnectionStatus('connecting', 'ফিরে এসে সংযোগ পরীক্ষা...');
        setTimeout(() => {
          if (!state.dataChannel || state.dataChannel.readyState !== 'open') {
            quickReconnect();
          }
        }, 700);
      }
    }
  }
});

// ---------- Cleanup ----------
function cleanup() {
  state.intentionalLeave = true;
  clearWsPing();
  if (state.dataChannel) {
    try { state.dataChannel.close(); } catch (_) {}
  }
  if (state.pc) {
    try { state.pc.close(); } catch (_) {}
  }
  if (state.ws) {
    try {
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'leave' }));
      }
      state.ws.close();
    } catch (_) {}
  }
  state = {
    roomId: null,
    participantId: null,
    isInitiator: false,
    ws: null,
    pc: null,
    dataChannel: null,
    safetyCode: null,
    reconnectAttempts: 0,
    intentionalLeave: false,
    isSelectingFile: false,
    lastStatus: null,
    wsPingTimer: null,
    statusDebounceTimer: null,
    fileQueue: [],
    isSendingFile: false
  };
  incomingFile = null;
  showReconnectButton(false);
}

function cleanupAndHome() {
  cleanup();
  showScreen('welcome');
}

// ---------- Init ----------
initTheme();
showScreen('welcome');

window.addEventListener('beforeunload', (e) => {
  if (state.dataChannel && state.dataChannel.readyState === 'open') {
    e.preventDefault();
    e.returnValue = '';
  }
});
