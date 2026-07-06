/**
 * Tópicos MQTT del protocolo v2.
 *
 * Reglas de routing:
 *  - La app móvil publica solo `mobile/...` (eventos, snapshots, requests).
 *  - El Order Controller es el único que publica `controller/...` y `hardware/...`.
 *  - El firmware ESP32 solo escucha `controller/...` y publica `hardware/...`.
 *  - El simulador se comporta como el firmware: escucha `controller/...` y publica `hardware/...`.
 *
 * Ningún dispositivo cliente móvil publica comandos de hardware.
 */

export const TOPICS = {
  /** Móvil → Controller. Un cliente somete un pedido nuevo. */
  MOBILE_ORDER_SUBMIT: (tableId: number) => `penpito/v2/mobile/table/${tableId}/order/submit`,

  /** Móvil → Controller. Pedido cancelado antes de iniciar (queued o fallido por stock). */
  MOBILE_ORDER_CANCEL: (tableId: number) => `penpito/v2/mobile/table/${tableId}/order/cancel`,

  /** Móvil → Controller. Mesero confirma la entrega de un trago. */
  MOBILE_ORDER_SERVED: (tableId: number) => `penpito/v2/mobile/table/${tableId}/order/served`,

  /** Móvil → Controller. Pedido de sincronización: el cliente quiere el snapshot actual. */
  MOBILE_QUEUE_REQUEST: (tableId: number) => `penpito/v2/mobile/table/${tableId}/queue/request`,

  /** Móvil → Controller. Pedido de inspección del estado autoritativo del hardware. */
  MOBILE_HARDWARE_REQUEST: () => `penpito/v2/mobile/hardware/request`,

  /** Móvil → Controller. Comandos administrativos (POWER, CLEAN, SET_CALIB, EMERGENCY_STOP, CONFIG_WIFI, TEST_HW).
   * El controller los recibe y los reenvía al ESP32 con su commandId correlacionado. */
  MOBILE_ADMIN_COMMAND: () => `penpito/v2/mobile/admin/command`,

  /** Controller → Móvil. ACK/resultado de un comando administrativo. */
  CONTROLLER_ADMIN_RESULT: () => `penpito/v2/controller/admin/result`,

  /** Controller → Móvil. Snapshot de la cola para una mesa. Retained por 60s, no persistente. */
  CONTROLLER_QUEUE_STATE: (tableId: number) => `penpito/v2/controller/table/${tableId}/queue`,

  /** Controller → Móvil. Evento por pedido (aceptado, fallido, etc.). No retained. */
  CONTROLLER_ORDER_EVENT: (tableId: number) => `penpito/v2/controller/table/${tableId}/event`,

  /** Controller → Móvil. Snapshot global del hardware autoritativo. Retained. */
  CONTROLLER_HARDWARE_STATE: () => `penpito/v2/controller/hardware/state`,

  /** Controller → Firmware/Simulador. Comando correlacionado por commandId. QoS 1. */
  CONTROLLER_HARDWARE_COMMAND: () => `penpito/v2/controller/hardware/command`,

  /** Firmware/Simulador → Controller. ACK del comando. QoS 1. */
  HARDWARE_COMMAND_ACK: () => `penpito/v2/hardware/command/ack`,

  /** Firmware/Simulador → Controller. Estado del hardware, retenido, autoritativo. */
  HARDWARE_STATE: () => `penpito/v2/hardware/state`,

  /** Firmware/Simulador → Controller. Evento de preparación correlacionado por orderId. */
  HARDWARE_EVENT: () => `penpito/v2/hardware/event`,

  /** Firmware/Simulador → Controller. Presencia (LWT) retained. */
  HARDWARE_PRESENCE: () => `penpito/v2/hardware/presence`,

  /** Shared health endpoint (opcional, para diagnóstico). */
  DIAGNOSTICS_PING: () => `penpito/v2/diagnostics/ping`,
} as const;

export const SUBSCRIBE_PATTERNS = {
  /** Patrón que el Controller escucha para los pedidos entrantes. */
  ALL_MOBILE_ORDERS: 'penpito/v2/mobile/table/+/order/submit',
  ALL_MOBILE_CANCELS: 'penpito/v2/mobile/table/+/order/cancel',
  ALL_MOBILE_SERVED: 'penpito/v2/mobile/table/+/order/served',
  ALL_QUEUE_REQUESTS: 'penpito/v2/mobile/table/+/queue/request',
  ALL_HARDWARE_REQUESTS: 'penpito/v2/mobile/hardware/request',
  ALL_ADMIN_COMMANDS: 'penpito/v2/mobile/admin/command',
  ALL_ADMIN_RESULTS: 'penpito/v2/controller/admin/result',
  HARDWARE_ACK: 'penpito/v2/hardware/command/ack',
  HARDWARE_STATE: 'penpito/v2/hardware/state',
  HARDWARE_EVENT: 'penpito/v2/hardware/event',
  HARDWARE_PRESENCE: 'penpito/v2/hardware/presence',
} as const;

export const SHARED = {
  PROTOCOL_VERSION: 2,
  QOS_COMMANDS: 1 as const,
  QOS_STATE: 1 as const,
  QOS_EVENTS: 1 as const,
  QOS_PRESENCE: 1 as const,
  RETAIN_STATE: true,
  RETAIN_PRESENCE: true,
  RETAIN_QUEUE_SNAPSHOT: true,
  QUEUE_SNAPSHOT_TTL_SECONDS: 60,
} as const;
