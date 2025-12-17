/**
 * Game Configuration
 * Values are loaded from environment variables with sensible defaults
 */
const backendUrl = (import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000').replace(/\/+$/, '');

export const GameConfig = {
  // Application title
  appTitle: 'Jhandi Munda',

  // Backend URL for SSE and API (single-tenant)
  backendUrl,
  
  // Roll animation duration (ms)
  rollDuration: 2500,
  
  // Seconds to show result after dice reveal
  resultDisplayDuration: 5,
  
  // Target values for each dice (1-6)
  // 1=Spade, 2=Club, 3=Flag, 4=Crown, 5=Heart, 6=Diamond
  targetValues: [1, 2, 3, 4, 5, 6] as number[],
  
  // Current round ID (set by backend)
  currentRoundId: null as string | null,
  
  // Server time offset (serverNow - clientNow)
  serverTimeOffset: 0,
  
  // SSE reconnection settings
  reconnectDelay: 2000,
  maxReconnectAttempts: 10,
};

// Symbol definitions with type safety
export interface SymbolData {
  char: string;
  color: string;
  name: string;
  isEmoji?: boolean;
}

export const symbols: Record<number, SymbolData> = {
  1: { char: '♠', color: '#1a1a1a', name: 'Spade' },
  2: { char: '♣', color: '#1a1a1a', name: 'Club' },
  3: { char: '🚩', color: '#e63946', name: 'Flag', isEmoji: true },
  4: { char: '👑', color: '#f4a261', name: 'Crown', isEmoji: true },
  5: { char: '♥', color: '#e63946', name: 'Heart' },
  6: { char: '♦', color: '#e63946', name: 'Diamond' },
};

// Face rotations to show target on FRONT (+Z facing camera)
export interface FaceRotation {
  x: number;
  y: number;
  z: number;
}

export const faceRotations: Record<number, FaceRotation> = {
  1: { x: 0, y: 0, z: 0 },
  6: { x: 0, y: Math.PI, z: 0 },
  4: { x: 0, y: -Math.PI / 2, z: 0 },
  3: { x: 0, y: Math.PI / 2, z: 0 },
  2: { x: Math.PI / 2, y: 0, z: 0 },
  5: { x: -Math.PI / 2, y: 0, z: 0 },
};

