import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GameConfig, symbols, faceRotations } from './config';
import './style.css';

// ============================================
// TYPE DEFINITIONS
// ============================================
interface DieUserData {
  targetValue: number;
  index: number;
}

interface BasePosition {
  x: number;
  y: number;
  z: number;
}

interface GameState {
  state: string;
  roundId: string | null;
  targetValues: number[];
  connected: boolean;
}

// SSE Event Types
interface LastOutcomeEvent {
  chatId: number;
  diceValues: number[];
  updatedAt: number;
  roundId: string | null;
  serverNow: number;
}

interface RoundScheduledEvent {
  chatId: number;
  startAt: number;
  endAt: number;
  totalMs?: number;
  remainingMs?: number;
  serverNow: number;
}

interface RoundStartedEvent {
  roundId: string;
  chatId: number;
  startAt: number;
  endAt: number;
  totalMs?: number;
  remainingMs?: number;
  serverNow: number;
}

interface RoundResultEvent {
  roundId: string;
  chatId: number;
  diceValues: number[];
  serverNow: number;
}

interface RoundCancelledEvent {
  chatId: number;
  serverNow: number;
}

type SnapshotResponse =
  | {
      state: 'SCHEDULED';
      chatId: number;
      startAt: number;
      endAt: number;
      lastOutcome: { diceValues: number[]; updatedAt: number; roundId: string | null };
      serverNow: number;
      totalMs?: number;
      remainingMs?: number;
    }
  | {
      state: 'STARTED_OR_REVEALED';
      chatId: number;
      round: {
        id: string;
        name: string | null;
        startAt: number;
        endAt: number;
        diceValues: number[] | null;
        totalMs?: number;
        remainingMs?: number;
      };
      lastOutcome: { diceValues: number[]; updatedAt: number; roundId: string | null };
      serverNow: number;
    }
  | {
      state: 'IDLE';
      chatId: number;
      lastOutcome: { diceValues: number[]; updatedAt: number; roundId: string | null };
      serverNow: number;
    };

// Extend Window interface for global API
declare global {
  interface Window {
    getGameState: () => GameState;
    reconnect: () => void;
  }
}

// ============================================
// PRE-COMPUTED QUATERNIONS
// ============================================
const faceQuaternions: Record<number, THREE.Quaternion> = {};
Object.entries(faceRotations).forEach(([key, rot]) => {
  const euler = new THREE.Euler(rot.x, rot.y, rot.z, 'XYZ');
  faceQuaternions[Number(key)] = new THREE.Quaternion().setFromEuler(euler);
});

// ============================================
// THREE.JS VARIABLES
// ============================================
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let dice: THREE.Mesh<RoundedBoxGeometry, THREE.MeshStandardMaterial[]>[] = [];
let rollCount = 0;
const basePositions: BasePosition[] = [];

// Preloaded textures
const diceTextures: Map<number, THREE.Texture> = new Map();
let woodTexture: THREE.Texture | null = null;

// Game state
let gameState: 'idle' | 'waiting' | 'countdown' | 'rolling' | 'result' = 'idle';
let scheduledStartAt: number | null = null;
let scheduledEndAt: number | null = null;
let countdownHandle: number | null = null;
let countdownHandleMode: 'raf' | 'timeout' | null = null;
let countdownTotalMs: number | null = null;
let cancelledUntil: number | null = null;
let waitingStateTimeout: number | null = null;
let isFetchingSnapshot = false;
let timeSyncInterval: number | null = null;

// SSE connection
let eventSource: EventSource | null = null;
let reconnectAttempts = 0;
let isConnected = false;

// DOM Elements
let loadingScreen: HTMLElement;
let loadingProgress: HTMLElement;
let loadingText: HTMLElement;
let gameOverlay: HTMLElement;
let resultOverlay: HTMLElement;
let countdownProgress: SVGCircleElement;
let countdownText: HTMLElement;
let statusText: HTMLElement;
let resultSymbols: HTMLElement;
let nextRoundText: HTMLElement;
let clockTime: HTMLElement;
let connectionStatus: HTMLElement;

// ============================================
// BHUTAN CLOCK
// ============================================
function updateBhutanClock(): void {
  const now = new Date();
  const bhutanTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Thimphu' }));
  
  const hours = String(bhutanTime.getHours()).padStart(2, '0');
  const minutes = String(bhutanTime.getMinutes()).padStart(2, '0');
  
  clockTime.textContent = `${hours}:${minutes}`;
}

function initClock(): void {
  clockTime = document.getElementById('clockTime')!;
  updateBhutanClock();
  setInterval(updateBhutanClock, 1000);
}

// ============================================
// SERVER TIME SYNC
// ============================================
function getServerTime(): number {
  return Date.now() + GameConfig.serverTimeOffset;
}

function updateServerTimeOffset(serverNow: number): void {
  // Calculate offset between server and client time
  GameConfig.serverTimeOffset = serverNow - Date.now();
}

function startPeriodicTimeSync(): void {
  // Clear existing interval if any
  if (timeSyncInterval !== null) {
    clearInterval(timeSyncInterval);
  }
  
  // Sync time every 30 seconds to prevent drift
  timeSyncInterval = window.setInterval(async () => {
    try {
      const res = await fetch(`${GameConfig.backendUrl}/rounds/current`, { cache: 'no-store' });
      if (res.ok) {
        const data: SnapshotResponse = await res.json();
        updateServerTimeOffset(data.serverNow);
      }
    } catch (err) {
      console.error('[TimeSync] Failed to sync time', err);
    }
  }, 30000);
}

function stopPeriodicTimeSync(): void {
  if (timeSyncInterval !== null) {
    clearInterval(timeSyncInterval);
    timeSyncInterval = null;
  }
}

// ============================================
// CONNECTION STATUS
// ============================================
function updateConnectionStatus(connected: boolean, message?: string): void {
  isConnected = connected;
  if (connectionStatus) {
    connectionStatus.className = `connection-status ${connected ? 'connected' : 'disconnected'}`;
    connectionStatus.textContent = message || (connected ? 'Connected' : 'Disconnected');
  }
}

// ============================================
// PUBLIC API
// ============================================
function getGameState(): GameState {
  return {
    state: gameState,
    roundId: GameConfig.currentRoundId,
    targetValues: GameConfig.targetValues,
    connected: isConnected,
  };
}

function reconnect(): void {
  if (eventSource) {
    eventSource.close();
  }
  reconnectAttempts = 0;
  connectSSE();
}

// Expose to window
window.getGameState = getGameState;
window.reconnect = reconnect;

// ============================================
// SSE CONNECTION
// ============================================
function connectSSE(): void {
  const url = `${GameConfig.backendUrl}/sse`;
  console.log(`[SSE] Connecting to ${url}`);
  updateConnectionStatus(false, 'Connecting...');

  eventSource = new EventSource(url);

  eventSource.onopen = () => {
    console.log('[SSE] Connection opened');
    reconnectAttempts = 0;
    updateConnectionStatus(true);
    // Refresh state on reconnect/open to catch up with missed events.
    fetchSnapshotAndSync();
    // Start periodic time sync to prevent drift (every 30 seconds)
    startPeriodicTimeSync();
  };

  eventSource.onerror = (error) => {
    console.error('[SSE] Connection error:', error);
    updateConnectionStatus(false, 'Connection lost');
    
    if (eventSource?.readyState === EventSource.CLOSED) {
      scheduleReconnect();
    }
  };

  // Handle last.outcome event
  eventSource.addEventListener('last.outcome', (event: MessageEvent) => {
    let data: LastOutcomeEvent;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      console.error('[SSE] Failed to parse last.outcome event:', err);
      return;
    }
    console.log('[SSE] last.outcome:', data);
    
    updateServerTimeOffset(data.serverNow);
    GameConfig.targetValues = data.diceValues;
    GameConfig.currentRoundId = data.roundId;
    
    // Update dice to show last outcome and display result overlay
    updateDiceToValues(data.diceValues);
    
    // Show last result on connect (if not already in a round or countdown)
    // Don't show if we're in countdown state (waiting for round.result)
    if (gameState === 'idle' || (gameState === 'waiting' && !scheduledEndAt)) {
      showLastOutcome(data.diceValues);
    }
  });

  // Handle round.scheduled event
  eventSource.addEventListener('round.scheduled', (event: MessageEvent) => {
    let data: RoundScheduledEvent;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      console.error('[SSE] Failed to parse round.scheduled event:', err);
      return;
    }
    console.log('[SSE] round.scheduled:', data);
    
    updateServerTimeOffset(data.serverNow);
    cancelledUntil = null;
    scheduledStartAt = data.startAt;
    scheduledEndAt = data.endAt;
    
    // Start countdown to startAt
    startScheduledCountdown(data.totalMs, data.remainingMs);
  });

  // Handle round.started event
  eventSource.addEventListener('round.started', (event: MessageEvent) => {
    let data: RoundStartedEvent;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      console.error('[SSE] Failed to parse round.started event:', err);
      return;
    }
    console.log('[SSE] round.started:', data);
    
    updateServerTimeOffset(data.serverNow);
    cancelledUntil = null;
    GameConfig.currentRoundId = data.roundId;
    scheduledStartAt = data.startAt;
    scheduledEndAt = data.endAt;
    
    // Cancel any previous countdown before starting the round countdown
    cancelCountdown();
    
    // Transition to waiting for result (countdown to endAt)
    startRoundCountdown(data.totalMs, data.remainingMs);
  });

  // Handle round.result event
  eventSource.addEventListener('round.result', (event: MessageEvent) => {
    let data: RoundResultEvent;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      console.error('[SSE] Failed to parse round.result event:', err);
      return;
    }
    console.log('[SSE] round.result:', data);
    
    updateServerTimeOffset(data.serverNow);
    GameConfig.targetValues = data.diceValues;
    GameConfig.currentRoundId = data.roundId;
    
    // Cancel any ongoing countdown before starting the roll
    cancelCountdown();
    
    // Roll dice to show result
    startRolling(data.diceValues);
  });

  // Handle round.cancelled event
  eventSource.addEventListener('round.cancelled', (event: MessageEvent) => {
    let data: RoundCancelledEvent;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      console.error('[SSE] Failed to parse round.cancelled event:', err);
      return;
    }
    console.log('[SSE] round.cancelled:', data);
    
    updateServerTimeOffset(data.serverNow);
    // Block countdown restarts until the current round window ends (best effort).
    const now = getServerTime();
    const horizon = scheduledEndAt ?? scheduledStartAt ?? now + 30000;
    cancelledUntil = horizon;
    
    // Cancel any ongoing countdown
    cancelCountdown();
    showWaitingState('Waiting for next round...');
  });
}

function scheduleReconnect(): void {
  if (reconnectAttempts >= GameConfig.maxReconnectAttempts) {
    console.error('[SSE] Max reconnect attempts reached');
    updateConnectionStatus(false, 'Connection failed');
    return;
  }

  reconnectAttempts++;
  const delay = GameConfig.reconnectDelay * Math.min(reconnectAttempts, 5);
  console.log(`[SSE] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  updateConnectionStatus(false, `Reconnecting in ${Math.ceil(delay / 1000)}s...`);
  
  setTimeout(() => {
    connectSSE();
  }, delay);
}

// ============================================
// GAME LOOP - BACKEND DRIVEN
// ============================================

function startScheduledCountdown(totalMs?: number, remainingMs?: number): void {
  if (!scheduledStartAt) return;
  
  // If we recently cancelled and are still within the cancelled window, do not restart.
  if (cancelledUntil && getServerTime() < cancelledUntil) {
    showWaitingState('Waiting for next round...');
    return;
  }

  const remaining = remainingMs ?? Math.max(0, scheduledStartAt - getServerTime());
  const total = Math.max(1, totalMs ?? countdownTotalMs ?? remaining);
  countdownTotalMs = total;
  const targetTime = getServerTime() + remaining;

  gameState = 'countdown';
  
  // Show overlay
  gameOverlay.classList.remove('hidden');
  resultOverlay.classList.remove('visible');
  statusText.textContent = 'Round starting soon...';
  
  // Start countdown animation to startAt
  animateCountdownToTime(targetTime, 'Round starting in', total);
}

function startRoundCountdown(totalMs?: number, remainingMs?: number): void {
  if (!scheduledEndAt) return;
  
  // If we recently cancelled and are still within the cancelled window, do not restart.
  if (cancelledUntil && getServerTime() < cancelledUntil) {
    showWaitingState('Waiting for next round...');
    return;
  }

  // Cancel any existing countdown before starting a new one
  clearCountdownFrame();

  const remaining = remainingMs ?? Math.max(0, scheduledEndAt - getServerTime());
  const total = Math.max(1, totalMs ?? countdownTotalMs ?? remaining);
  countdownTotalMs = total;
  const targetTime = getServerTime() + remaining;

  gameState = 'countdown';
  
  // Show overlay
  gameOverlay.classList.remove('hidden');
  resultOverlay.classList.remove('visible');
  statusText.textContent = 'Rolling soon...';
  
  // Start countdown animation to endAt (when result will be revealed)
  animateCountdownToTime(targetTime, 'Result in', total);
}

function animateCountdownToTime(targetTime: number, label: string, totalDuration?: number): void {
  const now = getServerTime();
  const remaining = Math.max(0, targetTime - getServerTime());
  // Preserve the original duration so progress uses a stable denominator, and never let it be less than remaining
  const baseDuration = totalDuration ?? targetTime - now;
  const duration = Math.max(1, Math.max(baseDuration, remaining));
  
  // Calculate progress (0 = just started, 1 = finished)
  const progress = 1 - remaining / duration;
  
  // Update circular progress (smooth)
  const circumference = 283; // 2 * PI * 45
  const offset = circumference * progress;
  // Start full (0) and decrease toward circumference
  countdownProgress.style.strokeDashoffset = String(offset);
  
  // Update countdown number
  const secondsLeft = Math.ceil(remaining / 1000);
  countdownText.textContent = String(Math.max(0, secondsLeft));
  
  // Color transition
  const remainingRatio = remaining / duration;
  if (remainingRatio > 0.5) {
    countdownProgress.style.stroke = '#4ade80'; // Green
  } else if (remainingRatio > 0.25) {
    countdownProgress.style.stroke = '#facc15'; // Yellow
  } else {
    countdownProgress.style.stroke = '#ef4444'; // Red
  }
  
  // Status text
  if (secondsLeft <= 3 && secondsLeft > 0) {
    statusText.textContent = 'Get ready...';
  } else {
    statusText.textContent = label;
  }
  
  if (remaining > 0) {
    queueCountdownFrame(targetTime, label, duration);
  } else {
    clearCountdownFrame();
    // Wait for round.result event - show waiting state
    if (gameState === 'countdown') {
      showWaitingState('Waiting for result...');
    }
  }
}

function queueCountdownFrame(targetTime: number, label: string, totalDuration: number) {
  clearCountdownFrame();
  if (document.hidden) {
    countdownHandleMode = 'timeout';
    countdownHandle = window.setTimeout(() => animateCountdownToTime(targetTime, label, totalDuration), 100);
  } else {
    countdownHandleMode = 'raf';
    countdownHandle = requestAnimationFrame(() => animateCountdownToTime(targetTime, label, totalDuration));
  }
}

function clearCountdownFrame(): void {
  if (countdownHandle !== null) {
    if (countdownHandleMode === 'raf') {
      cancelAnimationFrame(countdownHandle);
    } else {
      clearTimeout(countdownHandle);
    }
  }
  countdownHandle = null;
  countdownHandleMode = null;
}

function cancelCountdown(): void {
  clearCountdownFrame();
  // Clear waiting state timeout as well
  if (waitingStateTimeout !== null) {
    clearTimeout(waitingStateTimeout);
    waitingStateTimeout = null;
  }
  // Don't clear scheduledStartAt and scheduledEndAt - they're needed for round timing
  // Only clear countdown-specific state
  countdownTotalMs = null;
}

function showWaitingState(message: string): void {
  // Clear any existing waiting state timeout
  if (waitingStateTimeout !== null) {
    clearTimeout(waitingStateTimeout);
    waitingStateTimeout = null;
  }
  
  gameState = 'waiting';
  gameOverlay.classList.remove('hidden');
  resultOverlay.classList.remove('visible');
  countdownTotalMs = null;
  
  // Reset countdown display
  countdownProgress.style.strokeDashoffset = '0';
  countdownProgress.style.stroke = '#4ade80';
  countdownText.textContent = '...';
  statusText.textContent = message;
  
  // Only auto-show last result if we're not waiting for an active round result
  // If scheduledEndAt is set, we're in an active round and should wait for round.result event
  const isWaitingForActiveRound = scheduledEndAt && getServerTime() < scheduledEndAt;
  
  if (!isWaitingForActiveRound) {
    // After a short delay, show the last result (only if not in an active round)
    waitingStateTimeout = window.setTimeout(() => {
      waitingStateTimeout = null;
      if (gameState === 'waiting' && !(scheduledEndAt && getServerTime() < scheduledEndAt)) {
        gameOverlay.classList.add('hidden');
        // Show the last outcome result
        showLastOutcome(GameConfig.targetValues);
      }
    }, 2000);
  }
}

function startRolling(diceValues: number[]): void {
  // Cancel any ongoing countdown before starting the roll
  cancelCountdown();
  
  // Clear any waiting state timeout to prevent it from showing result prematurely
  if (waitingStateTimeout !== null) {
    clearTimeout(waitingStateTimeout);
    waitingStateTimeout = null;
  }
  
  gameState = 'rolling';
  gameOverlay.classList.add('hidden');
  resultOverlay.classList.remove('visible');
  
  // Update dice target values
  dice.forEach((die, index) => {
    (die.userData as DieUserData).targetValue = diceValues[index] || 1;
  });
  
  // Roll all dice
  rollAllDice();
  
  // Wait for roll to complete, then show result
  setTimeout(() => {
    showResult(diceValues);
  }, GameConfig.rollDuration + dice.length * 100 + 500);
}

function showLastOutcome(diceValues: number[]): void {
  gameState = 'result';
  
  // Hide countdown timer overlay - only show it when a new game starts
  gameOverlay.classList.add('hidden');
  
  // Build result symbols
  buildResultSymbols(diceValues);
  
  // Update result label to show "Last Result"
  const resultLabel = resultOverlay.querySelector('.result-label');
  if (resultLabel) {
    resultLabel.textContent = 'Last Result';
  }
  
  resultOverlay.classList.add('visible');
  
  // Show waiting message
  nextRoundText.textContent = 'Waiting for next round...';
}

function showResult(diceValues: number[]): void {
  gameState = 'result';
  
  // Build result symbols
  buildResultSymbols(diceValues);
  
  // Update result label
  const resultLabel = resultOverlay.querySelector('.result-label');
  if (resultLabel) {
    resultLabel.textContent = 'Round Result';
  }
  
  resultOverlay.classList.add('visible');
  
  // Show "waiting for next round" message - stays visible until next round
  nextRoundText.textContent = 'Waiting for next round...';
}

function buildResultSymbols(diceValues: number[]): void {
  resultSymbols.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const value = diceValues[i];
    
    if (value >= 1 && value <= 6) {
      const div = document.createElement('div');
      div.className = 'result-symbol';
      
      // Use actual dice images
      const img = document.createElement('img');
      img.src = `/Dice_side_${value}.0.png`;
      img.alt = symbols[value]?.name || `Dice ${value}`;
      img.className = 'result-symbol-img';
      div.appendChild(img);
      
      // Add number badge
      const badge = document.createElement('span');
      badge.className = 'result-symbol-number';
      badge.textContent = String(value);
      div.appendChild(badge);
      
      resultSymbols.appendChild(div);
    }
  }
}

function updateDiceToValues(values: number[]): void {
  dice.forEach((die, index) => {
    const targetValue = values[index] || 1;
    (die.userData as DieUserData).targetValue = targetValue;
    
    // Instantly set rotation to target
    const targetQ = faceQuaternions[targetValue];
    die.quaternion.copy(targetQ);
  });
  GameConfig.targetValues = values;
}

// ============================================
// ASSET PRELOADING
// ============================================

interface LoadProgress {
  loaded: number;
  total: number;
}

function updateLoadingProgress(progress: LoadProgress): void {
  const percent = Math.round((progress.loaded / progress.total) * 100);
  if (loadingProgress) {
    loadingProgress.style.width = `${percent}%`;
  }
  if (loadingText) {
    loadingText.textContent = `Loading assets... ${percent}%`;
  }
}

function preloadAssets(): Promise<void> {
  return new Promise((resolve, reject) => {
    const textureLoader = new THREE.TextureLoader();
    
    // Assets to load: 6 dice faces + wood texture
    const assetPaths = [
      { path: '/Dice_side_1.0.png', type: 'dice', value: 1 },
      { path: '/Dice_side_2.0.png', type: 'dice', value: 2 },
      { path: '/Dice_side_3.0.png', type: 'dice', value: 3 },
      { path: '/Dice_side_4.0.png', type: 'dice', value: 4 },
      { path: '/Dice_side_5.0.png', type: 'dice', value: 5 },
      { path: '/Dice_side_6.0.png', type: 'dice', value: 6 },
      { path: '/woodtexture.png', type: 'background', value: 0 },
    ];
    
    const total = assetPaths.length;
    let loaded = 0;
    let hasError = false;
    
    updateLoadingProgress({ loaded: 0, total });
    
    const onAssetLoaded = () => {
      loaded++;
      updateLoadingProgress({ loaded, total });
      
      if (loaded === total && !hasError) {
        // Small delay for smooth transition
        setTimeout(resolve, 300);
      }
    };
    
    const onAssetError = (path: string) => (error: unknown) => {
      hasError = true;
      console.error(`Failed to load asset: ${path}`, error);
      reject(new Error(`Failed to load: ${path}`));
    };
    
    assetPaths.forEach((asset) => {
      textureLoader.load(
        asset.path,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.generateMipmaps = true;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.magFilter = THREE.LinearFilter;
          
          if (asset.type === 'dice') {
            diceTextures.set(asset.value, texture);
          } else if (asset.type === 'background') {
            woodTexture = texture;
          }
          
          onAssetLoaded();
        },
        undefined,
        onAssetError(asset.path)
      );
    });
  });
}

// ============================================
// THREE.JS SETUP
// ============================================

function hideLoadingScreen(): void {
  loadingScreen.classList.add('hidden');
}

async function init(): Promise<void> {
  // Get DOM elements
  loadingScreen = document.getElementById('loadingScreen')!;
  loadingProgress = loadingScreen.querySelector('.loading-progress')!;
  loadingText = loadingScreen.querySelector('.loading-text')!;
  gameOverlay = document.getElementById('gameOverlay')!;
  resultOverlay = document.getElementById('resultOverlay')!;
  countdownProgress = document.getElementById('countdownProgress') as unknown as SVGCircleElement;
  countdownText = document.getElementById('countdownText')!;
  statusText = document.getElementById('statusText')!;
  resultSymbols = document.getElementById('resultSymbols')!;
  nextRoundText = document.getElementById('nextRoundText')!;
  connectionStatus = document.getElementById('connectionStatus')!;

  // Initialize Bhutan clock
  initClock();

  try {
    // Preload all assets before starting the game
    await preloadAssets();
    
    // Scene
    scene = new THREE.Scene();
    
    // Use preloaded wood texture as background
    if (woodTexture) {
      scene.background = woodTexture;
    }

    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000);
    updateCameraPosition();

    const canvas = document.getElementById('dice-canvas') as HTMLCanvasElement;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0xffffff, 1.0);
    mainLight.position.set(5, 10, 8);
    mainLight.castShadow = true;
    scene.add(mainLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
    fillLight.position.set(-5, 5, -5);
    scene.add(fillLight);

    const frontLight = new THREE.DirectionalLight(0xffffff, 0.4);
    frontLight.position.set(0, 0, 10);
    scene.add(frontLight);

    createDice();
    animate();

    window.addEventListener('resize', onWindowResize);

    // Hide loading screen and connect to SSE
    hideLoadingScreen();
    
    // Connect to backend SSE after loading
    setTimeout(() => {
      connectSSE();
    }, 500);
    
  } catch (error) {
    console.error('Failed to initialize game:', error);
    if (loadingText) {
      loadingText.textContent = 'Failed to load assets. Please refresh.';
    }
  }
}



// Create a texture with number badge overlay
function createTextureWithNumber(baseTexture: THREE.Texture, number: number): THREE.Texture {
  const size = 512; // Canvas size
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  
  // Fill with white background first
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  
  // Draw the base texture
  if (baseTexture.image) {
    ctx.drawImage(baseTexture.image, 0, 0, size, size);
  }
  
  // Draw number badge in top-right corner
  const badgeSize = 60;
  const badgeX = size - badgeSize - 20;
  const badgeY = 20;
  
  // Badge background
  ctx.beginPath();
  ctx.arc(badgeX + badgeSize / 2, badgeY + badgeSize / 2, badgeSize / 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.fill();
  
  // Badge border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 3;
  ctx.stroke();
  
  // Badge number
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), badgeX + badgeSize / 2, badgeY + badgeSize / 2 + 2);
  
  // Create texture from canvas
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  
  return texture;
}

function getDiceTextureWithNumber(faceValue: number): THREE.Texture | null {
  const baseTexture = diceTextures.get(faceValue);
  if (!baseTexture) return null;
  return createTextureWithNumber(baseTexture, faceValue);
}

function createDie(index: number): THREE.Mesh<RoundedBoxGeometry, THREE.MeshStandardMaterial[]> {
  const size = 2;
  const radius = 0.18;
  const segments = 25;

  const geometry = new RoundedBoxGeometry(size, size, size, segments, radius);

  // Dice face mapping: [+X, -X, +Y, -Y, +Z, -Z]
  // We map the dice textures to appropriate faces with number badges
  const materials: THREE.MeshStandardMaterial[] = [
    new THREE.MeshStandardMaterial({ map: getDiceTextureWithNumber(4), color: 0xffffff, roughness: 0.3, metalness: 0 }), // +X
    new THREE.MeshStandardMaterial({ map: getDiceTextureWithNumber(3), color: 0xffffff, roughness: 0.3, metalness: 0 }), // -X
    new THREE.MeshStandardMaterial({ map: getDiceTextureWithNumber(2), color: 0xffffff, roughness: 0.3, metalness: 0 }), // +Y
    new THREE.MeshStandardMaterial({ map: getDiceTextureWithNumber(5), color: 0xffffff, roughness: 0.3, metalness: 0 }), // -Y
    new THREE.MeshStandardMaterial({ map: getDiceTextureWithNumber(1), color: 0xffffff, roughness: 0.3, metalness: 0 }), // +Z (front)
    new THREE.MeshStandardMaterial({ map: getDiceTextureWithNumber(6), color: 0xffffff, roughness: 0.3, metalness: 0 }), // -Z (back)
  ];

  const die = new THREE.Mesh(geometry, materials);
  die.castShadow = true;
  die.receiveShadow = true;

  (die.userData as DieUserData) = {
    targetValue: GameConfig.targetValues[index] || 1,
    index: index,
  };

  return die;
}

function createDice(): void {
  const spacing = 3.2;
  // Slight upward shift to keep dice centered on desktop
  const yOffset = 0.2;
  const positions = [
    { x: -spacing / 2, y: spacing + yOffset },
    { x: spacing / 2, y: spacing + yOffset },
    { x: -spacing / 2, y: 0 + yOffset },
    { x: spacing / 2, y: 0 + yOffset },
    { x: -spacing / 2, y: -spacing + yOffset },
    { x: spacing / 2, y: -spacing + yOffset },
  ];

  for (let i = 0; i < 6; i++) {
    const die = createDie(i);
    die.position.set(positions[i].x, positions[i].y, 0);
    basePositions.push({ ...positions[i], z: 0 });

    const targetQ = faceQuaternions[GameConfig.targetValues[i] || 1];
    die.quaternion.copy(targetQ);

    scene.add(die);
    dice.push(die);
  }
}

// ============================================
// DICE ANIMATION
// ============================================

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function normalizeAngle(current: number, target: number): number {
  const twoPi = Math.PI * 2;
  let normalized = current % twoPi;
  if (normalized < 0) normalized += twoPi;

  const diff = target - normalized;
  if (Math.abs(diff) <= Math.PI) {
    return normalized;
  } else if (diff > 0) {
    return normalized - twoPi;
  } else {
    return normalized + twoPi;
  }
}

function rollDie(die: THREE.Mesh<RoundedBoxGeometry, THREE.MeshStandardMaterial[]>, delay: number): void {
  const targetValue = (die.userData as DieUserData).targetValue;
  const baseY = basePositions[(die.userData as DieUserData).index].y;

  const startX = die.rotation.x;
  const startY = die.rotation.y;
  const startZ = die.rotation.z;

  const numSpinsX = Math.floor(Math.random() * 2) + 3;
  const numSpinsY = Math.floor(Math.random() * 2) + 3;
  const dir = rollCount % 2 === 0 ? 1 : -1;

  const targetRot = faceRotations[targetValue];

  const spinsX = numSpinsX * Math.PI * 2 * dir;
  const spinsY = numSpinsY * Math.PI * 2 * dir;

  const endX = startX + spinsX + (targetRot.x - normalizeAngle(startX + spinsX, targetRot.x));
  const endY = startY + spinsY + (targetRot.y - normalizeAngle(startY + spinsY, targetRot.y));
  const endZ = targetRot.z;

  const duration = GameConfig.rollDuration;
  const startTime = performance.now() + delay;
  const bounceHeight = 1.2;

  function animateRoll(currentTime: number): void {
    const elapsed = currentTime - startTime;

    if (elapsed < 0) {
      requestAnimationFrame(animateRoll);
      return;
    }

    const progress = Math.min(elapsed / duration, 1);
    const eased = easeOutCubic(progress);

    die.rotation.x = startX + (endX - startX) * eased;
    die.rotation.y = startY + (endY - startY) * eased;
    die.rotation.z = startZ + (endZ - startZ) * eased;

    if (progress < 0.6) {
      const bounceProgress = progress / 0.6;
      const dampening = 1 - bounceProgress;
      const bounce = Math.abs(Math.sin(bounceProgress * Math.PI * 3)) * bounceHeight * dampening;
      die.position.y = baseY + bounce;
    } else {
      die.position.y = baseY;
    }

    if (progress < 1) {
      requestAnimationFrame(animateRoll);
    } else {
      die.rotation.set(targetRot.x, targetRot.y, targetRot.z);
      die.position.y = baseY;
    }
  }

  requestAnimationFrame(animateRoll);
}

function rollAllDice(): void {
  rollCount++;

  dice.forEach((die, index) => {
    rollDie(die, index * 100);
  });
}

// ============================================
// EVENT HANDLERS
// ============================================

async function fetchSnapshotAndSync() {
  // Prevent concurrent calls
  if (isFetchingSnapshot) {
    console.log('[Snapshot] Already fetching, skipping concurrent call');
    return;
  }
  
  isFetchingSnapshot = true;
  try {
    const res = await fetch(`${GameConfig.backendUrl}/rounds/current`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Snapshot failed: ${res.status}`);
    const data: SnapshotResponse = await res.json();
    updateServerTimeOffset(data.serverNow);
    const now = data.serverNow;

    // Always update last outcome and dice
    GameConfig.targetValues = data.lastOutcome.diceValues;
    GameConfig.currentRoundId = data.lastOutcome.roundId;
    updateDiceToValues(GameConfig.targetValues);

    if (data.state === 'SCHEDULED') {
      if (cancelledUntil && now < cancelledUntil) {
        cancelCountdown();
        showWaitingState('Waiting for next round...');
        return;
      }
      scheduledStartAt = data.startAt;
      scheduledEndAt = data.endAt;
      const totalMs = data.totalMs;
      const remainingMs = data.remainingMs ?? Math.max(0, data.startAt - now);
      // If schedule already passed, fall back to waiting/result states.
      if (now >= data.endAt) {
        showLastOutcome(GameConfig.targetValues);
      } else if (now >= data.startAt) {
        startRoundCountdown(data.totalMs ?? data.endAt - data.startAt, Math.max(0, data.endAt - now));
      } else {
        startScheduledCountdown(totalMs ?? remainingMs, remainingMs);
      }
    } else if (data.state === 'STARTED_OR_REVEALED') {
      if (cancelledUntil && now < cancelledUntil) {
        cancelCountdown();
        showWaitingState('Round cancelled');
        return;
      }
      scheduledStartAt = data.round.startAt;
      scheduledEndAt = data.round.endAt;
      GameConfig.currentRoundId = data.round.id;

      if (Array.isArray(data.round.diceValues)) {
        const isCancelledResult = data.round.diceValues.length === 0;
        if (isCancelledResult) {
          // Cancelled round: stop timers and show waiting state
          cancelCountdown();
          showWaitingState('Waiting for next round...');
        } else {
          // Round has a result already.
          GameConfig.targetValues = data.round.diceValues;
          updateDiceToValues(GameConfig.targetValues);
          if (now >= data.round.endAt) {
            // Round already finished; show result without re-rolling.
            showResult(GameConfig.targetValues);
          } else {
            // Round in progress; animate roll to reveal.
            startRolling(GameConfig.targetValues);
          }
        }
      } else {
        // No result yet
        if (now < data.round.endAt) {
          startRoundCountdown(
            data.round.totalMs ?? data.round.endAt - data.round.startAt,
            data.round.remainingMs ?? Math.max(0, data.round.endAt - now),
          );
        } else {
          showWaitingState('Waiting for result...');
        }
      }
    } else {
      // IDLE: show last outcome
      showLastOutcome(GameConfig.targetValues);
    }
  } catch (err) {
    console.error('[Snapshot] Failed to sync', err);
  } finally {
    isFetchingSnapshot = false;
  }
}

function onWindowResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateCameraPosition();
}

function onVisibilityChange(): void {
  if (!document.hidden) {
    // Tab became active: resync with backend to catch missed events and restart countdown timers.
    fetchSnapshotAndSync();
  } else {
    // Stop countdown timers while hidden to avoid drift; they will be restarted on resync.
    clearCountdownFrame();
  }
}

function updateCameraPosition(): void {
  const aspect = window.innerWidth / window.innerHeight;

  if (aspect < 1) {
    camera.position.set(0, 0, 16);
  } else if (aspect > 1.5) {
    camera.position.set(0, 0, 11);
  } else {
    camera.position.set(0, 0, 13);
  }

  camera.lookAt(0, 0, 0);
}

function animate(): void {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}

// Start
init();
document.addEventListener('visibilitychange', onVisibilityChange);

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  stopPeriodicTimeSync();
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  cancelCountdown();
});
