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

  onStateChange(callback: (state: MachineState) => void): void {
    this.adapter.onStateChange(callback);
  }

  publish(topic: string, payload: string): void {
    if ('publish' in this.adapter) {
      (this.adapter as any).publish(topic, payload);
    }
  }

  subscribeCustom(topic: string, callback: (payload: string) => void): (() => void) | undefined {
    if ('subscribeCustom' in this.adapter) {
      return (this.adapter as any).subscribeCustom(topic, callback);
    }
    return undefined;
  }
}

export const deviceService = new DeviceService(new KrakenMqttAdapter());
