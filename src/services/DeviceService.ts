/**
 * DeviceService — punto único de creación de adapters.
 *
 * En v2 coexisten dos adapters:
 *  - `penpitoAdapter` (PenpitoAppMqttAdapter): la app móvil ya NO publica
 *    comandos de hardware. Solo somete pedidos al Order Controller.
 *  - `legacyAdapter` (KrakenMqttAdapter): compatibilidad v1 para componentes
 *    que aún no migraron (WaiterScreen, AdminScreen, etc.).
 *
 * Las pantallas nuevas deben usar `penpitoAdapter` + `useOrderStoreV2`.
 * La API legacy (connect/disconnect/sendCommand/publish/subscribeCustom) se
 * mantiene intacta para no romper el código existente durante la migración.
 */

import { ICommunicationAdapter, ConnectionSnapshot } from '../adapters/ICommunicationAdapter';
import { KrakenMqttAdapter } from '../adapters/KrakenMqttAdapter';
import { PenpitoAppMqttAdapter } from '../adapters/PenpitoAppMqttAdapter';
import { DeviceCommand, MachineState } from '../models';

class DeviceService {
  public readonly penpitoAdapter: PenpitoAppMqttAdapter;
  public readonly legacyAdapter: KrakenMqttAdapter;

  constructor() {
    this.penpitoAdapter = new PenpitoAppMqttAdapter();
    this.legacyAdapter = new KrakenMqttAdapter();
  }

  // === API legacy (delegada al adapter v1) ===

  async connect(): Promise<boolean> {
    const ok = await this.legacyAdapter.connect();
    await this.penpitoAdapter.connect();
    return ok;
  }

  async disconnect(): Promise<void> {
    await this.legacyAdapter.disconnect();
    await this.penpitoAdapter.disconnect();
  }

  async sendCommand(command: DeviceCommand): Promise<boolean> {
    return this.legacyAdapter.sendCommand(command);
  }

  onStateChange(callback: (state: MachineState) => void): () => void {
    return this.legacyAdapter.onStateChange(callback);
  }

  onConnectionChange(callback: (snapshot: ConnectionSnapshot) => void): () => void {
    return this.legacyAdapter.onConnectionChange(callback);
  }

  publish(topic: string, payload: string): void {
    this.legacyAdapter.publish(topic, payload);
  }

  subscribeCustom(topic: string, callback: (payload: string) => void): (() => void) | undefined {
    return this.legacyAdapter.subscribeCustom(topic, callback);
  }
}

export const deviceService = new DeviceService();
