import { ICommunicationAdapter } from './ICommunicationAdapter';
import { DeviceCommand, MachineState } from '../models';

const DEFAULT_KRAKEN_BASE_URL = 'http://192.168.4.1';
const POLL_INTERVAL_MS = 1500;

const initialState: MachineState = {
  isOn: false,
  status: 'idle',
  currentRecipeId: undefined,
  requestedIceCount: 2,
  activeStepId: undefined,
  completedStepIds: [],
  skippedStepIds: [],
  isDrinkReady: false,
};

function getKrakenBaseUrl() {
  return process.env.EXPO_PUBLIC_KRAKEN_BASE_URL ?? DEFAULT_KRAKEN_BASE_URL;
}

export class KrakenHttpAdapter implements ICommunicationAdapter {
  private isConnected = false;
  private stateChangeCallback: ((state: MachineState) => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private currentState: MachineState = initialState;
  private readonly baseUrl: string;

  constructor(baseUrl = getKrakenBaseUrl()) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async connect(): Promise<boolean> {
    try {
      const state = await this.fetchState();
      this.isConnected = true;
      this.setState(state);
      this.startPolling();
      return true;
    } catch (error) {
      console.warn('[KrakenHttpAdapter] Could not connect to Kraken endpoint.', error);
      this.isConnected = false;
      this.setState({
        ...initialState,
        status: 'error',
        errorMessage: 'No se pudo conectar con Kraken. Revisa la red WiFi de la maquina.',
      });
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.isConnected = false;
  }

  async sendCommand(command: DeviceCommand): Promise<boolean> {
    if (!this.isConnected) {
      const connected = await this.connect();
      if (!connected) {
        return false;
      }
    }

    try {
      const response = await fetch(`${this.baseUrl}/command`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(command),
      });

      if (!response.ok) {
        console.warn(`[KrakenHttpAdapter] Command failed with HTTP ${response.status}.`);
        return false;
      }

      const payload = await response.json();
      if (payload?.state) {
        this.setState(payload.state);
      } else {
        await this.refreshState();
      }

      return payload?.ok !== false;
    } catch (error) {
      console.warn('[KrakenHttpAdapter] Error sending command.', error);
      this.isConnected = false;
      return false;
    }
  }

  onStateChange(callback: (state: MachineState) => void): void {
    this.stateChangeCallback = callback;
    this.fireStateChange();
  }

  private startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.refreshState();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async refreshState() {
    try {
      const state = await this.fetchState();
      this.isConnected = true;
      this.setState(state);
    } catch (error) {
      console.warn('[KrakenHttpAdapter] State polling failed.', error);
      this.isConnected = false;
    }
  }

  private async fetchState(): Promise<MachineState> {
    const response = await fetch(`${this.baseUrl}/state`, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  private setState(state: MachineState) {
    this.currentState = {
      ...initialState,
      ...state,
      completedStepIds: state.completedStepIds ?? [],
      skippedStepIds: state.skippedStepIds ?? [],
    };
    this.fireStateChange();
  }

  private fireStateChange() {
    if (this.stateChangeCallback) {
      this.stateChangeCallback({ ...this.currentState });
    }
  }
}
