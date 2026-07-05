import { MachineState, DeviceCommand } from '../models';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface ConnectionSnapshot {
  broker: ConnectionStatus;
  deviceOnline: boolean;
  lastDeviceMessageAt: number | null;
  error: string | null;
}

export interface ICommunicationAdapter {
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  sendCommand(command: DeviceCommand): Promise<boolean>;
  onStateChange(callback: (state: MachineState) => void): () => void;
  onConnectionChange?(callback: (snapshot: ConnectionSnapshot) => void): () => void;
  publish?(topic: string, payload: string): void;
  subscribeCustom?(topic: string, callback: (payload: string) => void): (() => void);
}
