import { MachineState, DeviceCommand } from '../models';

export interface ICommunicationAdapter {
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  sendCommand(command: DeviceCommand): Promise<boolean>;
  onStateChange(callback: (state: MachineState) => void): void;
}
