import * as fs from 'fs';
import * as path from 'path';

import {
  TOPICS,
  SUBSCRIBE_PATTERNS,
  SHARED,
  PROTOCOL_VERSION,
} from '../../../src/protocol';

const v2Topics = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'protocol', 'v2-topics.json'), 'utf8')
);

describe('Sim ↔ Firmware fixture: protocol/v2-topics.json', () => {
  it('el JSON espejo contiene los mismos topics que el código TypeScript', () => {
    expect(v2Topics.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(v2Topics.topics.controllerHardwareCommand).toBe(TOPICS.CONTROLLER_HARDWARE_COMMAND());
    expect(v2Topics.topics.hardwareCommandAck).toBe(TOPICS.HARDWARE_COMMAND_ACK());
    expect(v2Topics.topics.hardwareState).toBe(TOPICS.HARDWARE_STATE());
    expect(v2Topics.topics.hardwareEvent).toBe(TOPICS.HARDWARE_EVENT());
    expect(v2Topics.topics.hardwarePresence).toBe(TOPICS.HARDWARE_PRESENCE());
    expect(v2Topics.topics.mobileOrderSubmit).toBe('penpito/v2/mobile/table/{tableId}/order/submit');
    expect(v2Topics.topics.controllerQueueState).toBe('penpito/v2/controller/table/{tableId}/queue');
    expect(v2Topics.topics.controllerHardwareState).toBe(TOPICS.CONTROLLER_HARDWARE_STATE());
    expect(v2Topics.topics.diagnosticsPing).toBe(TOPICS.DIAGNOSTICS_PING());
  });

  it('los wildcards del JSON coinciden con el código TS', () => {
    expect(v2Topics.subscribePatterns.allMobileOrders).toBe(SUBSCRIBE_PATTERNS.ALL_MOBILE_ORDERS);
    expect(v2Topics.subscribePatterns.hardwareAck).toBe(SUBSCRIBE_PATTERNS.HARDWARE_ACK);
    expect(v2Topics.subscribePatterns.hardwareState).toBe(SUBSCRIBE_PATTERNS.HARDWARE_STATE);
    expect(v2Topics.subscribePatterns.hardwareEvent).toBe(SUBSCRIBE_PATTERNS.HARDWARE_EVENT);
    expect(v2Topics.subscribePatterns.hardwarePresence).toBe(SUBSCRIBE_PATTERNS.HARDWARE_PRESENCE);
  });

  it('QoS y retain consistentes con SHARED', () => {
    expect(v2Topics.qos.commands).toBe(SHARED.QOS_COMMANDS);
    expect(v2Topics.qos.state).toBe(SHARED.QOS_STATE);
    expect(v2Topics.qos.events).toBe(SHARED.QOS_EVENTS);
    expect(v2Topics.qos.presence).toBe(SHARED.QOS_PRESENCE);
    expect(v2Topics.retain.state).toBe(SHARED.RETAIN_STATE);
    expect(v2Topics.retain.presence).toBe(SHARED.RETAIN_PRESENCE);
  });

  it('el simulador y el firmware usan los mismos topics exactos', () => {
    // El simulador v2 está en dev/esp_simulator_v2.js y lee protocol/v2-topics.json.
    // El firmware está en Kraken/src/main.cpp. Ambos usan los strings literales
    // del JSON. Este test verifica que el código TS también los produce.
    const tableId = 5;
    expect(v2Topics.topics.controllerHardwareCommand).toBe('penpito/v2/controller/hardware/command');
    expect(TOPICS.MOBILE_ORDER_SUBMIT(tableId)).toBe('penpito/v2/mobile/table/5/order/submit');
    expect(TOPICS.CONTROLLER_QUEUE_STATE(tableId)).toBe('penpito/v2/controller/table/5/queue');
    expect(TOPICS.CONTROLLER_ORDER_EVENT(tableId)).toBe('penpito/v2/controller/table/5/event');
  });
});
