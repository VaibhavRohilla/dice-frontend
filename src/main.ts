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
  serverNow: number;
}

interface RoundStartedEvent {
  roundId: string;
  chatId: number;
  startAt: number;
  endAt: number;
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

// Game state
let gameState: 'idle' | 'waiting' | 'countdown' | 'rolling' | 'result' = 'idle';
let scheduledStartAt: number | null = null;
let scheduledEndAt: number | null = null;
let countdownAnimationId: number | null = null;

// SSE connection
let eventSource: EventSource | null = null;
let reconnectAttempts = 0;
let isConnected = false;

// DOM Elements
let loadingScreen: HTMLElement;
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
  const url = `${GameConfig.backendUrl}/sse?chatId=${GameConfig.chatId}`;
  console.log(`[SSE] Connecting to ${url}`);
  updateConnectionStatus(false, 'Connecting...');

  eventSource = new EventSource(url);

  eventSource.onopen = () => {
    console.log('[SSE] Connection opened');
    reconnectAttempts = 0;
    updateConnectionStatus(true);
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
    const data: LastOutcomeEvent = JSON.parse(event.data);
    console.log('[SSE] last.outcome:', data);
    
    updateServerTimeOffset(data.serverNow);
    GameConfig.targetValues = data.diceValues;
    GameConfig.currentRoundId = data.roundId;
    
    // Update dice to show last outcome and display result overlay
    updateDiceToValues(data.diceValues);
    
    // Show last result on connect (if not already in a round)
    if (gameState === 'idle' || gameState === 'waiting') {
      showLastOutcome(data.diceValues);
    }
  });

  // Handle round.scheduled event
  eventSource.addEventListener('round.scheduled', (event: MessageEvent) => {
    const data: RoundScheduledEvent = JSON.parse(event.data);
    console.log('[SSE] round.scheduled:', data);
    
    updateServerTimeOffset(data.serverNow);
    scheduledStartAt = data.startAt;
    scheduledEndAt = data.endAt;
    
    // Start countdown to startAt
    startScheduledCountdown();
  });

  // Handle round.started event
  eventSource.addEventListener('round.started', (event: MessageEvent) => {
    const data: RoundStartedEvent = JSON.parse(event.data);
    console.log('[SSE] round.started:', data);
    
    updateServerTimeOffset(data.serverNow);
    GameConfig.currentRoundId = data.roundId;
    scheduledStartAt = data.startAt;
    scheduledEndAt = data.endAt;
    
    // Transition to waiting for result (countdown to endAt)
    startRoundCountdown();
  });

  // Handle round.result event
  eventSource.addEventListener('round.result', (event: MessageEvent) => {
    const data: RoundResultEvent = JSON.parse(event.data);
    console.log('[SSE] round.result:', data);
    
    updateServerTimeOffset(data.serverNow);
    GameConfig.targetValues = data.diceValues;
    GameConfig.currentRoundId = data.roundId;
    
    // Roll dice to show result
    startRolling(data.diceValues);
  });

  // Handle round.cancelled event
  eventSource.addEventListener('round.cancelled', (event: MessageEvent) => {
    const data: RoundCancelledEvent = JSON.parse(event.data);
    console.log('[SSE] round.cancelled:', data);
    
    updateServerTimeOffset(data.serverNow);
    
    // Cancel any ongoing countdown
    cancelCountdown();
    showWaitingState('Round cancelled');
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

function startScheduledCountdown(): void {
  if (!scheduledStartAt) return;
  
  gameState = 'countdown';
  
  // Show overlay
  gameOverlay.classList.remove('hidden');
  resultOverlay.classList.remove('visible');
  statusText.textContent = 'Round starting soon...';
  
  // Start countdown animation to startAt
  animateCountdownToTime(scheduledStartAt, 'Round starting in');
}

function startRoundCountdown(): void {
  if (!scheduledEndAt) return;
  
  gameState = 'countdown';
  
  // Show overlay
  gameOverlay.classList.remove('hidden');
  resultOverlay.classList.remove('visible');
  statusText.textContent = 'Rolling soon...';
  
  // Start countdown animation to endAt (when result will be revealed)
  animateCountdownToTime(scheduledEndAt, 'Result in');
}

function animateCountdownToTime(targetTime: number, label: string): void {
  const now = getServerTime();
  const totalDuration = targetTime - now;
  const remaining = Math.max(0, targetTime - getServerTime());
  
  // Calculate progress (0 = just started, 1 = finished)
  const progress = 1 - (remaining / Math.max(totalDuration, 1));
  
  // Update circular progress (smooth)
  const circumference = 283; // 2 * PI * 45
  const offset = circumference * progress;
  countdownProgress.style.strokeDashoffset = String(circumference - offset);
  
  // Update countdown number
  const secondsLeft = Math.ceil(remaining / 1000);
  countdownText.textContent = String(Math.max(0, secondsLeft));
  
  // Color transition
  const remainingRatio = remaining / totalDuration;
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
    countdownAnimationId = requestAnimationFrame(() => animateCountdownToTime(targetTime, label));
  } else {
    countdownAnimationId = null;
    // Wait for round.result event - show waiting state
    if (gameState === 'countdown') {
      showWaitingState('Waiting for result...');
    }
  }
}

function cancelCountdown(): void {
  if (countdownAnimationId) {
    cancelAnimationFrame(countdownAnimationId);
    countdownAnimationId = null;
  }
  scheduledStartAt = null;
  scheduledEndAt = null;
}

function showWaitingState(message: string): void {
  gameState = 'waiting';
  gameOverlay.classList.remove('hidden');
  resultOverlay.classList.remove('visible');
  
  // Reset countdown display
  countdownProgress.style.strokeDashoffset = '0';
  countdownProgress.style.stroke = '#4ade80';
  countdownText.textContent = '...';
  statusText.textContent = message;
  
  // After a short delay, show the last result
  setTimeout(() => {
    if (gameState === 'waiting') {
      gameOverlay.classList.add('hidden');
      // Show the last outcome result
      showLastOutcome(GameConfig.targetValues);
    }
  }, 2000);
}

function startRolling(diceValues: number[]): void {
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
    const symbolData = symbols[value];
    
    if (symbolData) {
      const div = document.createElement('div');
      div.className = 'result-symbol';
      div.textContent = symbolData.char;
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
// THREE.JS SETUP
// ============================================

function hideLoadingScreen(): void {
  loadingScreen.classList.add('hidden');
}

function init(): void {
  // Get DOM elements
  loadingScreen = document.getElementById('loadingScreen')!;
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

  // Scene
  scene = new THREE.Scene();
  
  // Load wood texture as background
  const textureLoader = new THREE.TextureLoader();
  textureLoader.load('/woodtexture.png', (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    scene.background = texture;
  });

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
  requestAnimationFrame(() => {
    hideLoadingScreen();
    
    // Connect to backend SSE after loading
    setTimeout(() => {
      connectSSE();
    }, 500);
  });
}

function createFaceTexture(symbolKey: number): THREE.CanvasTexture | null {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, size, size);

  const symbol = symbols[symbolKey];
  if (!symbol) return null;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = symbol.color;

  ctx.shadowColor = 'rgba(0, 0, 0, 0.15)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetX = 4;
  ctx.shadowOffsetY = 4;

  if (symbol.isEmoji) {
    ctx.font = '500px Arial';
  } else {
    ctx.font = 'bold 580px Arial';
  }

  ctx.fillText(symbol.char, size / 2, size / 2 + 30);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  return texture;
}

function createDie(index: number): THREE.Mesh<RoundedBoxGeometry, THREE.MeshStandardMaterial[]> {
  const size = 2;
  const radius = 0.18;
  const segments = 25;

  const geometry = new RoundedBoxGeometry(size, size, size, segments, radius);

  const materials: THREE.MeshStandardMaterial[] = [
    new THREE.MeshStandardMaterial({ map: createFaceTexture(4), color: 0xffffff, roughness: 1, metalness: 0 }),
    new THREE.MeshStandardMaterial({ map: createFaceTexture(3), color: 0xffffff, roughness: 0.25, metalness: 0 }),
    new THREE.MeshStandardMaterial({ map: createFaceTexture(2), color: 0xffffff, roughness: 0.25, metalness: 0 }),
    new THREE.MeshStandardMaterial({ map: createFaceTexture(5), color: 0xffffff, roughness: 0.25, metalness: 0 }),
    new THREE.MeshStandardMaterial({ map: createFaceTexture(1), color: 0xffffff, roughness: 0.25, metalness: 0 }),
    new THREE.MeshStandardMaterial({ map: createFaceTexture(6), color: 0xffffff, roughness: 0.25, metalness: 0 }),
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
  const spacing = 2.5;
  const positions = [
    { x: -spacing / 2, y: spacing },
    { x: spacing / 2, y: spacing },
    { x: -spacing / 2, y: 0 },
    { x: spacing / 2, y: 0 },
    { x: -spacing / 2, y: -spacing },
    { x: spacing / 2, y: -spacing },
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

function onWindowResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateCameraPosition();
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
