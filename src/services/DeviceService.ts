import { ICommunicationAdapter } from '../adapters/ICommunicationAdapter';
import { KrakenMqttAdapter } from '../adapters/KrakenMqttAdapter';
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

  onStateChange(callback: (state: MachineState) => void): () => void {
    return this.adapter.onStateChange(callback);
  }

  onConnectionChange(callback: (snapshot: import('../adapters/ICommunicationAdapter').ConnectionSnapshot) => void): () => void {
    if (this.adapter.onConnectionChange) {
      return this.adapter.onConnectionChange(callback);
    }
    return () => {};
  }

  publish(topic: string, payload: string): void {
    if (this.adapter.publish) {
      this.adapter.publish(topic, payload);
    }
  }

  subscribeCustom(topic: string, callback: (payload: string) => void): (() => void) | undefined {
    if (this.adapter.subscribeCustom) {
      return this.adapter.subscribeCustom(topic, callback);
    }
    return undefined;
  }
}

export const deviceService = new DeviceService(new KrakenMqttAdapter());
