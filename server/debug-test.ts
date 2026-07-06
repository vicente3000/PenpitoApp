import { OrderControllerCore } from './src/OrderControllerCore';
import { createInMemoryPersistence } from './src/persistence';
import { makeOrderEnvelope, PROTOCOL_VERSION, HardwareState } from '../src/protocol/types';

const bus = {
  events: [] as any[], snapshots: [] as any[], hardwareAuthoritative: [] as HardwareState[],
  hardwareCommands: [] as any[], logEntries: [] as any[],
  publishOrderEvent(e: any) { this.events.push(e); },
  publishQueueSnapshot(_t: number, _e: any, _a: any, _n: number) {},
  publishHardwareAuthoritativeState(s: HardwareState) { this.hardwareAuthoritative.push(s); },
  publishHardwareCommand(c: any) { this.hardwareCommands.push(c); },
  log(_m: string, _meta?: any) {},
};

const persistence = createInMemoryPersistence();
const core = new OrderControllerCore(persistence, bus as any);
core.updateHardwareState({
  protocolVersion: PROTOCOL_VERSION,
  bootId: 'b', isOn: true, status: 'idle', activeOrderId: null, activeTableId: null,
  activeCommandId: null, stateSequence: 1, activeStepId: null, completedStepIds: [],
  skippedStepIds: [], isDrinkReady: false, errorMessage: null, startedAt: null, uptimeMs: 0,
});

for (let i = 0; i < 3; i++) {
  const env = makeOrderEnvelope({
    orderId: `ord_${i}`, tableId: 1, commandId: `cmd_${i}`, recipeId: 'piscola',
    options: { iceCount: 2 }, requestedAt: 1000 + i,
  });
  core.submitOrder(env);
  console.log(`After submit ${i}: claimedOrderId=`, (core as any).state.claimedOrderId, 'commands=', bus.hardwareCommands.length);
}
