import { ICommunicationAdapter } from '../adapters/ICommunicationAdapter';
import { MockAdapter } from '../adapters/MockAdapter';
import { DeviceCommand, MachineState } from '../models';

export class DeviceService {
  private adapter: ICommunicationAdapter;

  constructor(adapter: ICommunicationAdapter) {
    this.adapter = adapter;
  }

  async connect(): Promise<boolean> {
    return await this.adapter.connect();
  }

  async disconnect(): Promise<void> {
    return await this.adapter.disconnect();
  }

  async sendCommand(command: DeviceCommand): Promise<boolean> {
    return await this.adapter.sendCommand(command);
  }

  onStateChange(callback: (state: MachineState) => void): void {
    this.adapter.onStateChange(callback);
  }
}

// Singleton instance using MockAdapter for development
export const deviceService = new DeviceService(new MockAdapter());
