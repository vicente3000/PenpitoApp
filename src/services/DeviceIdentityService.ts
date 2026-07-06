import AsyncStorage from '@react-native-async-storage/async-storage';

const DEVICE_ID_KEY = 'penpito.device.id';

let cachedDeviceId: string | null = null;

function generateDeviceId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `dev-${timestamp}-${random}`;
}

export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) {
    return cachedDeviceId;
  }

  try {
    const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (stored) {
      cachedDeviceId = stored;
      return stored;
    }

    const newId = generateDeviceId();
    await AsyncStorage.setItem(DEVICE_ID_KEY, newId);
    cachedDeviceId = newId;
    return newId;
  } catch {
    const fallback = generateDeviceId();
    cachedDeviceId = fallback;
    return fallback;
  }
}

export function getDeviceIdSync(): string | null {
  return cachedDeviceId;
}
