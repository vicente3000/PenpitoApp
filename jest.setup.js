// Mock para expo-sqlite
jest.mock('expo-sqlite', () => {
  return {
    openDatabaseAsync: jest.fn().mockResolvedValue({
      execAsync: jest.fn().mockResolvedValue(undefined),
      runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
      getFirstAsync: jest.fn().mockResolvedValue(null),
      getAllAsync: jest.fn().mockResolvedValue([]),
    }),
  };
});

// Mock para AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Mock para react-native-reanimated
require('react-native-reanimated/mock');

// Mock para expo-font
jest.mock('expo-font', () => ({
  loadAsync: jest.fn().mockResolvedValue(true),
  isLoaded: jest.fn().mockReturnValue(true),
}));

// Mock para expo-camera
jest.mock('expo-camera', () => ({
  Camera: {
    Constants: {},
  },
  useCameraPermissions: jest.fn().mockReturnValue([
    { granted: true, canAskAgain: true, expires: 'never', status: 'granted' },
    jest.fn(),
  ]),
}));

// Mock para expo-constants
jest.mock('expo-constants', () => ({
  expoConfig: {
    name: 'penpitoapp',
    slug: 'penpitoapp',
  },
}));

// Mock para expo-router
jest.mock('expo-router', () => ({
  useRouter: jest.fn(() => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
  })),
  useLocalSearchParams: jest.fn(() => ({})),
  Link: 'Link',
  Stack: {
    Screen: 'Screen',
  },
}));

// Mock de WebSocket para el Adaptador MQTT y entorno Node.js
const wsInstances = [];
const MockWebSocket = jest.fn().mockImplementation(function(url, protocols) {
  this.url = url;
  this.protocols = protocols;
  this.readyState = 1; // WebSocket.OPEN (síncrono para evitar errores de conexión inmediatos)
  this.send = jest.fn();
  
  wsInstances.push(this);

  // Simular llamada asíncrona a onopen en el siguiente ciclo
  const timer = setTimeout(() => {
    if (this.onopen) this.onopen();
  }, 0);

  this.close = jest.fn().mockImplementation(() => {
    clearTimeout(timer);
    this.readyState = 3; // WebSocket.CLOSED
  });
});

MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;
MockWebSocket.mockInstances = wsInstances;

Object.defineProperty(global, 'WebSocket', {
  value: MockWebSocket,
  writable: true,
  configurable: true,
});

Object.defineProperty(globalThis, 'WebSocket', {
  value: MockWebSocket,
  writable: true,
  configurable: true,
});

// Silenciar logs de advertencia innecesarios en tests
console.warn = jest.fn();
console.error = jest.fn();
